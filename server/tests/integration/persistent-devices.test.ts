import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { latLngToCell } from "h3-js";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { ENTITY_TYPES, PERSISTENT_CAMERA_TYPES } from "../../src/config/constants.js";
import { runExpirySweep } from "../../src/modules/expiry/worker.js";
import { serializePartition } from "../../src/modules/static-data/partitions.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { createPolicyFixture, loadBoundaries, WORLD_AS_DE, type PolicyFixture } from "./camera-policy-helper.js";

/**
 * Persistent enforcement devices (add-on D, docs/persistent-enforcement-devices.md): red-light and
 * distance devices live in fixed_speed_cameras next to the speed cameras, never expire, and reach clients
 * additively — `cameraType`, `enforcementDevices`, package key, `enforcementDevice` events.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BERLIN = { lat: 52.52, lng: 13.405 };
const MUNICH = { lat: 48.137, lng: 11.575 };
const HAMBURG = { lat: 53.55, lng: 9.99 };
const RES = 4;

describe("persistent enforcement devices (add-on D)", () => {
  let testDb: TestDatabase;
  let policy: PolicyFixture;
  const dirs: string[] = [];
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    testDb = await startTestDatabase();
    // One synthetic country covers every coordinate here; the signed policy releases it (the persistent devices are
    // delivered individually where a country is at level `full`).
    policy = createPolicyFixture();
    await loadBoundaries(testDb.db, WORLD_AS_DE);
    policy.write({ DE: "full" });
  }, 90_000);

  afterAll(async () => {
    for (const app of apps) await app.close();
    policy.cleanup();
    await testDb.teardown();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  async function startApp(overrides: Record<string, string> = {}): Promise<{ app: FastifyInstance; env: Env }> {
    const dir = mkdtempSync(path.join(tmpdir(), "persistent-devices-"));
    dirs.push(dir);
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      LOG_LEVEL: "silent",
      ...policy.env(),
      CAMERA_REMOVAL_THRESHOLD: "2",
      DUPLICATE_MERGE_RADIUS_METERS: "500",
      STATIC_DATA_PARTITION_H3_RESOLUTION: String(RES),
      STATIC_PACKAGES_DIR: dir,
      STATIC_PACKAGES_PAGE_ROWS: "7",
      STATIC_PACKAGES_GZIP_LEVEL: "4",
      STATIC_PACKAGES_BROTLI_QUALITY: "3",
      ...overrides,
    });
    const app = await buildApp({ env, db: testDb.db });
    apps.push(app);
    return { app, env };
  }

  async function reset() {
    await testDb.db.execute(sql`
      truncate table camera_removal_reports, fixed_speed_cameras, static_signs, speed_limit_segments,
      hazard_confirmations, hazard_reports, event_log, static_packages restart identity cascade
    `);
    await testDb.db.execute(sql`update static_package_state set ready = false, fingerprint = null, built_version = 0, lease_owner = null, lease_until = null`);
    await testDb.db.execute(sql`update static_data_state set version = 1`);
  }

  const get = async (app: FastifyInstance, env: Env, url: string) =>
    app.inject({ method: "GET", url, headers: authHeader(await testToken(env)) });

  async function importDevices(app: FastifyInstance, env: Env, rows: Json[]) {
    return app.inject({
      method: "POST",
      url: "/v1/bulk-import/speed-cameras",
      headers: authHeader(await testToken(env, { scopes: ["bulk-import"] })),
      payload: { rows },
    });
  }

  const row = (p: { lat: number; lng: number }, cameraType?: string, extra: Json = {}) => ({
    lat: p.lat,
    lng: p.lng,
    ...(cameraType ? { cameraType } : {}),
    source: "osm-test",
    sourceLicense: "ODbL",
    ...extra,
  });

  const near = (p: { lat: number; lng: number }, meters = 0) => ({ lat: p.lat + meters / 111_000, lng: p.lng });

  // ------------------------------------------------------------------ schema

  it("keeps the TypeScript constants and the database labels in step", async () => {
    await reset();
    const labels = await testDb.db.execute<{ l: string } & Record<string, unknown>>(sql`select unnest(enum_range(null::camera_type))::text as l`);
    expect(labels.map((r) => r.l)).toEqual([...PERSISTENT_CAMERA_TYPES]);
    const entities = await testDb.db.execute<{ l: string } & Record<string, unknown>>(sql`select unnest(enum_range(null::entity_type))::text as l`);
    expect(entities.map((r) => r.l)).toEqual([...ENTITY_TYPES]);
    // Every persistent kind is also a hazard type: a client that decodes `type` into that enum handles it.
    const hazardLabels = await testDb.db.execute<{ l: string } & Record<string, unknown>>(sql`select unnest(enum_range(null::hazard_type))::text as l`);
    for (const kind of PERSISTENT_CAMERA_TYPES) expect(hazardLabels.map((r) => r.l)).toContain(kind);
  });

  // ------------------------------------------------------------------ import

  it("imports each device kind, defaults to a speed camera, and rejects an unknown kind", async () => {
    await reset();
    const { app, env } = await startApp();

    const res = await importDevices(app, env, [
      row(BERLIN),
      row(near(BERLIN, 300), "redLightCamera"),
      row(MUNICH, "distanceControl"),
      row(HAMBURG, "fixedSpeedCamera"),
    ]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().inserted).toBe(4);

    const stored = await testDb.db.execute<{ camera_type: string; n: number } & Record<string, unknown>>(
      sql`select camera_type, count(*)::int as n from fixed_speed_cameras group by camera_type order by camera_type`,
    );
    // Enum order: speed cameras, red-light, distance.
    expect(stored.map((r) => [r.camera_type, r.n])).toEqual([["fixedSpeedCamera", 2], ["redLightCamera", 1], ["distanceControl", 1]]);

    const unknown = await importDevices(app, env, [row(BERLIN, "averageSpeedCheck")]);
    expect(unknown.statusCode).toBe(400);
    const none = await testDb.db.execute<{ n: number } & Record<string, unknown>>(sql`select count(*)::int as n from fixed_speed_cameras`);
    expect(none[0]!.n).toBe(4);
  });

  // ------------------------------------------------------------------ reads

  describe("reads", () => {
    it("serves every kind from nearby with `cameraType`, filters by `types`, and keeps `type` equal to it", async () => {
      await reset();
      const { app, env } = await startApp();
      await importDevices(app, env, [row(BERLIN), row(near(BERLIN, 200), "redLightCamera"), row(near(BERLIN, 400), "distanceControl")]);
      const q = `lat=${BERLIN.lat}&lng=${BERLIN.lng}&radiusM=2000`;

      const all = (await get(app, env, `/v1/speed-cameras/nearby?${q}`)).json().cameras as Json[];
      expect(all.map((c) => c.cameraType).sort()).toEqual(["distanceControl", "fixedSpeedCamera", "redLightCamera"]);
      for (const c of all) {
        expect(c.type).toBe(c.cameraType);
        expect(c.status).toBe("active");
      }

      const only = async (types: string) => ((await get(app, env, `/v1/speed-cameras/nearby?${q}&types=${types}`)).json().cameras as Json[]).map((c) => c.cameraType);
      expect(await only("fixedSpeedCamera")).toEqual(["fixedSpeedCamera"]);
      expect(await only("redLightCamera")).toEqual(["redLightCamera"]);
      expect(await only("redLightCamera,distanceControl")).toHaveLength(2);
      expect(await only("mobileSpeedCamera")).toEqual([]);
    });

    it("a `types` filter for red-light returns the persistent device and the expiring report side by side", async () => {
      await reset();
      const { app, env } = await startApp();
      await importDevices(app, env, [row(BERLIN, "redLightCamera")]);
      const report = await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: authHeader(await testToken(env, { sub: "alice" })),
        payload: { type: "redLightCamera", lat: BERLIN.lat, lng: BERLIN.lng },
      });
      expect(report.statusCode).toBe(201);
      expect(report.json().report.expiresAt).toBeTruthy(); // still an expiring report, never a persistent device

      const cameras = (await get(app, env, `/v1/speed-cameras/nearby?lat=${BERLIN.lat}&lng=${BERLIN.lng}&radiusM=1000&types=redLightCamera`)).json().cameras as Json[];
      expect(cameras).toHaveLength(2);
      const persistent = cameras.find((c) => c.cameraType === "redLightCamera")!;
      const expiring = cameras.find((c) => c.cameraType === undefined)!;
      expect(persistent.expiresAt).toBeUndefined();
      expect(expiring.expiresAt).toBeTruthy();
      expect(expiring.type).toBe("redLightCamera");
    });

    it("by-tile returns persistent devices of the new kinds inside the tile, never the speed cameras, and nothing from another tile", async () => {
      await reset();
      const { app, env } = await startApp();
      const redLight = near(BERLIN, 100);
      await importDevices(app, env, [row(BERLIN), row(redLight, "redLightCamera"), row(MUNICH, "distanceControl")]);
      const tile = latLngToCell(redLight.lat, redLight.lng, env.REGION_TILE_H3_RESOLUTION);

      const here = (await get(app, env, `/v1/speed-cameras/by-tile?tile=${tile}`)).json().cameras as Json[];
      expect(here.map((c) => c.cameraType)).toEqual(["redLightCamera"]);
      // Speed cameras were never tile-partitioned: still not here, even when asked for by name.
      expect((await get(app, env, `/v1/speed-cameras/by-tile?tile=${tile}&types=fixedSpeedCamera`)).json().cameras).toEqual([]);
      // A ring of neighbours around Munich's tile reaches Munich's device, not Berlin's.
      const munichTile = latLngToCell(MUNICH.lat, MUNICH.lng, env.REGION_TILE_H3_RESOLUTION);
      const munich = (await get(app, env, `/v1/speed-cameras/by-tile?tile=${munichTile}&k=2`)).json().cameras as Json[];
      expect(munich.map((c) => c.cameraType)).toEqual(["distanceControl"]);
      expect((await get(app, env, `/v1/speed-cameras/by-tile?tile=${munichTile}&types=redLightCamera`)).json().cameras).toEqual([]);
    });

    it("the snapshot keeps `fixedSpeedCameras` to the speed cameras and lists every device in `enforcementDevices`", async () => {
      await reset();
      const { app, env } = await startApp();
      await importDevices(app, env, [row(BERLIN), row(near(BERLIN, 300), "redLightCamera"), row(MUNICH, "distanceControl")]);

      const snapshot = (await get(app, env, "/v1/snapshot")).json() as Json;
      expect(snapshot.fixedSpeedCameras.map((c: Json) => c.cameraType)).toEqual(["fixedSpeedCamera"]);
      expect(snapshot.enforcementDevices.map((c: Json) => c.cameraType).sort()).toEqual(["distanceControl", "fixedSpeedCamera", "redLightCamera"]);

      const withoutStatic = (await get(app, env, "/v1/snapshot?staticData=false")).json() as Json;
      expect(withoutStatic.fixedSpeedCameras).toEqual([]);
      expect(withoutStatic.enforcementDevices).toEqual([]);
    });

    it("advertises the kinds in /v1/config, the hint a client uses to tell a server that knows them", async () => {
      const { app, env } = await startApp();
      expect((await get(app, env, "/v1/config")).json().persistentCameraTypes).toEqual([...PERSISTENT_CAMERA_TYPES]);
    });
  });

  // ------------------------------------------------------------------ lifecycle

  it("never expires: after every expiry window has passed the device is still served, the expiring report is not", async () => {
    await reset();
    const { app, env } = await startApp();
    await importDevices(app, env, [row(BERLIN, "redLightCamera"), row(near(BERLIN, 200), "distanceControl")]);
    const report = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: authHeader(await testToken(env, { sub: "alice" })),
      payload: { type: "redLightCamera", lat: near(BERLIN, 900).lat, lng: BERLIN.lng },
    });
    expect(report.statusCode).toBe(201);

    // Move every timestamp 400 days into the past — the same as moving the clock 400 days forward, longer than any expiry band.
    await testDb.db.execute(sql`update hazard_reports set expires_at = expires_at - interval '400 days', reported_at = reported_at - interval '400 days'`);
    await testDb.db.execute(sql`update fixed_speed_cameras set imported_at = imported_at - interval '400 days'`);
    const events = await runExpirySweep(testDb.db);
    expect(events).toHaveLength(1);
    expect(events[0]!.entityType).toBe("hazardReport");

    const cameras = (await get(app, env, `/v1/speed-cameras/nearby?lat=${BERLIN.lat}&lng=${BERLIN.lng}&radiusM=2000`)).json().cameras as Json[];
    expect(cameras.map((c) => c.cameraType).sort()).toEqual(["distanceControl", "redLightCamera"]);
    const snapshot = (await get(app, env, "/v1/snapshot")).json() as Json;
    expect(snapshot.enforcementDevices).toHaveLength(2);
  });

  it("is removed like a speed camera — distinct removal reports up to the threshold — and announced as an `enforcementDevice` event", async () => {
    await reset();
    const { app, env } = await startApp();
    await importDevices(app, env, [row(BERLIN, "redLightCamera")]);
    const id = (await testDb.db.execute<{ id: string } & Record<string, unknown>>(sql`select id from fixed_speed_cameras`))[0]!.id;
    const report = async (sub: string) =>
      app.inject({ method: "POST", url: `/v1/speed-cameras/${id}/removal-reports`, headers: authHeader(await testToken(env, { sub })) });

    const first = await report("bob");
    expect(first.json()).toMatchObject({ recorded: true, removed: false });
    expect((await report("bob")).json()).toMatchObject({ recorded: false, removed: false });
    const second = await report("carol");
    expect(second.json()).toMatchObject({ removed: true });
    expect(second.json().camera).toMatchObject({ status: "removed", cameraType: "redLightCamera" });

    const events = await testDb.db.execute<{ type: string; entity_type: string } & Record<string, unknown>>(sql`select type, entity_type from event_log order by sequence`);
    expect(events.map((e) => [e.type, e.entity_type])).toEqual([["StaticDataRemoved", "enforcementDevice"]]);

    // Delta: visible when the kind is requested (or nothing is), not when only speed cameras are.
    const delta = async (types = "") => ((await get(app, env, `/v1/delta?since=0${types}`)).json().events as Json[]).map((e) => e.entityType);
    expect(await delta()).toEqual(["enforcementDevice"]);
    expect(await delta("&types=redLightCamera")).toEqual(["enforcementDevice"]);
    expect(await delta("&types=fixedSpeedCamera")).toEqual([]);
    expect((await get(app, env, `/v1/speed-cameras/nearby?lat=${BERLIN.lat}&lng=${BERLIN.lng}&radiusM=1000`)).json().cameras).toEqual([]);
  });

  it("a speed-camera removal is still announced as `fixedSpeedCamera`, exactly as before", async () => {
    await reset();
    const { app, env } = await startApp();
    await importDevices(app, env, [row(BERLIN)]);
    const id = (await testDb.db.execute<{ id: string } & Record<string, unknown>>(sql`select id from fixed_speed_cameras`))[0]!.id;
    for (const sub of ["bob", "carol"]) {
      await app.inject({ method: "POST", url: `/v1/speed-cameras/${id}/removal-reports`, headers: authHeader(await testToken(env, { sub })) });
    }
    const events = await testDb.db.execute<{ entity_type: string } & Record<string, unknown>>(sql`select entity_type from event_log`);
    expect(events.map((e) => e.entity_type)).toEqual(["fixedSpeedCamera"]);
  });

  it("a community speed-camera report next to a red-light device is a new camera, not a merge into the device", async () => {
    await reset();
    const { app, env } = await startApp();
    await importDevices(app, env, [row(BERLIN, "redLightCamera")]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: authHeader(await testToken(env, { sub: "alice" })),
      payload: { type: "fixedSpeedCamera", lat: near(BERLIN, 20).lat, lng: BERLIN.lng },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().merged).toBe(false);
    expect(res.json().camera.cameraType).toBe("fixedSpeedCamera");
    const kinds = await testDb.db.execute<{ camera_type: string } & Record<string, unknown>>(sql`select camera_type from fixed_speed_cameras order by camera_type`);
    expect(kinds.map((k) => k.camera_type)).toEqual(["fixedSpeedCamera", "redLightCamera"]);

    // ...and a second speed-camera report at the same spot still merges into the speed camera.
    const again = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: authHeader(await testToken(env, { sub: "bob" })),
      payload: { type: "fixedSpeedCamera", lat: near(BERLIN, 40).lat, lng: BERLIN.lng },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().merged).toBe(true);
    expect(again.json().camera.id).toBe(res.json().camera.id);
  });

  // ------------------------------------------------------------------ flag off

  it("with the namespace flag off nothing of any kind is delivered, while writes still work", async () => {
    await reset();
    const { app, env } = await startApp({ SPEED_CAMERA_NAMESPACE_ENABLED: "false" });
    const imported = await importDevices(app, env, [row(BERLIN), row(near(BERLIN, 100), "redLightCamera"), row(MUNICH, "distanceControl")]);
    expect(imported.statusCode).toBe(200);
    const report = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: authHeader(await testToken(env, { sub: "alice" })),
      payload: { type: "fixedSpeedCamera", lat: HAMBURG.lat, lng: HAMBURG.lng },
    });
    // Accepted, but the answer does not show the camera (the brake is on: nothing of it may be disclosed).
    expect(report.statusCode).toBe(202);
    expect(report.json()).toEqual({ accepted: true });
    const id = (await testDb.db.execute<{ id: string } & Record<string, unknown>>(sql`select id from fixed_speed_cameras where camera_type = 'redLightCamera'`))[0]!.id;
    for (const sub of ["bob", "carol"]) {
      await app.inject({ method: "POST", url: `/v1/speed-cameras/${id}/removal-reports`, headers: authHeader(await testToken(env, { sub })) });
    }

    const tile = latLngToCell(BERLIN.lat, BERLIN.lng, env.REGION_TILE_H3_RESOLUTION);
    expect((await get(app, env, `/v1/speed-cameras/nearby?lat=${BERLIN.lat}&lng=${BERLIN.lng}&radiusM=5000`)).json()).toEqual({ cameras: [], zones: [] });
    expect((await get(app, env, `/v1/speed-cameras/by-tile?tile=${tile}&k=3`)).json()).toEqual({ cameras: [], zones: [] });
    const snapshot = (await get(app, env, "/v1/snapshot")).json() as Json;
    expect(snapshot.fixedSpeedCameras).toEqual([]);
    expect(snapshot.enforcementDevices).toEqual([]);
    expect(snapshot.cameraZones).toEqual([]);
    const delta = (await get(app, env, "/v1/delta?since=0")).json().events as Json[];
    expect(delta.filter((e) => e.entityType === "fixedSpeedCamera" || e.entityType === "enforcementDevice")).toEqual([]);
    expect((await get(app, env, "/v1/static-data/manifest")).json().partitions).toEqual([]);
  });

  // ------------------------------------------------------------------ packages

  describe("static packages", () => {
    const partition = async (app: FastifyInstance, env: Env, tile: string) =>
      (await get(app, env, `/v1/static-data/partitions/${tile}`)).json() as Json;

    it("carries the devices of a tile in `enforcementDevices`, marks the tile when a device is imported, and leaves a tile without devices as it was", async () => {
      await reset();
      const { app, env } = await startApp();
      const berlin = latLngToCell(BERLIN.lat, BERLIN.lng, RES);
      const munich = latLngToCell(MUNICH.lat, MUNICH.lng, RES);
      const hamburg = latLngToCell(HAMBURG.lat, HAMBURG.lng, RES);
      expect(new Set([berlin, munich, hamburg]).size).toBe(3);

      await importDevices(app, env, [row(BERLIN), row(near(BERLIN, 300), "redLightCamera")]);
      await app.inject({
        method: "POST",
        url: "/v1/bulk-import/static-signs",
        headers: authHeader(await testToken(env, { scopes: ["bulk-import"] })),
        payload: { rows: [{ lat: HAMBURG.lat, lng: HAMBURG.lng, signType: "DE:274", source: "osm-test" }] },
      });

      const manifest = (await get(app, env, "/v1/static-data/manifest")).json() as Json;
      expect(manifest.partitions.map((p: Json) => p.tile).sort()).toEqual([berlin, hamburg].sort());

      const b = await partition(app, env, berlin);
      expect(b.fixedSpeedCameras.map((c: Json) => c.cameraType)).toEqual(["fixedSpeedCamera"]);
      expect(b.enforcementDevices.map((c: Json) => c.cameraType).sort()).toEqual(["fixedSpeedCamera", "redLightCamera"]);
      expect(Object.keys(b)).toEqual(["tile", "speedLimitSegments", "staticSigns", "fixedSpeedCameras", "enforcementDevices"]);

      // A tile with no device has no such key, and its hash is the one the old shape produced.
      const h = await partition(app, env, hamburg);
      expect(Object.keys(h)).toEqual(["tile", "speedLimitSegments", "staticSigns", "fixedSpeedCameras"]);
      const listed = manifest.partitions.find((p: Json) => p.tile === hamburg);
      const reference = serializePartition({ tile: hamburg, speedLimitSegments: [], staticSigns: h.staticSigns, fixedSpeedCameras: [] });
      expect(listed.hash).toBe(reference.hash);
      expect(listed.hash).toBe(createHash("sha256").update(JSON.stringify(h)).digest("hex"));

      // Importing a device into a so-far empty tile marks that tile: it appears with its device on the next request.
      const before = manifest.staticDataVersion as number;
      await importDevices(app, env, [row(MUNICH, "distanceControl")]);
      const after = (await get(app, env, "/v1/static-data/manifest")).json() as Json;
      expect(after.staticDataVersion).toBeGreaterThan(before);
      expect(after.partitions.map((p: Json) => p.tile)).toContain(munich);
      const m = await partition(app, env, munich);
      expect(m.fixedSpeedCameras).toEqual([]);
      expect(m.enforcementDevices.map((c: Json) => c.cameraType)).toEqual(["distanceControl"]);
    });

    it("leaves the devices out while the flag is off, and a tile that holds nothing else is not listed", async () => {
      await reset();
      const { app, env } = await startApp({ SPEED_CAMERA_NAMESPACE_ENABLED: "false" });
      await importDevices(app, env, [row(BERLIN, "redLightCamera")]);
      expect((await get(app, env, "/v1/static-data/manifest")).json().partitions).toEqual([]);
    });
  });
});
