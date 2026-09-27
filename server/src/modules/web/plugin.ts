import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildCsp, securityHeaders } from "./csp.js";
import { createRegionHint } from "./region.js";
import { registerWebSessionRoute } from "./session.js";
import { IMMUTABLE_CACHE, loadAssets, pickEncoding, type Asset, type AssetTable } from "./static.js";
import { tileOrigin } from "./tile.js";

const require = createRequire(import.meta.url);

/** server/ — `src/modules/web` when run with tsx, `dist/modules/web` when built: both three levels below. */
function serverRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function readPackageVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The built-in web UI (server/web): pages, files, /web-config.json and the anonymous session endpoint.
 * Everything here exists only when WEB_UI_ENABLED; with it off the node serves the API and nothing else.
 * The auth hook only guards /v1/*, so these routes need no entry in its PUBLIC_PATHS (POST /v1/web/session does).
 */
export async function registerWebModule(app: FastifyInstance): Promise<void> {
  const env = app.deps.env;
  if (!env.WEB_UI_ENABLED) return;

  const root = serverRoot();
  const origin = tileOrigin(env.MAP_TILE_URL);
  const assets: AssetTable = loadAssets({
    publicDir: join(root, "web", "public"),
    leafletDir: join(dirname(require.resolve("leaflet/package.json")), "dist"),
    h3File: join(dirname(require.resolve("h3-js/package.json")), "dist", "browser", "h3-js.es.js"),
    tileOrigin: origin,
  });

  const version = readPackageVersion(root);
  const regionHint = createRegionHint(app.deps.db);

  const send = (req: FastifyRequest, reply: FastifyReply, asset: Asset, cacheControl = asset.cacheControl) => {
    reply.headers(securityHeaders(buildCsp({ tileOrigin: origin, host: req.headers.host })));
    reply.header("cache-control", cacheControl);
    reply.header("etag", asset.etag);
    reply.header("vary", "Accept-Encoding");
    if (req.headers["if-none-match"] === asset.etag) return reply.code(304).send();
    const { body, encoding } = pickEncoding(asset, req.headers["accept-encoding"]);
    if (encoding) reply.header("content-encoding", encoding);
    return reply.type(asset.contentType).send(body);
  };

  for (const [route, asset] of assets.pages) {
    app.get(route, async (req, reply) => send(req, reply, asset));
  }

  app.get("/web/*", async (req, reply) => {
    const key = `/web/${(req.params as { "*": string })["*"]}`;
    const asset = assets.files.get(key);
    if (!asset) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
    // Requests carrying the current build id come from this release's own pages: their URL changes with every release, so
    // the browser may keep them for good. Anything else (bookmarks, old links, CSS-relative images) is revalidated as before.
    const versioned = (req.query as { v?: string }).v === assets.buildId;
    return send(req, reply, asset, versioned ? IMMUTABLE_CACHE : asset.cacheControl);
  });

  app.get("/web-config.json", async (req, reply) => {
    reply.headers(securityHeaders(buildCsp({ tileOrigin: origin, host: req.headers.host })));
    reply.header("cache-control", "no-cache");
    const bounds = await regionHint();
    return {
      version,
      license: "Apache-2.0",
      repoUrl: env.PROJECT_REPO_URL,
      tiles: env.MAP_TILE_URL === ""
        ? null
        : { url: env.MAP_TILE_URL, attributionText: env.MAP_TILE_ATTRIBUTION_TEXT, attributionUrl: env.MAP_TILE_ATTRIBUTION_URL, maxZoom: env.MAP_TILE_MAX_ZOOM },
      region: bounds ? { bounds } : null,
      privacyLogging: env.LOG_PRIVACY_MODE,
      sessionTtlSeconds: env.WEB_SESSION_TTL_SECONDS,
      limits: { maxSegmentRadiusM: env.WEB_MAX_SEGMENT_RADIUS_M, maxHazardRadiusM: env.WEB_MAX_HAZARD_RADIUS_M },
    };
  });

  await registerWebSessionRoute(app);
}
