import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { latLngToCell } from "h3-js";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { EUROPE_BOXES, loadBoundaries } from "./camera-policy-helper.js";

/**
 * Offline regions (GET /v1/static-data/regions, server 1.1.0): the static-data packages grouped into countries with
 * their sizes, so an app can say "France: 410 MB" and fetch exactly the tiles of a region.
 */
const RES = 4;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

describe("offline regions", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;
  let env: Env;
  let dir: string;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    dir = mkdtempSync(path.join(tmpdir(), "offline-regions-"));
    resetEnvCache();
    env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      LOG_LEVEL: "silent",
      STATIC_DATA_PARTITION_H3_RESOLUTION: String(RES),
      STATIC_PACKAGES_DIR: dir,
      STATIC_PACKAGES_GZIP_LEVEL: "4",
      STATIC_PACKAGES_BROTLI_QUALITY: "3",
    });
    app = await buildApp({ env, db: testDb.db });

    // Berlin, Munich (DE), Paris (FR), Zurich (CH), plus a patch in the North Sea that belongs to no country.
    const places = [
      { lat: 52.52, lng: 13.405, n: 12 },
      { lat: 48.137, lng: 11.575, n: 5 },
      { lat: 48.857, lng: 2.352, n: 9 },
      { lat: 47.37, lng: 8.54, n: 3 },
      { lat: 54.5, lng: 3.0, n: 2 },
    ];
    for (const p of places) {
      const rows = Array.from({ length: p.n }, (_, i) => ({
        lineString: [[p.lng + i * 0.0005, p.lat], [p.lng + i * 0.0005 + 0.0003, p.lat + 0.0002]],
        speedLimit: 50,
        speedLimitUnit: "kmh",
        source: "osm-test",
        sourceLicense: "ODbL",
      }));
      const res = await app.inject({
        method: "POST",
        url: "/v1/bulk-import/speed-limit-segments",
        headers: authHeader(await testToken(env, { scopes: ["bulk-import"] })),
        payload: { rows },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  const headers = async () => authHeader(await testToken(env));
  const regions = async (extra: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: "/v1/static-data/regions", headers: { ...(await headers()), ...extra } });
  const manifest = async () => (await app.inject({ method: "GET", url: "/v1/static-data/manifest", headers: await headers() })).json() as Json;

  it("without boundary data every region is a coarse area with no country, and nothing is lost", async () => {
    await testDb.db.execute(sql`delete from country_boundary_parts`);
    const res = await regions();
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(body.countryBoundaries).toBe(false);
    expect(body.regions.length).toBeGreaterThan(0);
    for (const r of body.regions as Json[]) {
      expect(r.country).toBeNull();
      expect(r.id).toMatch(/^h3:/);
    }
    const m = await manifest();
    expect(body.totals.tileCount).toBe(m.partitions.length);
  });

  it("with boundaries: the packages of a country are one region, with their sizes and tile ids", async () => {
    await loadBoundaries(testDb.db, EUROPE_BOXES);
    const body = (await regions()).json() as Json;
    expect(body.countryBoundaries).toBe(true);
    const byId = new Map((body.regions as Json[]).map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual(expect.arrayContaining(["CH", "DE", "FR"]));

    const m = await manifest();
    const partition = new Map((m.partitions as Json[]).map((p) => [p.tile, p]));
    const berlin = latLngToCell(52.52, 13.405, RES);
    const munich = latLngToCell(48.137, 11.575, RES);
    const paris = latLngToCell(48.857, 2.352, RES);
    const de = byId.get("DE")!;
    expect(de.tiles).toEqual(expect.arrayContaining([berlin, munich]));
    expect(byId.get("FR")!.tiles).toContain(paris);
    expect(de.country).toBe("DE");

    // the numbers are the manifest's, summed — not an estimate
    for (const region of byId.values()) {
      const parts = (region.tiles as string[]).map((t) => partition.get(t)!);
      expect(parts.every(Boolean)).toBe(true);
      expect(region.sizeBytes).toBe(parts.reduce((n, p) => n + p.sizeBytes, 0));
      expect(region.gzipBytes).toBe(parts.reduce((n, p) => n + p.gzipBytes, 0));
      expect(region.brotliBytes).toBe(parts.reduce((n, p) => n + p.brotliBytes, 0));
      expect(region.complete).toBe(true);
      expect(region.tileCount).toBe(region.tiles.length);
    }
    // every package is in exactly one region
    const all = (body.regions as Json[]).flatMap((r) => r.tiles as string[]);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(m.partitions.length);
    expect(body.totals).toMatchObject({ tileCount: m.partitions.length, complete: true });
    expect(body.staticDataVersion).toBe(m.staticDataVersion);
    expect(body.partitionResolution).toBe(RES);
  });

  it("the bounding box of a region contains the places in it", async () => {
    const body = (await regions()).json() as Json;
    const de = (body.regions as Json[]).find((r) => r.id === "DE")!;
    const [west, south, east, north] = de.bbox as number[];
    expect(13.405).toBeGreaterThan(west!);
    expect(13.405).toBeLessThan(east!);
    expect(52.52).toBeGreaterThan(south!);
    expect(52.52).toBeLessThan(north!);
  });

  it("revalidates with the ETag like the manifest, and is gzip-able", async () => {
    const first = await regions();
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    expect((await regions({ "if-none-match": etag })).statusCode).toBe(304);
    const zipped = await regions({ "accept-encoding": "gzip" });
    expect(zipped.headers["content-encoding"]).toBe("gzip");
  });

  it("needs a token like every other static-data read", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/static-data/regions" });
    expect(res.statusCode).toBe(401);
  });
});
