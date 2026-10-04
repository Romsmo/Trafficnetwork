import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { latLngToCell } from "h3-js";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { createPolicyFixture, loadBoundaries, WORLD_AS_DE } from "./camera-policy-helper.js";
import { authHeader, testToken } from "./auth-helper.js";
import { findAllSpeedLimitSegments } from "../../src/db/queries/speed-limit-segments.js";
import { findAllStaticSigns } from "../../src/db/queries/static-signs.js";
import { buildPartitions, serializePartition } from "../../src/modules/static-data/partitions.js";
import { getPackageService } from "../../src/modules/static-data/package-service.js";
import { runBuild } from "../../src/modules/static-data/package-builder.js";

/**
 * Europe-scale storage and delivery (add-on E-B, docs/europe-scale.md): disk-backed,
 * incrementally rebuilt, cacheable static packages; batched bulk import that never
 * floods the event log; the snapshot guard. Server behaviour only — the measured
 * numbers live in docs/operating.md (`npm run measure-scale`).
 */

const RES = 4;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("europe-scale static packages", () => {
  let testDb: TestDatabase;
  const dirs: string[] = [];
  const apps: FastifyInstance[] = [];

  const newDir = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "static-packages-"));
    dirs.push(dir);
    return dir;
  };
  // The package files belong to the data in the database: every app started for the same data uses
  // the same directory, and a fresh data set (truncateStatic) starts a fresh one.
  let activeDir = "";

  async function startApp(overrides: Record<string, string> = {}): Promise<{ app: FastifyInstance; env: Env; dir: string }> {
    const dir = overrides["STATIC_PACKAGES_DIR"] ?? (activeDir ||= newDir());
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      LOG_LEVEL: "silent",
      STATIC_DATA_PARTITION_H3_RESOLUTION: String(RES),
      STATIC_PACKAGES_DIR: dir,
      // A small page so even these tiny tiles are streamed through several cursor fetches.
      STATIC_PACKAGES_PAGE_ROWS: "7",
      STATIC_PACKAGES_GZIP_LEVEL: "4",
      STATIC_PACKAGES_BROTLI_QUALITY: "3",
      ...overrides,
    });
    const app = await buildApp({ env, db: testDb.db });
    apps.push(app);
    return { app, env, dir };
  }

  const policy = createPolicyFixture();

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await loadBoundaries(testDb.db, WORLD_AS_DE);
    policy.write({ DE: "full" });
  }, 90_000);

  afterAll(async () => {
    for (const app of apps) await app.close();
    policy.cleanup();
    await testDb.teardown();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ helpers

  const token = (env: Env, scopes: ("client" | "bulk-import")[] = ["client"]) => testToken(env, { scopes });

  /** A short segment near (lat, lng), `nSegments` of them side by side. */
  function segments(lat: number, lng: number, n: number, speedLimit = 50) {
    return Array.from({ length: n }, (_, i) => ({
      lineString: [[lng + i * 0.0005, lat], [lng + i * 0.0005 + 0.0003, lat + 0.0002], [lng + i * 0.0005 + 0.0006, lat + 0.0001]] as [number, number][],
      speedLimit,
      speedLimitUnit: "kmh" as const,
      source: "osm-test",
      sourceLicense: "ODbL",
    }));
  }

  async function importSegments(app: FastifyInstance, env: Env, rows: ReturnType<typeof segments>) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/bulk-import/speed-limit-segments",
      headers: authHeader(await token(env, ["bulk-import"])),
      payload: { rows },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().inserted as number;
  }

  async function importSigns(app: FastifyInstance, env: Env, points: { lat: number; lng: number }[]) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/bulk-import/static-signs",
      headers: authHeader(await token(env, ["bulk-import"])),
      payload: { rows: points.map((p) => ({ ...p, signType: "DE:274", source: "osm-test" })) },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function truncateStatic() {
    activeDir = newDir();
    await testDb.db.execute(sql`
      truncate table speed_limit_segments, static_signs, fixed_speed_cameras, event_log, static_packages restart identity cascade
    `);
    await testDb.db.execute(sql`update static_package_state set ready = false, fingerprint = null, built_version = 0, lease_owner = null, lease_until = null`);
    await testDb.db.execute(sql`update static_data_state set version = 1`);
  }

  async function manifest(app: FastifyInstance, env: Env, query = "", headers: Record<string, string> = {}) {
    return app.inject({ method: "GET", url: `/v1/static-data/manifest${query}`, headers: { ...authHeader(await token(env)), ...headers } });
  }

  async function partition(app: FastifyInstance, env: Env, tile: string, headers: Record<string, string> = {}) {
    return app.inject({ method: "GET", url: `/v1/static-data/partitions/${tile}`, headers: { ...authHeader(await token(env)), ...headers } });
  }

  const BERLIN = { lat: 52.52, lng: 13.405 };
  const MUNICH = { lat: 48.137, lng: 11.575 };
  const HAMBURG = { lat: 53.55, lng: 9.99 };
  const tileOf = (p: { lat: number; lng: number }) => latLngToCell(p.lat, p.lng, RES);

  // ------------------------------------------------------------------ equivalence

  it("produces byte-for-byte what the old in-memory builder produced (same hash, same JSON) — paged through a 7-row cursor", async () => {
    await truncateStatic();
    const { app, env } = await startApp();
    await importSegments(app, env, segments(BERLIN.lat, BERLIN.lng, 23));
    await importSegments(app, env, segments(MUNICH.lat, MUNICH.lng, 11, 30));
    await importSigns(app, env, [BERLIN, { lat: BERLIN.lat + 0.001, lng: BERLIN.lng }, MUNICH, HAMBURG]);

    const res = await manifest(app, env);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Json;

    // The reference: the previous implementation's grouping + serialisation, fed the same rows in id order.
    const sortById = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    const expected = buildPartitions(
      {
        speedLimitSegments: sortById(await findAllSpeedLimitSegments(testDb.db, true)),
        staticSigns: sortById(await findAllStaticSigns(testDb.db)),
        fixedSpeedCameras: [],
      },
      RES,
    );
    expect(body.partitions.map((p: Json) => p.tile).sort()).toEqual([...expected.keys()].sort());
    for (const p of body.partitions as Json[]) {
      const reference = serializePartition(expected.get(p.tile)!);
      expect(p.hash, `hash of ${p.tile}`).toBe(reference.hash);
      expect(p.sizeBytes).toBe(reference.sizeBytes);
      const served = await partition(app, env, p.tile);
      expect(served.statusCode).toBe(200);
      expect(served.body).toBe(reference.json);
    }
  });

  it("is deterministic: rebuilding unchanged data yields the very same hashes", async () => {
    const { app, env } = await startApp();
    const before = (await manifest(app, env)).json().partitions as Json[];
    await getPackageService(testDb.db, env).markMissing(tileOf(BERLIN));
    const after = (await manifest(app, env)).json().partitions as Json[];
    expect(after.map((p) => p.hash)).toEqual(before.map((p) => p.hash));
  });

  // ------------------------------------------------------------------ manifest

  it("keeps the manifest's existing shape and adds sizes and an immutable path; the version matches the database", async () => {
    const { app, env } = await startApp();
    const res = await manifest(app, env);
    const body = res.json() as Json;
    const [{ version }] = (await testDb.db.execute(sql`select version from static_data_state where id = 1`)) as unknown as [{ version: number }];
    expect(body.staticDataVersion).toBe(version);
    expect(new Date(body.generatedAt).toString()).not.toBe("Invalid Date");
    // The resolution is in the manifest, so a client can tell a deviation from data.
    expect(body.partitionResolution).toBe(RES);
    expect(body.partitionResolution).toBe(env.STATIC_DATA_PARTITION_H3_RESOLUTION);
    const first = body.partitions[0] as Json;
    expect(Object.keys(first).sort()).toEqual(["brotliBytes", "gzipBytes", "hash", "path", "sizeBytes", "tile"]);
    expect(first.path).toBe(`/v1/static-data/packages/${first.tile}/${first.hash}`);
    expect(first.gzipBytes).toBeGreaterThan(0);
    expect(first.gzipBytes).toBeLessThan(first.sizeBytes);
  });

  it("supports revalidation (ETag / 304) and gzip for the manifest", async () => {
    const { app, env } = await startApp();
    const first = await manifest(app, env);
    const etag = first.headers["etag"] as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await manifest(app, env, "", { "if-none-match": etag })).statusCode).toBe(304);
    expect((await manifest(app, env, "", { "if-none-match": '"something-else"' })).statusCode).toBe(200);

    const gz = await manifest(app, env, "", { "accept-encoding": "gzip" });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(gz.rawPayload).toString())).toEqual(first.json());
  });

  it("answers ?since= with only the tiles that changed, and lists tiles that went away", async () => {
    await truncateStatic();
    const { app, env } = await startApp();
    await importSigns(app, env, [BERLIN, MUNICH]);
    const initial = (await manifest(app, env)).json() as Json;
    expect(initial.partitions).toHaveLength(2);

    await importSigns(app, env, [{ lat: HAMBURG.lat, lng: HAMBURG.lng }]);
    const delta = (await manifest(app, env, `?since=${initial.staticDataVersion}`)).json() as Json;
    expect(delta.since).toBe(initial.staticDataVersion);
    expect(delta.partitions.map((p: Json) => p.tile)).toEqual([tileOf(HAMBURG)]);
    expect(delta.removed).toEqual([]);

    // The Munich tile empties out (by hand, as an operator might) and is marked for a rebuild.
    await testDb.db.execute(sql`delete from static_signs where ST_Y(position) between 48 and 48.3`);
    await getPackageService(testDb.db, env).markMissing(tileOf(MUNICH));
    const afterDelete = (await manifest(app, env, `?since=${initial.staticDataVersion}`)).json() as Json;
    expect(afterDelete.removed).toEqual([tileOf(MUNICH)]);
    const full = (await manifest(app, env)).json() as Json;
    expect(full.partitions.map((p: Json) => p.tile)).not.toContain(tileOf(MUNICH));
    expect((await partition(app, env, tileOf(MUNICH))).statusCode).toBe(404);

    expect((await manifest(app, env, "?since=abc")).statusCode).toBe(400);
  });

  // ------------------------------------------------------------------ delivery

  it("streams a partition as brotli, gzip or plain JSON — all the same bytes once decoded — with an ETag per representation", async () => {
    await truncateStatic();
    const { app, env } = await startApp();
    await importSegments(app, env, segments(BERLIN.lat, BERLIN.lng, 15));
    const tile = tileOf(BERLIN);
    const identity = await partition(app, env, tile, { "accept-encoding": "identity" });
    const gz = await partition(app, env, tile, { "accept-encoding": "gzip" });
    const br = await partition(app, env, tile, { "accept-encoding": "gzip, br;q=0.9" });
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(br.headers["content-encoding"]).toBe("br");
    expect(gunzipSync(gz.rawPayload).toString()).toBe(identity.body);
    expect(brotliDecompressSync(br.rawPayload).toString()).toBe(identity.body);
    const hash = createHash("sha256").update(identity.body).digest("hex");
    expect(identity.headers["etag"]).toBe(`"${hash}"`);
    expect(gz.headers["etag"]).toBe(`"${hash}-gzip"`);
    expect(br.headers["etag"]).toBe(`"${hash}-br"`);
    expect(identity.headers["vary"]).toMatch(/accept-encoding/i);
    expect(identity.headers["cache-control"]).toBe("private, no-cache");
    expect((await partition(app, env, tile, { "accept-encoding": "br", "if-none-match": `"${hash}-br"` })).statusCode).toBe(304);
    expect((await partition(app, env, tile, { "accept-encoding": "br", "if-none-match": `"${hash}-gzip"` })).statusCode).toBe(200);
  });

  it("serves byte ranges of the stored representation so an interrupted download resumes", async () => {
    const { app, env } = await startApp();
    const tile = tileOf(BERLIN);
    const full = await partition(app, env, tile, { "accept-encoding": "gzip" });
    expect(full.headers["accept-ranges"]).toBe("bytes");
    const total = full.rawPayload.length;
    const part = await partition(app, env, tile, { "accept-encoding": "gzip", range: "bytes=10-59" });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 10-59/${total}`);
    expect(part.rawPayload.equals(full.rawPayload.subarray(10, 60))).toBe(true);
    const tail = await partition(app, env, tile, { "accept-encoding": "gzip", range: `bytes=${total - 20}-` });
    expect(tail.rawPayload.equals(full.rawPayload.subarray(total - 20))).toBe(true);
    const suffix = await partition(app, env, tile, { "accept-encoding": "gzip", range: "bytes=-15" });
    expect(suffix.rawPayload.equals(full.rawPayload.subarray(total - 15))).toBe(true);
    expect((await partition(app, env, tile, { "accept-encoding": "gzip", range: `bytes=${total + 5}-` })).statusCode).toBe(416);
    // A stale validator in If-Range means "give me everything".
    const changed = await partition(app, env, tile, { "accept-encoding": "gzip", range: "bytes=10-59", "if-range": '"not-the-etag"' });
    expect(changed.statusCode).toBe(200);
    // Ranges apply to stored bytes only: a plain-JSON response is produced on the fly and ignores them.
    expect((await partition(app, env, tile, { "accept-encoding": "identity", range: "bytes=0-9" })).statusCode).toBe(200);
  });

  it("offers a content-addressed URL that can be cached for a year, and refuses anything that is not a current or recent package", async () => {
    const { app, env } = await startApp();
    const body = (await manifest(app, env)).json() as Json;
    const p = body.partitions[0] as Json;
    const res = await app.inject({ method: "GET", url: p.path, headers: { ...authHeader(await token(env)), "accept-encoding": "gzip" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(createHash("sha256").update(gunzipSync(res.rawPayload)).digest("hex")).toBe(p.hash);

    for (const url of [`/v1/static-data/packages/${p.tile}/${"0".repeat(64)}`, `/v1/static-data/packages/${p.tile}/nothex`, `/v1/static-data/packages/../etc/${p.hash}`, `/v1/static-data/packages/zzzzzzzzzzzzzzz/${p.hash}`]) {
      const r = await app.inject({ method: "GET", url, headers: authHeader(await token(env)) });
      expect(r.statusCode, url).toBe(404);
    }
  });

  it("needs a credential for packages by default; STATIC_PACKAGES_PUBLIC lets a CDN fetch just the content-addressed URL", async () => {
    const { app, env } = await startApp();
    const p = ((await manifest(app, env)).json() as Json).partitions[0] as Json;
    expect((await app.inject({ method: "GET", url: p.path })).statusCode).toBe(401);

    const open = await startApp({ STATIC_PACKAGES_PUBLIC: "true", STATIC_PACKAGES_DIR: env.STATIC_PACKAGES_DIR });
    const anonymous = await open.app.inject({ method: "GET", url: p.path, headers: { "accept-encoding": "br" } });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    // Everything else — the manifest, the by-tile route — still needs a credential.
    expect((await open.app.inject({ method: "GET", url: "/v1/static-data/manifest" })).statusCode).toBe(401);
    expect((await open.app.inject({ method: "GET", url: `/v1/static-data/partitions/${p.tile}` })).statusCode).toBe(401);
  });

  it("404s a tile that is not an H3 cell instead of touching the file system", async () => {
    const { app, env } = await startApp();
    for (const tile of ["nonexistent-tile", "..", "8408a41ffffffff", "0123456789abcde"]) {
      expect((await partition(app, env, tile)).statusCode, tile).toBe(404);
    }
  });

  // ------------------------------------------------------------------ incremental & bulk import

  it("rebuilds only the tiles a write touched", async () => {
    await truncateStatic();
    const { app, env } = await startApp();
    await importSigns(app, env, [BERLIN, MUNICH]);
    const before = ((await manifest(app, env)).json() as Json).partitions as Json[];
    const builtAt = async (tile: string) =>
      ((await testDb.db.execute(sql`select built_at::text as at from static_packages where tile = ${tile}`)) as unknown as { at: string }[])[0]!.at;
    const munichBuiltAt = await builtAt(tileOf(MUNICH));

    await new Promise((r) => setTimeout(r, 20));
    await importSigns(app, env, [{ lat: BERLIN.lat + 0.002, lng: BERLIN.lng }]);
    const dirty = (await testDb.db.execute(sql`select tile from static_packages where dirty`)) as unknown as { tile: string }[];
    expect(dirty.map((r) => r.tile)).toEqual([tileOf(BERLIN)]);

    const after = ((await manifest(app, env)).json() as Json).partitions as Json[];
    const byTile = (rows: Json[], tile: string) => rows.find((p) => p.tile === tile)!;
    expect(byTile(after, tileOf(BERLIN)).hash).not.toBe(byTile(before, tileOf(BERLIN)).hash);
    expect(byTile(after, tileOf(MUNICH)).hash).toBe(byTile(before, tileOf(MUNICH)).hash);
    expect(await builtAt(tileOf(MUNICH))).toBe(munichBuiltAt); // untouched, not even rewritten
    expect((await partition(app, env, tileOf(BERLIN))).json().staticSigns).toHaveLength(2);
  });

  it("never floods the event log however much is imported, and raises the version on every batch", async () => {
    await truncateStatic();
    const { app, env } = await startApp();
    const events = async () => ((await testDb.db.execute(sql`select count(*)::int as n from event_log`)) as unknown as { n: number }[])[0]!.n;
    const version = async () => ((await testDb.db.execute(sql`select version from static_data_state where id = 1`)) as unknown as { version: number }[])[0]!.version;
    const v0 = await version();
    for (let batch = 0; batch < 4; batch++) await importSegments(app, env, segments(BERLIN.lat + batch * 0.01, BERLIN.lng, 200));
    expect(await events()).toBe(0);
    expect(await version()).toBe(v0 + 4);
    const count = ((await testDb.db.execute(sql`select count(*)::int as n from speed_limit_segments`)) as unknown as { n: number }[])[0]!.n;
    expect(count).toBe(800);
  });

  it("stores exactly what was sent through the batched insert (nulls, units, timestamps, awkward characters)", async () => {
    await truncateStatic();
    const { app, env } = await startApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/bulk-import/speed-limit-segments",
      headers: authHeader(await token(env, ["bulk-import"])),
      payload: {
        rows: [
          { lineString: [[13.4, 52.5], [13.41, 52.51]], speedLimit: 30, speedLimitUnit: "mph", source: 'osm "quoted", {braced} \\ backslash', sourceLicense: "ODbL 1.0", importedAt: "2026-01-02T03:04:05.000Z" },
          { lineString: [[13.5, 52.5], [13.51, 52.51], [13.52, 52.5]], speedLimit: 50, speedLimitUnit: "kmh", source: "plain" },
        ],
      },
    });
    expect(res.json().inserted).toBe(2);
    const rows = (await testDb.db.execute(sql`
      select speed_limit, speed_limit_unit, source, source_license, imported_at at time zone 'UTC' as imported_at, ST_NPoints(geometry) as n
      from speed_limit_segments order by speed_limit
    `)) as unknown as Json[];
    expect(rows[0]).toMatchObject({ speed_limit: 30, speed_limit_unit: "mph", source: 'osm "quoted", {braced} \\ backslash', source_license: "ODbL 1.0", n: 2 });
    expect(new Date(`${rows[0]!.imported_at}Z`).toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(rows[1]).toMatchObject({ speed_limit: 50, speed_limit_unit: "kmh", source_license: null, n: 3 });
  });

  it("honours BULK_IMPORT_MAX_ROWS", async () => {
    const { app, env } = await startApp({ BULK_IMPORT_MAX_ROWS: "3" });
    const ok = await app.inject({ method: "POST", url: "/v1/bulk-import/speed-limit-segments", headers: authHeader(await token(env, ["bulk-import"])), payload: { rows: segments(48, 11, 3) } });
    expect(ok.statusCode).toBe(200);
    const tooMany = await app.inject({ method: "POST", url: "/v1/bulk-import/speed-limit-segments", headers: authHeader(await token(env, ["bulk-import"])), payload: { rows: segments(48, 11, 4) } });
    expect(tooMany.statusCode).toBe(400);
  });

  // ------------------------------------------------------------------ large datasets: worker path

  it("above the inline limit a request never builds: 503 until the worker (or CLI) has built, then it serves — and keeps serving while newer writes wait", async () => {
    await truncateStatic();
    const { app, env } = await startApp({ STATIC_PACKAGES_INLINE_BUILD_MAX_ROWS: "5" });
    await importSegments(app, env, segments(BERLIN.lat, BERLIN.lng, 30));
    await importSigns(app, env, [MUNICH]);

    const building = await manifest(app, env);
    expect(building.statusCode).toBe(503);
    expect(building.headers["retry-after"]).toBe("30");
    expect(building.json().error.code).toBe("PACKAGES_BUILDING");
    expect((await partition(app, env, tileOf(BERLIN))).statusCode).toBe(503);

    const built = await runBuild(getPackageService(testDb.db, env).builderDeps);
    expect(built).toMatchObject({ status: "built", tilesFailed: 0, ready: true });
    const ready = await manifest(app, env);
    expect(ready.statusCode).toBe(200);
    expect(ready.json().partitions).toHaveLength(2);

    // A later write leaves the tile dirty; the (large) server keeps serving the complete set it has.
    await importSigns(app, env, [{ lat: BERLIN.lat, lng: BERLIN.lng }]);
    const stale = await manifest(app, env);
    expect(stale.statusCode).toBe(200);
    const berlin = (stale.json().partitions as Json[]).find((p) => p.tile === tileOf(BERLIN))!;
    expect((await partition(app, env, tileOf(BERLIN))).json().staticSigns).toHaveLength(0); // not yet rebuilt
    expect(berlin.hash).toBeTypeOf("string");

    await runBuild(getPackageService(testDb.db, env).builderDeps);
    expect((await partition(app, env, tileOf(BERLIN))).json().staticSigns).toHaveLength(1);
  });

  it("does not run two builders at once (the lease) and reports it", async () => {
    const { env } = await startApp();
    const deps = getPackageService(testDb.db, env).builderDeps;
    await testDb.db.execute(sql`update static_package_state set lease_owner = 'someone-else', lease_until = now() + interval '5 minutes'`);
    expect((await runBuild(deps)).status).toBe("busy");
    await testDb.db.execute(sql`update static_package_state set lease_until = now() - interval '1 minute'`);
    expect((await runBuild(deps)).status).toBe("built"); // an expired lease is taken over
  });

  it("resumes an interrupted first build instead of starting over", async () => {
    await truncateStatic();
    const { app, env } = await startApp({ STATIC_PACKAGES_INLINE_BUILD_MAX_ROWS: "1" });
    await importSigns(app, env, [BERLIN, MUNICH, HAMBURG]);
    const deps = getPackageService(testDb.db, env).builderDeps;

    const first = await runBuild(deps, { maxTiles: 1 });
    expect(first).toMatchObject({ tilesBuilt: 1, ready: false });
    expect((await manifest(app, env)).statusCode).toBe(503); // incomplete: not served

    const second = await runBuild(deps);
    // Only what was left: no tile is built twice (the bounding-box probe may also list a neighbouring
    // tile or two that turn out to be empty, so the total is not just the three populated ones).
    const known = ((await testDb.db.execute(sql`select count(*)::int as n from static_packages`)) as unknown as { n: number }[])[0]!.n;
    expect(second.tilesBuilt).toBeGreaterThan(0);
    expect(first.tilesBuilt + second.tilesBuilt).toBe(known);
    expect(second.ready).toBe(true);
    expect(((await manifest(app, env)).json() as Json).partitions).toHaveLength(3);
  });

  it("rebuilds everything when a setting that shapes the content changes (the partition resolution)", async () => {
    await truncateStatic();
    const { app, env } = await startApp();
    await importSigns(app, env, [BERLIN]);
    const at4Manifest = (await manifest(app, env)).json() as Json;
    const at4 = at4Manifest.partitions as Json[];
    expect(at4[0]!.tile).toBe(latLngToCell(BERLIN.lat, BERLIN.lng, 4));

    const coarse = await startApp({ STATIC_DATA_PARTITION_H3_RESOLUTION: "3", STATIC_PACKAGES_DIR: env.STATIC_PACKAGES_DIR });
    const coarseManifest = (await manifest(coarse.app, coarse.env)).json() as Json;
    expect(coarseManifest.partitionResolution).toBe(3);
    expect(at4Manifest.partitionResolution).toBe(4);
    const at3 = coarseManifest.partitions as Json[];
    expect(at3).toHaveLength(1);
    expect(at3[0]!.tile).toBe(latLngToCell(BERLIN.lat, BERLIN.lng, 3));
    // The old resolution's row is a tombstone now, not a stale package.
    const rows = (await testDb.db.execute(sql`select tile, hash from static_packages order by tile`)) as unknown as { tile: string; hash: string | null }[];
    expect(rows.find((r) => r.tile === at4[0]!.tile)!.hash).toBeNull();
  });

  it("recreates a package file that went missing and tells the client to retry meanwhile", async () => {
    await truncateStatic();
    const { app, env, dir } = await startApp();
    await importSegments(app, env, segments(BERLIN.lat, BERLIN.lng, 5));
    const p = (((await manifest(app, env)).json() as Json).partitions as Json[])[0]!;
    for (const ext of ["json.gz", "json.br"]) rmSync(path.join(dir, p.tile, `${p.hash}.${ext}`));
    expect(existsSync(path.join(dir, p.tile, `${p.hash}.json.gz`))).toBe(false);

    const lost = await partition(app, env, p.tile);
    expect(lost.statusCode).toBe(503);
    expect(lost.json().error.code).toBe("PACKAGE_MISSING");
    const healed = await partition(app, env, p.tile);
    expect(healed.statusCode).toBe(200);
    expect(createHash("sha256").update(healed.body).digest("hex")).toBe(p.hash);
  });

  // ------------------------------------------------------------------ snapshot guard

  it("refuses a snapshot with static data above SNAPSHOT_STATIC_MAX_ROWS, instead of loading it all into memory", async () => {
    await truncateStatic();
    const { app, env } = await startApp({ SNAPSHOT_STATIC_MAX_ROWS: "10" });
    await importSegments(app, env, segments(BERLIN.lat, BERLIN.lng, 40));
    await testDb.db.execute(sql`analyze speed_limit_segments`);

    const refused = await app.inject({ method: "GET", url: "/v1/snapshot", headers: authHeader(await token(env)) });
    expect(refused.statusCode).toBe(413);
    expect(refused.json().error).toMatchObject({ code: "STATIC_DATA_TOO_LARGE_FOR_SNAPSHOT", details: { limit: 10 } });
    expect(refused.json().error.message).toMatch(/staticData=false/);

    const without = await app.inject({ method: "GET", url: "/v1/snapshot?staticData=false", headers: authHeader(await token(env)) });
    expect(without.statusCode).toBe(200);
    expect(without.json().speedLimitSegments).toEqual([]);
  });

  it("leaves the snapshot alone below the limit and when the check is off", async () => {
    const small = await startApp({ SNAPSHOT_STATIC_MAX_ROWS: "1000" });
    expect((await small.app.inject({ method: "GET", url: "/v1/snapshot", headers: authHeader(await token(small.env)) })).json().speedLimitSegments).toHaveLength(40);
    const off = await startApp({ SNAPSHOT_STATIC_MAX_ROWS: "0" });
    expect((await off.app.inject({ method: "GET", url: "/v1/snapshot", headers: authHeader(await token(off.env)) })).statusCode).toBe(200);
  });

  // ------------------------------------------------------------------ what else marks tiles

  it("packages a camera once its country is released and the write marks its tile", async () => {
    await truncateStatic();
    // The camera is packaged where its country is released at level full (docs/camera-country-policy.md).
    const { app, env } = await startApp(policy.env());
    const created = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: authHeader(await token(env)),
      payload: { type: "fixedSpeedCamera", lat: MUNICH.lat, lng: MUNICH.lng },
    });
    expect(created.statusCode).toBe(201);
    // The tile the camera is in, and (when it is another one) the tile that carries its zone.
    const dirty = (await testDb.db.execute(sql`select tile from static_packages where dirty`)) as unknown as { tile: string }[];
    expect(dirty.map((r) => r.tile)).toContain(tileOf(MUNICH));
    expect(dirty.length).toBeLessThanOrEqual(2);
    const body = (await partition(app, env, tileOf(MUNICH))).json() as Json;
    expect(body.fixedSpeedCameras).toHaveLength(1);
    expect(body.speedLimitSegments).toEqual([]);
  });
});
