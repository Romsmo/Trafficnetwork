import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { cellToBoundary, cellToChildren, cellToParent, gridDisk, latLngToCell } from "h3-js";
import WebSocket from "ws";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { generateEd25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import { cellIntersectsCircle, tileSpeaksForCell } from "../../src/modules/cameras/policy/cells.js";
import { resolveCountries } from "../../src/modules/cameras/policy/boundaries.js";
import type { CameraLevel } from "../../src/modules/cameras/policy/levels.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { pgArray } from "../../src/db/pg-array.js";
import { createPolicyFixture, EUROPE_BOXES, loadBoundaries, type PolicyFixture } from "./camera-policy-helper.js";

/**
 * The country-based camera policy end to end (docs/camera-country-policy.md): one real Postgres/PostGIS, synthetic country
 * rectangles (no geodata is shipped), a signed network config per scenario. Every delivery path is read for every level.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ZONE_RES = 6;
const PARTITION_RES = 4;

const BERLIN = { lat: 52.52, lng: 13.405 }; // DE
const MUNICH = { lat: 48.137, lng: 11.575 }; // DE
const PARIS = { lat: 48.8566, lng: 2.3522 }; // FR
const LYON = { lat: 45.764, lng: 4.8357 }; // FR, far from every device below
const ZURICH = { lat: 47.3769, lng: 8.5417 }; // CH
const VIENNA = { lat: 48.2, lng: 16.37 }; // AT
const SEA = { lat: 52.0, lng: 20.0 }; // in no country at all
type Site = { lat: number; lng: number };

const near = (p: Site, meters: number): Site => ({ lat: p.lat + meters / 111_000, lng: p.lng });
const cellOf = (p: Site, res = ZONE_RES) => latLngToCell(p.lat, p.lng, res);

describe("country-based camera policy", () => {
  let testDb: TestDatabase;
  let packagesDir: string;
  const fixtures: PolicyFixture[] = [];
  const open: FastifyInstance[] = [];

  beforeAll(async () => {
    testDb = await startTestDatabase();
    packagesDir = mkdtempSync(path.join(tmpdir(), "camera-policy-packages-"));
    await loadBoundaries(testDb.db, EUROPE_BOXES);
  }, 90_000);

  afterAll(async () => {
    for (const app of open) await app.close().catch(() => undefined);
    for (const fixture of fixtures) fixture.cleanup();
    rmSync(packagesDir, { recursive: true, force: true });
    await testDb.teardown();
  });

  // ------------------------------------------------------------------ helpers

  async function startApp(
    levels: Record<string, CameraLevel> | null,
    extra: Record<string, string> = {},
    opts: { blitzerEnabled?: boolean } = {},
  ): Promise<{ app: FastifyInstance; env: Env; policy: PolicyFixture }> {
    const policy = createPolicyFixture();
    fixtures.push(policy);
    if (levels) policy.write(levels, { blitzerEnabled: opts.blitzerEnabled ?? true });
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      LOG_LEVEL: "silent",
      CAMERA_REMOVAL_THRESHOLD: "2",
      DUPLICATE_MERGE_RADIUS_METERS: "500",
      STATIC_DATA_PARTITION_H3_RESOLUTION: String(PARTITION_RES),
      STATIC_PACKAGES_DIR: packagesDir,
      STATIC_PACKAGES_GZIP_LEVEL: "4",
      STATIC_PACKAGES_BROTLI_QUALITY: "3",
      ...(levels ? policy.env() : { SPEED_CAMERA_NAMESPACE_ENABLED: "true" }),
      ...extra,
    });
    const app = await buildApp({ env, db: testDb.db });
    open.push(app);
    return { app, env, policy };
  }

  async function stop(app: FastifyInstance) {
    await app.close();
    open.splice(open.indexOf(app), 1);
  }

  async function withApp<T>(
    levels: Record<string, CameraLevel> | null,
    fn: (ctx: { app: FastifyInstance; env: Env; policy: PolicyFixture; get: (url: string) => Promise<Json> }) => Promise<T>,
    extra: Record<string, string> = {},
    opts: { blitzerEnabled?: boolean } = {},
  ): Promise<T> {
    const ctx = await startApp(levels, extra, opts);
    try {
      const get = async (url: string) => {
        const res = await ctx.app.inject({ method: "GET", url, headers: authHeader(await testToken(ctx.env)) });
        expect(res.statusCode, url).toBe(200);
        return res.json() as Json;
      };
      return await fn({ ...ctx, get });
    } finally {
      await stop(ctx.app);
    }
  }

  async function reset() {
    await testDb.db.execute(sql`
      truncate table camera_removal_reports, fixed_speed_cameras, hazard_confirmations, hazard_reports, event_log,
      static_packages restart identity cascade
    `);
    await testDb.db.execute(sql`update static_package_state set ready = false, fingerprint = null, built_version = 0, lease_owner = null, lease_until = null`);
    await testDb.db.execute(sql`update static_data_state set version = 1, camera_policy = null`);
  }

  /** Writes through a node that releases nothing: writes are never gated, so this is a neutral way to put data in. */
  async function seed() {
    const { app, env } = await startApp(null);
    try {
      const rows = [
        { site: BERLIN, type: "fixedSpeedCamera" },
        { site: near(BERLIN, 300), type: "redLightCamera" },
        { site: PARIS, type: "fixedSpeedCamera" },
        { site: near(PARIS, 100), type: "redLightCamera" },
        { site: ZURICH, type: "fixedSpeedCamera" },
        { site: VIENNA, type: "distanceControl" },
        { site: SEA, type: "fixedSpeedCamera" },
      ];
      const imported = await app.inject({
        method: "POST",
        url: "/v1/bulk-import/speed-cameras",
        headers: authHeader(await testToken(env, { scopes: ["bulk-import"] })),
        payload: { rows: rows.map((r) => ({ lat: r.site.lat, lng: r.site.lng, cameraType: r.type, source: "osm-test" })) },
      });
      expect(imported.statusCode, imported.body).toBe(200);
      for (const [i, site] of [near(BERLIN, 1500), near(PARIS, 1500), near(ZURICH, 1500), near(VIENNA, 1500)].entries()) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/hazard-reports",
          headers: authHeader(await testToken(env, { sub: `reporter-${i}` })),
          payload: { type: "mobileSpeedCamera", lat: site.lat, lng: site.lng, speedKmh: 90 },
        });
        expect(res.statusCode, res.body).toBe(202);
      }
    } finally {
      await stop(app);
    }
  }

  const SITES = { BERLIN, MUNICH, PARIS, LYON, ZURICH, VIENNA, SEA } as const;

  /** Everything a client can obtain about cameras from every read path, collected in one bag. */
  interface Bag {
    items: { path: string; id?: string; type: string; lat: number; lng: number }[];
    zones: { path: string; zone: Json }[];
    raw: string[];
  }

  async function collect(ctx: { get: (url: string) => Promise<Json>; app: FastifyInstance; env: Env }): Promise<Bag> {
    const bag: Bag = { items: [], zones: [], raw: [] };
    const addItem = (path: string, c: Json) => {
      const [lng, lat] = c.position.coordinates as [number, number];
      bag.items.push({ path, id: c.id, type: c.type, lat, lng });
    };
    const addRead = (path: string, body: Json) => {
      bag.raw.push(JSON.stringify(body));
      for (const c of (body.cameras ?? []) as Json[]) addItem(path, c);
      for (const z of (body.zones ?? []) as Json[]) bag.zones.push({ path, zone: z });
    };
    const regionTiles = new Set<string>();
    for (const site of Object.values(SITES)) {
      for (const r of [500, 5_000, 50_000]) {
        addRead(`nearby ${r}`, await ctx.get(`/v1/speed-cameras/nearby?lat=${site.lat}&lng=${site.lng}&radiusM=${r}`));
      }
      const tile = cellOf(site, ctx.env.REGION_TILE_H3_RESOLUTION);
      for (const t of gridDisk(tile, 2)) regionTiles.add(t);
      // a tile two rings away from the site, with k=5 reaching it: neighbours must not be a way around the policy
      const neighbour = gridDisk(tile, 2).find((t) => t !== tile && !gridDisk(tile, 1).includes(t))!;
      addRead("by-tile k=5", await ctx.get(`/v1/speed-cameras/by-tile?tile=${neighbour}&k=5`));
      addRead("by-tile k=0", await ctx.get(`/v1/speed-cameras/by-tile?tile=${tile}&k=0`));
    }
    const tiles = [...regionTiles].join(",");

    const snapshot = await ctx.get(`/v1/snapshot?tiles=${tiles}`);
    bag.raw.push(JSON.stringify(snapshot));
    for (const c of [...snapshot.fixedSpeedCameras, ...snapshot.enforcementDevices] as Json[]) addItem("snapshot", c);
    for (const r of snapshot.hazardReports as Json[]) if (r.type.endsWith("Camera") || r.type === "distanceControl") addItem("snapshot reports", r);
    for (const z of snapshot.cameraZones as Json[]) bag.zones.push({ path: "snapshot", zone: z });

    const delta = await ctx.get(`/v1/delta?since=0&limit=5000&tiles=${tiles}`);
    bag.raw.push(JSON.stringify(delta));
    for (const e of delta.events as Json[]) {
      if (e.entityType === "cameraZone") bag.zones.push({ path: "delta", zone: e.payload });
      else if (e.entityType === "fixedSpeedCamera" || e.entityType === "enforcementDevice" || (e.payload?.type && String(e.payload.type).match(/Camera|distanceControl/))) {
        if (e.payload?.position) addItem("delta", e.payload);
        else bag.items.push({ path: "delta (no position)", type: String(e.payload?.type), lat: NaN, lng: NaN });
      }
    }

    const manifest = await ctx.get("/v1/static-data/manifest");
    bag.raw.push(JSON.stringify(manifest));
    for (const p of manifest.partitions as Json[]) {
      const partition = await ctx.get(`/v1/static-data/partitions/${p.tile}`);
      bag.raw.push(JSON.stringify(partition));
      for (const c of [...partition.fixedSpeedCameras, ...(partition.enforcementDevices ?? [])] as Json[]) addItem("package", c);
      for (const z of (partition.cameraZones ?? []) as Json[]) bag.zones.push({ path: "package", zone: z });
    }
    return bag;
  }

  /** Does the bag disclose anything about this site: an individual camera within 3 km, or the zone of its cell? */
  const discloses = (bag: Bag, site: Site) =>
    bag.items.some((i) => Math.abs(i.lat - site.lat) < 0.03 && Math.abs(i.lng - site.lng) < 0.05) ||
    bag.zones.some((z) => z.zone.cell === cellOf(site));
  const itemsAt = (bag: Bag, site: Site) => bag.items.filter((i) => Math.abs(i.lat - site.lat) < 0.03 && Math.abs(i.lng - site.lng) < 0.05);

  // ------------------------------------------------------------------ the levels

  describe("one case per level, read through every path", () => {
    it("delivers nothing, on any path, until the operator has signed a policy - not even with the brake released", async () => {
      await reset();
      await seed();
      await withApp(null, async (ctx) => {
        const bag = await collect(ctx);
        for (const [name, site] of Object.entries(SITES)) expect(discloses(bag, site), name).toBe(false);
        expect(bag.items).toEqual([]);
        expect(bag.zones).toEqual([]);
        const config = await ctx.get("/v1/config");
        expect(config.speedCameraNamespaceEnabled).toBe(false);
        // no signed config at all: the brake stays on (it needs the network's blitzerEnabled), and no country is above off
        expect(config.cameraPolicy).toMatchObject({ namespaceEnabled: false, defaultLevel: "off", byCountry: {} });
      });
    });

    it("level off: a country that is off - or not listed, or in no country at all - delivers nothing, whatever the neighbours are", async () => {
      await withApp({ DE: "full", FR: "zones", CH: "off" /* AT and the sea are not listed */ }, async (ctx) => {
        const bag = await collect(ctx);
        for (const [name, site] of [["ZURICH (CH, listed as off)", ZURICH], ["VIENNA (AT, not listed)", VIENNA], ["SEA (no country)", SEA]] as const) {
          expect(discloses(bag, site), name).toBe(false);
        }
        // the raw responses never mention them either: no id, no coordinate, no type hint
        const text = bag.raw.join("\n");
        expect(text).not.toContain("8.5417");
        expect(text).not.toContain("16.37");
        // and the camera types of AT/CH never show up in any zone
        for (const { zone } of bag.zones) expect(zone.cameraTypes).not.toContain("distanceControl");
      });
    });

    it("level full: the individual cameras of the country, on every path, exactly as before", async () => {
      await withApp({ DE: "full", FR: "zones", CH: "off" }, async (ctx) => {
        const bag = await collect(ctx);
        const berlin = itemsAt(bag, BERLIN);
        for (const path of ["nearby 5000", "nearby 50000", "by-tile k=0", "snapshot", "snapshot reports", "delta", "package"]) {
          expect(berlin.some((i) => i.path === path), `Berlin via ${path}`).toBe(true);
        }
        expect(berlin.map((i) => i.type)).toEqual(expect.arrayContaining(["fixedSpeedCamera", "redLightCamera", "mobileSpeedCamera"]));
        // a full country has no zones
        expect(bag.zones.some((z) => z.zone.cell === cellOf(BERLIN))).toBe(false);

        // the item itself is the one clients have always received
        const nearby = await ctx.get(`/v1/speed-cameras/nearby?lat=${BERLIN.lat}&lng=${BERLIN.lng}&radiusM=500&types=fixedSpeedCamera`);
        expect(nearby.cameras).toHaveLength(1);
        expect(nearby.cameras[0]).toMatchObject({ type: "fixedSpeedCamera", cameraType: "fixedSpeedCamera", status: "active", source: "osm-test" });
        expect(nearby.zones).toEqual([]);
      });
    });

    it("level zones: a coarse cell with the camera kinds in it - never an individual camera, on any path", async () => {
      await withApp({ DE: "full", FR: "zones", CH: "off" }, async (ctx) => {
        const bag = await collect(ctx);
        expect(itemsAt(bag, PARIS)).toEqual([]);
        const cell = cellOf(PARIS);
        const paths = new Set(bag.zones.filter((z) => z.zone.cell === cell).map((z) => z.path));
        for (const path of ["nearby 500", "nearby 5000", "by-tile k=0", "snapshot", "delta", "package"]) {
          expect(paths.has(path), `Paris zone via ${path}`).toBe(true);
        }
        for (const { zone } of bag.zones) {
          expect(Object.keys(zone).sort()).toEqual(["boundary", "cameraTypes", "cell", "id", "resolution", "status"]);
          expect(zone.resolution).toBe(ZONE_RES);
          expect(zone.status).toBe("active");
        }
        // devices and live reports of the cell both show up as kinds - nothing says how many or where
        const nearbyParis = await ctx.get(`/v1/speed-cameras/nearby?lat=${PARIS.lat}&lng=${PARIS.lng}&radiusM=500`);
        expect(nearbyParis.cameras).toEqual([]);
        const zone = (nearbyParis.zones as Json[]).find((z) => z.cell === cell)!;
        expect(zone.cameraTypes).toEqual(expect.arrayContaining(["fixedSpeedCamera", "redLightCamera"]));
        // every coordinate in every zone response is a vertex of the cell: nothing finer than the cell
        const vertices = new Set(cellToBoundary(cell, true).map(([lng, lat]) => `${lng},${lat}`));
        for (const [lng, lat] of zone.boundary.coordinates[0] as [number, number][]) expect(vertices.has(`${lng},${lat}`)).toBe(true);
        const body = JSON.stringify(nearbyParis);
        expect(body).not.toContain(String(PARIS.lat));
        expect(body).not.toContain('"source"');
        expect(body).not.toContain("osm-test");
      });
    });

    it("a requested type restricts zones as well as cameras", async () => {
      await withApp({ FR: "zones" }, async (ctx) => {
        const only = await ctx.get(`/v1/speed-cameras/nearby?lat=${PARIS.lat}&lng=${PARIS.lng}&radiusM=500&types=redLightCamera`);
        expect((only.zones as Json[]).map((z) => z.cameraTypes)).toEqual([["redLightCamera"]]);
        const none = await ctx.get(`/v1/speed-cameras/nearby?lat=${PARIS.lat}&lng=${PARIS.lng}&radiusM=500&types=trailerCamera`);
        expect(none).toEqual({ cameras: [], zones: [] });
        const notACamera = await ctx.get(`/v1/speed-cameras/nearby?lat=${PARIS.lat}&lng=${PARIS.lng}&radiusM=500&types=traffic`);
        expect(notACamera).toEqual({ cameras: [], zones: [] });
      });
    });

    it("a camera report of a zones country is a zone in the snapshot for the requested tiles - and only for those", async () => {
      await withApp({ DE: "full", FR: "zones" }, async (ctx) => {
        const tileParis = cellOf(PARIS, ctx.env.REGION_TILE_H3_RESOLUTION);
        const withTiles = await ctx.get(`/v1/snapshot?staticData=false&tiles=${tileParis}`);
        expect(withTiles.hazardReports.filter((r: Json) => r.type === "mobileSpeedCamera")).toEqual([]);
        expect((withTiles.cameraZones as Json[]).map((z) => z.cell)).toContain(cellOf(PARIS));
        expect(withTiles.fixedSpeedCameras).toEqual([]);
        const elsewhere = await ctx.get(`/v1/snapshot?staticData=false&tiles=${cellOf(BERLIN, ctx.env.REGION_TILE_H3_RESOLUTION)}`);
        expect((elsewhere.cameraZones as Json[]).map((z) => z.cell)).not.toContain(cellOf(PARIS));
      });
    });
  });

  // ------------------------------------------------------------------ zones cannot be re-condensed

  describe("zones cannot be narrowed down to a point by asking again", () => {
    async function oneCameraAt(site: Site) {
      await reset();
      await testDb.db.execute(sql`
        insert into fixed_speed_cameras (position, countries, source)
        values (ST_SetSRID(ST_MakePoint(${site.lng}, ${site.lat}), 4326), ARRAY['FR'], 'probe')`);
    }

    const cell = cellOf(LYON);
    const probeGrid = (): Site[] => {
      const out: Site[] = [];
      for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++) out.push({ lat: LYON.lat + (i * 1100) / 111_000, lng: LYON.lng + (j * 1100) / (111_000 * Math.cos((LYON.lat * Math.PI) / 180)) });
      return out;
    };

    async function probe(get: (url: string) => Promise<Json>) {
      const answers: string[] = [];
      for (const p of probeGrid()) {
        for (const r of [100, 400, 1500, 4000]) {
          const body = await get(`/v1/speed-cameras/nearby?lat=${p.lat}&lng=${p.lng}&radiusM=${r}`);
          expect(body.cameras).toEqual([]);
          const zones = body.zones as Json[];
          expect(zones.every((z) => z.cell === cell)).toBe(true);
          // membership follows the cell's geometry against the circle - never the camera's own position
          expect(zones.length > 0, `probe ${p.lat},${p.lng} r=${r}`).toBe(cellIntersectsCircle(cell, p.lat, p.lng, r));
          answers.push(JSON.stringify(zones));
        }
      }
      return answers;
    }

    it("answers every circle exactly as the cell's geometry says, and identically wherever in the cell the camera is", async () => {
      const [lat0, lng0] = [LYON.lat, LYON.lng];
      const vertices = cellToBoundary(cell);
      // two positions deep inside the same cell, and one just inside a vertex
      const inside: Site[] = [
        { lat: lat0, lng: lng0 },
        { lat: lat0 + 0.012, lng: lng0 - 0.015 },
        { lat: vertices[0]![0] + (lat0 - vertices[0]![0]) * 0.02, lng: vertices[0]![1] + (lng0 - vertices[0]![1]) * 0.02 },
      ];
      for (const p of inside) expect(cellOf(p)).toBe(cell);

      const vectors: string[][] = [];
      for (const p of inside) {
        await oneCameraAt(p);
        vectors.push(await withApp({ FR: "zones" }, async (ctx) => probe(ctx.get)));
      }
      expect(vectors[1]).toEqual(vectors[0]);
      expect(vectors[2]).toEqual(vectors[0]);
      // the probe really distinguishes: some circles hit the cell, some do not
      const hits = vectors[0]!.filter((a) => a !== "[]").length;
      expect(hits).toBeGreaterThan(20);
      expect(hits).toBeLessThan(vectors[0]!.length - 20);
    }, 240_000);

    it("by-tile answers by the cell too: any tile that touches the cell gets the zone, any other does not", async () => {
      const camera = LYON;
      await oneCameraAt(camera);
      await withApp({ FR: "zones" }, async (ctx) => {
        const ownTile7 = cellOf(camera, 7);
        const siblings = cellToChildren(cell, 7).filter((t) => t !== ownTile7);
        const tiles = [ownTile7, ...siblings, cellOf(camera, 8), cellOf(camera, 9), cell, cellToParent(cell, 5)];
        for (const tile of tiles) {
          expect(tileSpeaksForCell(tile, cell)).toBe(true);
          const body = await ctx.get(`/v1/speed-cameras/by-tile?tile=${tile}&k=0`);
          expect((body.zones as Json[]).map((z) => z.cell), tile).toEqual([cell]);
          expect(body.cameras).toEqual([]);
        }
        // a tile of the neighbouring cell gets nothing, even though it is adjacent
        const neighbourCell = gridDisk(cell, 1).find((c) => c !== cell)!;
        const neighbour = await ctx.get(`/v1/speed-cameras/by-tile?tile=${cellToChildren(neighbourCell, 7)[0]}&k=0`);
        expect(neighbour.zones).toEqual([]);
      });
    });

    it("delta and WebSocket route a zone event by the cell, not by the tile the camera is in", async () => {
      await reset();
      await withApp({ FR: "zones" }, async (ctx) => {
        const created = await ctx.app.inject({
          method: "POST",
          url: "/v1/hazard-reports",
          headers: authHeader(await testToken(ctx.env, { sub: "mobile-reporter" })),
          payload: { type: "mobileSpeedCamera", lat: LYON.lat, lng: LYON.lng, speedKmh: 80 },
        });
        expect(created.statusCode).toBe(202);
        const ownTile = cellOf(LYON, ctx.env.REGION_TILE_H3_RESOLUTION);
        const sibling = cellToChildren(cell, 7).find((t) => t !== ownTile)!;

        const viaOwn = await ctx.get(`/v1/delta?since=0&tiles=${ownTile}`);
        const viaSibling = await ctx.get(`/v1/delta?since=0&tiles=${sibling}`);
        const viaBerlin = await ctx.get(`/v1/delta?since=0&tiles=${cellOf(BERLIN, 7)}`);
        for (const page of [viaOwn, viaSibling]) {
          expect(page.events).toHaveLength(1);
          expect(page.events[0]).toMatchObject({ entityType: "cameraZone", type: "StaticDataUpdated", regionTile: null });
          expect(page.events[0].payload.cell).toBe(cell);
          expect(JSON.stringify(page)).not.toContain("mobile-reporter");
        }
        // The two answers are the same event: nothing tells which tile the camera is in.
        expect(viaSibling.events[0].entityId).toBe(viaOwn.events[0].entityId);
        expect(viaBerlin.events).toEqual([]);
      });
    });
  });

  // ------------------------------------------------------------------ changing the policy

  describe("a policy change takes effect without a restart", () => {
    it("tightens, loosens, refuses a rollback and fails closed on a broken file", async () => {
      await reset();
      await seed();
      const { app, env, policy } = await startApp({ DE: "full", FR: "zones" });
      try {
        const get = async (url: string) => (await app.inject({ method: "GET", url, headers: authHeader(await testToken(env)) })).json() as Json;
        const berlinNearby = `/v1/speed-cameras/nearby?lat=${BERLIN.lat}&lng=${BERLIN.lng}&radiusM=5000`;
        const parisNearby = `/v1/speed-cameras/nearby?lat=${PARIS.lat}&lng=${PARIS.lng}&radiusM=5000`;
        const berlinTile = cellOf(BERLIN, PARTITION_RES);
        const partitionTiles = async () => ((await get("/v1/static-data/manifest")).partitions as Json[]).map((p) => p.tile as string);

        expect((await get(berlinNearby)).cameras.length).toBeGreaterThan(0);
        expect(await partitionTiles()).toContain(berlinTile);
        const berlinEntry = ((await get("/v1/static-data/manifest")).partitions as Json[]).find((p) => p.tile === berlinTile)!;
        const packageUrl = `/v1/static-data/packages/${berlinTile}/${berlinEntry.hash}`;
        const fetchPackage = async () => (await app.inject({ method: "GET", url: packageUrl, headers: authHeader(await testToken(env)) })).statusCode;
        expect(await fetchPackage()).toBe(200);
        const before = (await get("/v1/config")).cameraPolicy as Json;
        const versionBefore = (await get("/v1/config")).staticDataVersion as number;

        // --- withdraw Germany: signed version 2 without it
        policy.write({ FR: "zones" });
        expect((await app.cameraPolicy.reload()).status).toBe("applied");
        // The old package - the one with the German cameras in it - is not reachable any more, not even through its
        // content-addressed URL: unserved while the rebuild is pending (503), gone once it is done (404). Never 200.
        expect([503, 404]).toContain(await fetchPackage());
        expect(await get(berlinNearby)).toEqual({ cameras: [], zones: [] });
        expect((await get(parisNearby)).zones.length).toBeGreaterThan(0);
        const config = await get("/v1/config");
        expect(config.cameraPolicy.byCountry).toEqual({ FR: "zones" });
        expect(config.cameraPolicy.version).not.toBe(before.version);
        expect(config.staticDataVersion).toBeGreaterThan(versionBefore);
        // the package of Berlin's tile is rebuilt without the devices (it held nothing else: it is gone from the manifest)
        expect(await partitionTiles()).not.toContain(berlinTile);
        expect(await fetchPackage()).toBe(404);
        const stored = await testDb.db.execute<{ camera_policy: Json } & Record<string, unknown>>(sql`select camera_policy from static_data_state where id = 1`);
        expect(stored[0]!.camera_policy.byCountry).toEqual({ FR: "zones" });

        // --- release Germany as zones: the same tile now carries a zone and no device
        policy.write({ DE: "zones", FR: "zones" });
        expect((await app.cameraPolicy.reload()).status).toBe("applied");
        const berlinZones = await get(berlinNearby);
        expect(berlinZones.cameras).toEqual([]);
        expect((berlinZones.zones as Json[]).map((z) => z.cell)).toContain(cellOf(BERLIN));
        const berlinPackage = await get(`/v1/static-data/partitions/${berlinTile}`);
        expect(berlinPackage.enforcementDevices).toBeUndefined();
        expect((berlinPackage.cameraZones as Json[]).map((z) => z.cell)).toContain(cellOf(BERLIN));

        // --- an older, still validly signed (and more generous) file is a rollback: refused
        policy.write({ DE: "full", FR: "full" }, { version: 1 });
        const refused = await app.cameraPolicy.reload();
        expect(refused.status).toBe("refused");
        expect((await get(berlinNearby)).cameras).toEqual([]);
        expect((await get("/v1/config")).cameraPolicy.byCountry).toEqual({ DE: "zones", FR: "zones" });

        // --- a file that cannot be verified: everything is off until a valid one is read again
        writeFileSync(policy.file, "{ this is not a signed config");
        expect((await app.cameraPolicy.reload()).status).toBe("failed-closed");
        expect(await get(berlinNearby)).toEqual({ cameras: [], zones: [] });
        expect(await get(parisNearby)).toEqual({ cameras: [], zones: [] });
        expect((await get("/v1/config")).cameraPolicy.namespaceEnabled).toBe(false);
        expect((await get("/v1/config")).speedCameraNamespaceEnabled).toBe(false);
        policy.write({ DE: "full" }, { version: 50 });
        expect((await app.cameraPolicy.reload()).status).toBe("applied");
        expect((await get(berlinNearby)).cameras.length).toBeGreaterThan(0);
      } finally {
        await stop(app);
      }
    }, 120_000);

    it("a change made while the node was down is found at start-up and marks the packages", async () => {
      await reset();
      await seed();
      await withApp({ DE: "full" }, async (ctx) => {
        expect(((await ctx.get("/v1/static-data/manifest")).partitions as Json[]).map((p) => p.tile)).toContain(cellOf(BERLIN, PARTITION_RES));
      });
      // restart with Germany withdrawn
      await withApp({ FR: "zones" }, async (ctx) => {
        expect(((await ctx.get("/v1/static-data/manifest")).partitions as Json[]).map((p) => p.tile)).not.toContain(cellOf(BERLIN, PARTITION_RES));
        expect((await ctx.get(`/v1/speed-cameras/nearby?lat=${BERLIN.lat}&lng=${BERLIN.lng}&radiusM=5000`)).cameras).toEqual([]);
      });
    });
  });

  // ------------------------------------------------------------------ the node's own limits

  describe("the node operator can only be stricter", () => {
    it("the emergency brake beats the signed policy - locally and in the signed config", async () => {
      await reset();
      await seed();
      // locally: SPEED_CAMERA_NAMESPACE_ENABLED=false
      await withApp({ DE: "full", FR: "zones" }, async (ctx) => {
        const bag = await collect(ctx);
        expect(bag.items).toEqual([]);
        expect(bag.zones).toEqual([]);
        const config = await ctx.get("/v1/config");
        expect(config.cameraPolicy).toMatchObject({ namespaceEnabled: false, byCountry: {} });
        expect(config.speedCameraNamespaceEnabled).toBe(false);
        // the signed envelope still carries the raw network policy, for clients that verify it themselves
        expect(config.networkConfig.payload.cameraPolicyByCountry).toEqual({ DE: "full", FR: "zones" });
      }, { SPEED_CAMERA_NAMESPACE_ENABLED: "false" });
      // in the signed config: blitzerEnabled=false
      await withApp({ DE: "full", FR: "zones" }, async (ctx) => {
        const bag = await collect(ctx);
        expect(bag.items).toEqual([]);
        expect(bag.zones).toEqual([]);
        expect((await ctx.get("/v1/config")).cameraPolicy.namespaceEnabled).toBe(false);
      }, {}, { blitzerEnabled: false });
    });

    it("a local cap lowers a country, never raises one", async () => {
      await withApp({ DE: "full", FR: "zones" }, async (ctx) => {
        const config = await ctx.get("/v1/config");
        expect(config.cameraPolicy.byCountry).toEqual({ DE: "zones", FR: "zones" }); // DE capped down; FR already zones
        const bag = await collect(ctx);
        expect(itemsAt(bag, BERLIN)).toEqual([]);
        expect(bag.zones.some((z) => z.zone.cell === cellOf(BERLIN))).toBe(true);
        expect(discloses(bag, ZURICH)).toBe(false); // the cap "*=full" grants nothing for a country the network does not list
      }, { CAMERA_POLICY_LOCAL_CAPS: "DE=zones,CH=full,*=full" });
      await withApp({ DE: "full", FR: "zones" }, async (ctx) => {
        const bag = await collect(ctx);
        expect(discloses(bag, BERLIN)).toBe(false);
        expect(bag.zones.some((z) => z.zone.cell === cellOf(PARIS))).toBe(false);
        expect((await ctx.get("/v1/config")).cameraPolicy.byCountry).toEqual({});
      }, { CAMERA_POLICY_LOCAL_CAPS: "*=off" });
    });
  });

  // ------------------------------------------------------------------ which country a camera is in

  describe("the country of a camera", () => {
    const countriesOf = async (lat: number, lng: number) =>
      (await testDb.db.execute<{ c: string[] } & Record<string, unknown>>(sql`select camera_countries(ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326), 1000) as c`))[0]!.c;

    it("stores one country inside a country and several inside the border strip; none outside every boundary", async () => {
      expect(await countriesOf(BERLIN.lat, BERLIN.lng)).toEqual(["DE"]);
      expect(await countriesOf(PARIS.lat, PARIS.lng)).toEqual(["FR"]);
      expect(await countriesOf(SEA.lat, SEA.lng)).toEqual([]);
      // FR | DE meet at lng 7.0: 500 m either side is in both, 3 km away is in one
      const lat = 49.5;
      const metersToLng = (m: number) => m / (111_320 * Math.cos((lat * Math.PI) / 180));
      expect(await countriesOf(lat, 7 + metersToLng(500))).toEqual(["DE", "FR"]);
      expect(await countriesOf(lat, 7 - metersToLng(500))).toEqual(["DE", "FR"]);
      expect(await countriesOf(lat, 7 + metersToLng(3000))).toEqual(["DE"]);
      expect(await countriesOf(lat, 7 - metersToLng(3000))).toEqual(["FR"]);
    });

    it("a camera in a border strip takes the stricter level of the two sides", async () => {
      await reset();
      const lat = 49.5;
      const lngBorder = 7 + 500 / (111_320 * Math.cos((lat * Math.PI) / 180));
      const onGermanSide = { lat, lng: lngBorder };
      const farInGermany = { lat, lng: lngBorder + 0.1 };
      await testDb.db.execute(sql`
        insert into fixed_speed_cameras (position, countries, source) values
          (ST_SetSRID(ST_MakePoint(${onGermanSide.lng}, ${onGermanSide.lat}), 4326), camera_countries(ST_SetSRID(ST_MakePoint(${onGermanSide.lng}, ${onGermanSide.lat}), 4326), 1000), 'border'),
          (ST_SetSRID(ST_MakePoint(${farInGermany.lng}, ${farInGermany.lat}), 4326), camera_countries(ST_SetSRID(ST_MakePoint(${farInGermany.lng}, ${farInGermany.lat}), 4326), 1000), 'inland')`);
      // DE full, FR zones: the border camera is only a zone; the one far inside Germany is individual
      await withApp({ DE: "full", FR: "zones" }, async (ctx) => {
        const body = await ctx.get(`/v1/speed-cameras/nearby?lat=${lat}&lng=${lngBorder + 0.05}&radiusM=20000`);
        expect(body.cameras).toHaveLength(1);
        expect(body.cameras[0].source).toBe("inland");
        expect((body.zones as Json[]).map((z) => z.cell)).toEqual([cellOf(onGermanSide)]);
      });
      // DE full, FR off: the border camera is withheld entirely
      await withApp({ DE: "full", FR: "off" }, async (ctx) => {
        const body = await ctx.get(`/v1/speed-cameras/nearby?lat=${lat}&lng=${lngBorder + 0.05}&radiusM=20000`);
        expect(body.cameras.map((c: Json) => c.source)).toEqual(["inland"]);
        expect(body.zones).toEqual([]);
      });
    });

    it("rows with no resolved country - and every camera while no boundaries are loaded - are not delivered, until they are resolved", async () => {
      await reset();
      await testDb.db.execute(sql`delete from country_boundary_parts`);
      try {
        await withApp({ DE: "full" }, async (ctx) => {
          const written = await ctx.app.inject({
            method: "POST",
            url: "/v1/hazard-reports",
            headers: authHeader(await testToken(ctx.env, { sub: "early" })),
            payload: { type: "fixedSpeedCamera", lat: BERLIN.lat, lng: BERLIN.lng },
          });
          expect(written.statusCode).toBe(202); // accepted, but nothing may be said about it
          const stored = await testDb.db.execute<{ countries: string[] | null } & Record<string, unknown>>(sql`select countries from fixed_speed_cameras`);
          expect(stored[0]!.countries).toEqual([]); // no boundary within reach: no country
          expect(await ctx.get(`/v1/speed-cameras/nearby?lat=${BERLIN.lat}&lng=${BERLIN.lng}&radiusM=5000`)).toEqual({ cameras: [], zones: [] });
        });
      } finally {
        await loadBoundaries(testDb.db, EUROPE_BOXES);
      }
      // boundaries arrive; the operator resolves the stored cameras (npm run cameras -- resolve-countries --all)
      await withApp({ DE: "full" }, async (ctx) => {
        expect((await ctx.get(`/v1/speed-cameras/nearby?lat=${BERLIN.lat}&lng=${BERLIN.lng}&radiusM=5000`)).cameras).toEqual([]);
        await testDb.db.execute(sql`update fixed_speed_cameras set countries = null`); // as a row from before the migration looks
        expect((await ctx.get(`/v1/speed-cameras/nearby?lat=${BERLIN.lat}&lng=${BERLIN.lng}&radiusM=5000`)).cameras).toEqual([]);
        const result = await resolveCountries(testDb.db, 1000, { all: false, partitionRes: PARTITION_RES, zoneRes: ZONE_RES });
        expect(result.devices).toBe(1);
        expect((await ctx.get(`/v1/speed-cameras/nearby?lat=${BERLIN.lat}&lng=${BERLIN.lng}&radiusM=5000`)).cameras).toHaveLength(1);
      });
    });
  });

  describe("re-resolving the countries of stored cameras", () => {
    it("marks the package of a camera whose known country set changed as not servable - one that had none yet only as dirty", async () => {
      await reset();
      await testDb.db.execute(sql`
        insert into fixed_speed_cameras (position, countries, source)
        values (ST_SetSRID(ST_MakePoint(${BERLIN.lng}, ${BERLIN.lat}), 4326), camera_countries(ST_SetSRID(ST_MakePoint(${BERLIN.lng}, ${BERLIN.lat}), 4326), 1000), 'berlin')`);
      const berlinTile = cellOf(BERLIN, PARTITION_RES);
      await withApp({ DE: "full" }, async (ctx) => {
        await ctx.get("/v1/static-data/manifest"); // builds the packages
        const staleOf = async () =>
          (await testDb.db.execute<{ policy_stale: boolean } & Record<string, unknown>>(sql`select policy_stale from static_packages where tile = ${berlinTile}`))[0]?.policy_stale;
        expect(await staleOf()).toBe(false);

        // New boundary data puts Berlin in another country: the camera was deliverable before and may not be now.
        await loadBoundaries(testDb.db, [{ iso2: "XX", west: 7, south: 47.5, east: 15, north: 55 }]);
        try {
          const result = await resolveCountries(testDb.db, 1000, { all: true, partitionRes: PARTITION_RES, zoneRes: ZONE_RES });
          expect(result.devices).toBe(1);
          expect(result.staleTiles).toBeGreaterThanOrEqual(1);
          expect(await staleOf()).toBe(true);
          // not served while stale: the rebuild (done by the next request on a small dataset) replaces it
          expect((await ctx.get(`/v1/speed-cameras/nearby?lat=${BERLIN.lat}&lng=${BERLIN.lng}&radiusM=5000`))).toEqual({ cameras: [], zones: [] });
          await ctx.get("/v1/static-data/manifest");
          expect(await staleOf()).toBe(false);
        } finally {
          await loadBoundaries(testDb.db, EUROPE_BOXES);
        }
      });
    });
  });

  // ------------------------------------------------------------------ what a write may tell

  describe("writing is never blocked - and never tells more than a read would", () => {
    it("answers the same for a new and for a merged camera unless its country is delivered individually", async () => {
      await reset();
      await withApp({ DE: "full", FR: "zones", CH: "off" }, async (ctx) => {
        const post = async (sub: string, site: Site, type = "fixedSpeedCamera") =>
          ctx.app.inject({ method: "POST", url: "/v1/hazard-reports", headers: authHeader(await testToken(ctx.env, { sub })), payload: { type, lat: site.lat, lng: site.lng } });

        // DE (full): as before - created, then merged, with the camera
        const created = await post("a", BERLIN);
        const merged = await post("b", near(BERLIN, 100));
        expect([created.statusCode, merged.statusCode]).toEqual([201, 200]);
        expect(merged.json()).toMatchObject({ merged: true, camera: { id: created.json().camera.id } });

        // FR (zones) and CH (off): 202, the same body for new and merged, no merged flag, no camera
        for (const [site, withZone] of [[PARIS, true], [ZURICH, false]] as const) {
          const first = await post("c", site);
          const second = await post("d", near(site, 100));
          expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
          expect(second.json()).toEqual(first.json());
          expect(first.json().accepted).toBe(true);
          expect(first.json()).not.toHaveProperty("merged");
          expect(first.json()).not.toHaveProperty("camera");
          expect(first.json().zone !== undefined).toBe(withZone);
          if (withZone) expect(first.json().zone.cell).toBe(cellOf(site));
        }
        // probing a country that is off at 800 m spacing tells nothing: every answer is the same
        const probes = [];
        for (const metres of [0, 800, 1600, 2400]) probes.push((await post(`p${metres}`, near(ZURICH, 5000 + metres), "redLightCamera")).json());
        expect(new Set(probes.map((p) => JSON.stringify(p))).size).toBe(1);

        // but everything was stored: three devices (the duplicates merged) and the four distinct live reports
        const devices = await testDb.db.execute<{ n: number } & Record<string, unknown>>(sql`select count(*)::int as n from fixed_speed_cameras`);
        expect(devices[0]!.n).toBe(3);
        const reports = await testDb.db.execute<{ n: number } & Record<string, unknown>>(sql`select count(*)::int as n from hazard_reports where type = 'redLightCamera'`);
        expect(reports[0]!.n).toBe(4);
      });
    });

    it("confirmations and removal reports on a camera show the camera only where it is delivered individually", async () => {
      await reset();
      await withApp({ DE: "full", CH: "off" }, async (ctx) => {
        const insertDevice = async (site: Site, countries: string[]) =>
          (await testDb.db.execute<{ id: string } & Record<string, unknown>>(sql`
            insert into fixed_speed_cameras (position, countries, source)
            values (ST_SetSRID(ST_MakePoint(${site.lng}, ${site.lat}), 4326), ${pgArray(countries)}::text[], 'test') returning id`))[0]!.id;
        const berlinId = await insertDevice(BERLIN, ["DE"]);
        const zurichId = await insertDevice(ZURICH, ["CH"]);
        const removal = async (id: string, sub: string) =>
          ctx.app.inject({ method: "POST", url: `/v1/speed-cameras/${id}/removal-reports`, headers: authHeader(await testToken(ctx.env, { sub })) });

        const inGermany = (await removal(berlinId, "r1")).json();
        expect(inGermany).toMatchObject({ recorded: true, removed: false, camera: { id: berlinId } });
        const inSwitzerland = (await removal(zurichId, "r1")).json();
        expect(inSwitzerland).toEqual({ recorded: true, removed: false }); // recorded all the same, but no camera object
        expect((await removal(zurichId, "r2")).json()).toEqual({ recorded: true, removed: true });

        // a live camera report: the same split for confirmations
        const report = async (site: Site, sub: string) => {
          await ctx.app.inject({ method: "POST", url: "/v1/hazard-reports", headers: authHeader(await testToken(ctx.env, { sub })), payload: { type: "trailerCamera", lat: site.lat, lng: site.lng } });
          return (await testDb.db.execute<{ id: string } & Record<string, unknown>>(sql`select id from hazard_reports where type = 'trailerCamera' order by reported_at desc limit 1`))[0]!.id;
        };
        const confirm = async (id: string, sub: string) =>
          ctx.app.inject({ method: "POST", url: `/v1/hazard-reports/${id}/confirmations`, headers: authHeader(await testToken(ctx.env, { sub })), payload: { kind: "stillThere" } });
        const berlinReport = await report(near(BERLIN, 3000), "c1");
        const confirmedInGermany = (await confirm(berlinReport, "c2")).json();
        expect(confirmedInGermany).toMatchObject({ recorded: true, report: { id: berlinReport, type: "trailerCamera" } });
        const zurichReport = await report(near(ZURICH, 3000), "c3");
        expect((await confirm(zurichReport, "c4")).json()).toEqual({ recorded: true });
        // an ordinary hazard is unaffected, whatever the country
        await ctx.app.inject({ method: "POST", url: "/v1/hazard-reports", headers: authHeader(await testToken(ctx.env, { sub: "c5" })), payload: { type: "ice", lat: ZURICH.lat, lng: ZURICH.lng } });
        const ice = (await testDb.db.execute<{ id: string } & Record<string, unknown>>(sql`select id from hazard_reports where type = 'ice'`))[0]!.id;
        expect((await confirm(ice, "c6")).json()).toMatchObject({ recorded: true, report: { id: ice } });
      });
    });
  });

  // ------------------------------------------------------------------ the delta cursor

  describe("the delta cursor moves over events the client may not see", () => {
    it("pages through withheld camera events to the end instead of asking for the same page forever", async () => {
      await reset();
      await withApp({ DE: "full" }, async (ctx) => {
        for (let i = 0; i < 9; i++) {
          const site = near(ZURICH, 1000 * (i + 1)); // CH is not released: every camera event is withheld
          await ctx.app.inject({
            method: "POST",
            url: "/v1/hazard-reports",
            headers: authHeader(await testToken(ctx.env, { sub: `u${i}` })),
            payload: { type: "mobileSpeedCamera", lat: site.lat, lng: site.lng, speedKmh: 60 },
          });
        }
        await ctx.app.inject({
          method: "POST",
          url: "/v1/hazard-reports",
          headers: authHeader(await testToken(ctx.env, { sub: "visible" })),
          payload: { type: "traffic", lat: BERLIN.lat, lng: BERLIN.lng },
        });
        const tiles = [cellOf(BERLIN, 7), cellOf(ZURICH, 7)].join(",");
        let since = 0;
        let delivered: Json[] = [];
        let pages = 0;
        for (;;) {
          const page = await ctx.get(`/v1/delta?since=${since}&limit=3&tiles=${tiles}`);
          pages++;
          delivered = delivered.concat(page.events);
          if (page.nextSince !== null) {
            expect(page.nextSince).toBeGreaterThanOrEqual(since);
            since = page.nextSince;
          }
          if (!page.hasMore) break;
          expect(pages).toBeLessThan(20);
        }
        expect(delivered.map((e) => e.payload.type)).toEqual(["traffic"]);
        expect(pages).toBeGreaterThan(1);
      });
    });
  });

  // ------------------------------------------------------------------ WebSocket

  describe("WebSocket push", () => {
    it("pushes a camera event as it is at level full, as a zone event at zones, and not at all at off", async () => {
      await reset();
      const { app, env } = await startApp({ DE: "full", FR: "zones" });
      try {
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        if (typeof address !== "object" || address === null) throw new Error("no address");
        const token = await testToken(env);

        const connect = (): Promise<WebSocket> =>
          new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws`);
            ws.once("open", () => resolve(ws));
            ws.once("error", reject);
          });
        const messages: Json[] = [];
        const ws = await connect();
        ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
        ws.send(JSON.stringify({ type: "auth", token }));
        const regionOf = (p: Site) => cellOf(p, env.REGION_TILE_H3_RESOLUTION);
        // the Lyon cell: subscribe to a sibling tile of the one the camera will be in
        const lyonOwn = regionOf(LYON);
        const lyonSibling = cellToChildren(cellOf(LYON), 7).find((t) => t !== lyonOwn)!;
        for (const tile of [regionOf(BERLIN), lyonSibling, regionOf(ZURICH)]) ws.send(JSON.stringify({ type: "subscribe", tile, k: 0 }));
        const until = async (predicate: () => boolean, ms = 3000) => {
          const deadline = Date.now() + ms;
          while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
        };
        await until(() => messages.some((m) => m.type === "auth_ok"));

        const post = async (sub: string, site: Site) =>
          fetch(`http://127.0.0.1:${address.port}/v1/hazard-reports`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${await testToken(env, { sub })}` },
            body: JSON.stringify({ type: "mobileSpeedCamera", lat: site.lat, lng: site.lng, speedKmh: 70 }),
          });
        await post("w1", BERLIN); // DE full
        await post("w2", LYON); // FR zones
        await post("w3", ZURICH); // CH off
        await until(() => messages.filter((m) => m.type === "event").length >= 2);
        await new Promise((r) => setTimeout(r, 400)); // room for an event that must NOT come
        ws.close();

        const events = messages.filter((m) => m.type === "event").map((m) => m.event as Json);
        expect(events).toHaveLength(2);
        const full = events.find((e) => e.entityType === "hazardReport")!;
        expect(full.payload.type).toBe("mobileSpeedCamera");
        expect(full.cameraCountries).toBeUndefined(); // the internal country set never goes out
        const zone = events.find((e) => e.entityType === "cameraZone")!;
        expect(zone.payload.cell).toBe(cellOf(LYON));
        expect(zone.type).toBe("StaticDataUpdated");
        expect(JSON.stringify(zone)).not.toContain(String(LYON.lat));
        expect(JSON.stringify(zone)).not.toContain("w2");
        expect(events.some((e) => JSON.stringify(e).includes(String(ZURICH.lat)))).toBe(false);
      } finally {
        await stop(app);
      }
    }, 60_000);
  });

  // ------------------------------------------------------------------ GET /v1/config

  describe("GET /v1/config", () => {
    it("tells clients the policy that applies, with a version that changes exactly when it does", async () => {
      await withApp({ DE: "full", FR: "zones", CH: "off" }, async (ctx) => {
        const config = await ctx.get("/v1/config");
        expect(config.speedCameraNamespaceEnabled).toBe(true);
        expect(config.cameraPolicy).toMatchObject({
          namespaceEnabled: true,
          defaultLevel: "off",
          byCountry: { DE: "full", FR: "zones" },
          zoneResolution: ZONE_RES,
        });
        expect(typeof config.cameraPolicy.version).toBe("string");
        expect(config.cameraPolicy.notice.version).toBe(1);
        expect(config.cameraPolicy.notice.text.de).toContain("Beifahrer");
        expect(config.cameraPolicy.notice.text.en).toContain("passengers");
        const again = await ctx.get("/v1/config");
        expect(again.cameraPolicy.version).toBe(config.cameraPolicy.version);
        ctx.policy.write({ DE: "full", FR: "zones", CH: "off", AT: "off" }); // listing a country as off changes nothing that is delivered
        await ctx.app.cameraPolicy.reload();
        expect((await ctx.get("/v1/config")).cameraPolicy.version).toBe(config.cameraPolicy.version);
        ctx.policy.write({ DE: "full", FR: "full", CH: "off" });
        await ctx.app.cameraPolicy.reload();
        expect((await ctx.get("/v1/config")).cameraPolicy.version).not.toBe(config.cameraPolicy.version);
      });
    });
  });

  // ------------------------------------------------------------------ federation egress

  describe("federation does not carry a camera out of a country that is not delivered individually", () => {
    it("GET /v1/federation/events lists device-signed camera reports of full countries only", async () => {
      await reset();
      const federationEnv = { FEDERATION_ENABLED: "true", FEDERATION_PUBLIC_ADDRESS: "http://127.0.0.1:18899" };
      await withApp({ DE: "full", FR: "zones", CH: "off" }, async (ctx) => {
        const signedReport = (site: Site, type: string) => {
          const device = generateEd25519KeyPair();
          const envelope = signEnvelope(
            { kind: "create" as const, type, lat: site.lat, lng: site.lng, devicePublicKey: device.publicKeyRaw, timestamp: new Date().toISOString() },
            device,
          );
          return { type, lat: site.lat, lng: site.lng, deviceAssertion: envelope };
        };
        const submit = async (sub: string, body: Json) =>
          ctx.app.inject({ method: "POST", url: "/v1/hazard-reports", headers: authHeader(await testToken(ctx.env, { sub })), payload: body });
        expect((await submit("f1", signedReport(BERLIN, "mobileSpeedCamera"))).statusCode).toBe(201);
        expect((await submit("f2", signedReport(PARIS, "mobileSpeedCamera"))).statusCode).toBe(202);
        expect((await submit("f3", signedReport(ZURICH, "mobileSpeedCamera"))).statusCode).toBe(202);
        expect((await submit("f4", signedReport(BERLIN, "ice"))).statusCode).toBe(201);
        expect((await submit("f5", signedReport(ZURICH, "ice"))).statusCode).toBe(201);

        const pulled = (await ctx.app.inject({ method: "GET", url: "/v1/federation/events?after=0&limit=100" })).json() as Json;
        const lats = (pulled.events as Json[]).map((e) => `${e.envelope.payload.type}@${e.envelope.payload.lat}`).sort();
        expect(lats).toEqual([`ice@${BERLIN.lat}`, `ice@${ZURICH.lat}`, `mobileSpeedCamera@${BERLIN.lat}`].sort());
        // the cursor advanced over the withheld events: asking again after it returns nothing new and does not loop
        expect(pulled.nextAfter).toBeGreaterThan(0);
        const next = (await ctx.app.inject({ method: "GET", url: `/v1/federation/events?after=${pulled.nextAfter}&limit=100` })).json() as Json;
        expect(next.events).toEqual([]);
      }, federationEnv);
    });
  });
});
