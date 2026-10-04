import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isValidCell } from "h3-js";
import { findStaticSignsNearby } from "../../db/queries/static-signs.js";
import { parseLatLng, parseRadiusM } from "../../lib/query-params.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { getPackageService, type StaticPackageService } from "./package-service.js";
import type { PackageEncoding } from "./package-store.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TILE_PATTERN = /^[0-9a-f]{15}$/;

function validTile(tile: string): boolean {
  return TILE_PATTERN.test(tile) && isValidCell(tile);
}

/** The best representation the client accepts: brotli, then gzip, else the plain JSON (gunzipped on the fly). */
export function negotiateEncoding(header: string | undefined): PackageEncoding {
  const accepted = new Map<string, number>();
  for (const part of (header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    accepted.set(name, q ? Number(q.slice(2)) : 1);
  }
  const ok = (name: string) => (accepted.get(name) ?? accepted.get("*") ?? 0) > 0;
  if (ok("br")) return "br";
  if (ok("gzip")) return "gzip";
  return "identity";
}

export type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/** A single `bytes=a-b` / `a-` / `-n` range; anything more exotic is ignored (the full body is a valid answer). */
export function parseRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from, to] = match;
  if (from === "" && to === "") return null;
  let start: number;
  let end: number;
  if (from === "") {
    const suffix = Number(to);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim().replace(/^W\//, "");
    return value === "*" || value === etag;
  });
}

async function sendMissing(service: StaticPackageService, tile: string, reply: FastifyReply) {
  await service.markMissing(tile);
  reply.header("retry-after", "30");
  return reply.status(503).send({
    error: { code: "PACKAGE_MISSING", message: "The package file is not on disk (yet); it has been queued for rebuild — retry shortly" },
  });
}

function sendPolicyStale(reply: FastifyReply) {
  reply.header("retry-after", "30");
  return reply.status(503).send({
    error: { code: "PACKAGES_BUILDING", message: "This package is being rebuilt after a change of the camera policy; retry shortly" },
  });
}

async function sendPackage(
  service: StaticPackageService,
  req: FastifyRequest,
  reply: FastifyReply,
  tile: string,
  hash: string,
  cacheControl: string,
) {
  const encoding = negotiateEncoding(req.headers["accept-encoding"]);
  // A strong validator per representation (RFC 9110): the same content stored as gzip and as
  // brotli are different byte sequences, so a Range request must not mix them up.
  const etag = `"${hash}${encoding === "identity" ? "" : `-${encoding}`}"`;
  reply.header("etag", etag).header("cache-control", cacheControl).header("vary", "Accept-Encoding");

  if (etagMatches(req.headers["if-none-match"] as string | undefined, etag)) {
    return reply.status(304).send();
  }

  const stored = encoding === "br" ? "br" : "gzip";
  let range: ByteRange = null;
  let total: number | null = null;
  if (encoding !== "identity") {
    total = await service.store.size(tile, hash, stored);
    if (total === null) return sendMissing(service, tile, reply);
    const ifRange = req.headers["if-range"] as string | undefined;
    range = !ifRange || ifRange === etag ? parseRange(req.headers.range, total) : null;
    if (range === "unsatisfiable") return reply.status(416).header("content-range", `bytes */${total}`).send();
    reply.header("accept-ranges", "bytes");
  }

  const opened = await service.store.open(tile, hash, encoding, range ?? undefined);
  if (!opened) return sendMissing(service, tile, reply);

  reply.header("content-type", "application/json; charset=utf-8");
  if (encoding !== "identity") reply.header("content-encoding", stored);
  if (opened.contentLength !== null) reply.header("content-length", opened.contentLength);
  if (range) reply.status(206).header("content-range", `bytes ${range.start}-${range.end}/${total}`);
  return reply.send(opened.stream);
}

export async function registerStaticDataRoutes(app: FastifyInstance) {
  const service = () => getPackageService(app.deps.db, app.deps.env, app.log, () => app.cameraPolicy.current());

  app.get("/v1/static-signs/nearby", async (req) => {
    const query = req.query as Record<string, unknown>;
    const { lat, lng } = parseLatLng(query);
    const radiusM = parseRadiusM(query.radiusM);
    const signs = await findStaticSignsNearby(app.deps.db, lat, lng, radiusM);
    return { signs };
  });

  // Partitioned static-data delivery (client-lib P2.0) — see
  // docs/prompt-phase2-client-lib.md section 4 / docs/api.md "Static data
  // packages". Complements, doesn't replace, /v1/snapshot.
  app.get("/v1/static-data/manifest", async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    let since: number | undefined;
    if (query.since !== undefined) {
      since = Number(query.since);
      if (!Number.isInteger(since) || since < 0) throw badRequest("since must be a non-negative integer");
    }
    const result = await service().manifest(since);
    if (result.status === "building") {
      reply.header("retry-after", "30").status(503);
      return { error: { code: "PACKAGES_BUILDING", message: `Static-data packages are not ready: ${result.reason}. Retry shortly.` } };
    }
    const { manifest } = result;
    reply.header("etag", manifest.etag).header("cache-control", "private, no-cache").header("vary", "Accept-Encoding");
    if (etagMatches(req.headers["if-none-match"] as string | undefined, manifest.etag)) return reply.status(304).send();
    reply.header("content-type", "application/json; charset=utf-8");
    if (negotiateEncoding(req.headers["accept-encoding"]) !== "identity") {
      return reply.header("content-encoding", "gzip").send(manifest.gzip);
    }
    return reply.send(manifest.json);
  });

  // Same content as before (a partition by tile), now streamed from the pre-built file:
  // ETag + revalidation instead of a cache the server keeps in memory.
  app.get("/v1/static-data/partitions/:tile", async (req, reply) => {
    const { tile } = req.params as { tile: string };
    if (!validTile(tile)) throw notFound(`No static-data partition for tile ${tile}`);
    const svc = service();
    const fresh = await svc.ensureFresh();
    if (!fresh.ready) {
      reply.header("retry-after", "30");
      return reply.status(503).send({ error: { code: "PACKAGES_BUILDING", message: `Static-data packages are not ready: ${fresh.reason}. Retry shortly.` } });
    }
    const row = await svc.current(tile);
    if (!row) throw notFound(`No static-data partition for tile ${tile}`);
    if (await svc.isPolicyStale(tile)) return sendPolicyStale(reply);
    return sendPackage(svc, req, reply, tile, row.hash!, "private, no-cache");
  });

  // Content-addressed: the URL names the exact bytes, so it can be cached forever (and, with
  // STATIC_PACKAGES_PUBLIC, by a reverse proxy or CDN without a client credential).
  app.get("/v1/static-data/packages/:tile/:hash", async (req, reply) => {
    const { tile, hash } = req.params as { tile: string; hash: string };
    if (!validTile(tile) || !HASH_PATTERN.test(hash)) throw notFound("No such static-data package");
    const svc = service();
    // Checked before anything else: a withdrawn camera must not be reachable through the old, content-addressed URL either.
    if (await svc.isPolicyStale(tile)) return sendPolicyStale(reply);
    if (!(await svc.store.has(tile, hash))) throw notFound("No such static-data package (it may have been replaced — fetch the manifest again)");
    const visibility = app.deps.env.STATIC_PACKAGES_PUBLIC ? "public" : "private";
    return sendPackage(svc, req, reply, tile, hash, `${visibility}, max-age=31536000, immutable`);
  });
}
