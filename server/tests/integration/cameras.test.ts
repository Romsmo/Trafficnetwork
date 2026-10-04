import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";

const JWT_SECRET = "a".repeat(32);
const JWT_TTL_SECONDS = 3600;
const tokenCache: Record<string, { authorization: string }> = {};
async function tokenFor(name: string) {
  if (!tokenCache[name]) tokenCache[name] = authHeader(await testToken({ JWT_SECRET, JWT_TTL_SECONDS }, { sub: name }));
  return tokenCache[name];
}

describe("speed-camera namespace", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await startTestDatabase();
  });

  afterEach(async () => {
    await testDb.db.execute(sql`
      truncate table camera_removal_reports, fixed_speed_cameras, hazard_confirmations,
      hazard_reports, event_log restart identity cascade
    `);
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  async function buildTestApp(overrides: Record<string, string> = {}) {
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET,
      DUPLICATE_MERGE_RADIUS_METERS: "500",
      CAMERA_REMOVAL_THRESHOLD: "2",
      ...overrides,
    });
    return buildApp({ env, db: testDb.db });
  }

  describe("emergency brake on (SPEED_CAMERA_NAMESPACE_ENABLED=false)", () => {
    let app: FastifyInstance;
    beforeAll(async () => {
      app = await buildTestApp({ SPEED_CAMERA_NAMESPACE_ENABLED: "false" });
    });
    afterAll(async () => app.close());

    it("still accepts a fixedSpeedCamera report (writes are never gated) - and answers without the camera", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: await tokenFor("alice"),
        payload: { type: "fixedSpeedCamera", lat: 52.52, lng: 13.405 },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ accepted: true });
      const stored = await testDb.db.execute<{ n: number } & Record<string, unknown>>(sql`select count(*)::int as n from fixed_speed_cameras`);
      expect(stored[0]!.n).toBe(1);
    });

    it("hides the camera from every read surface (nearby, by-tile, snapshot, delta)", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: await tokenFor("alice"),
        payload: { type: "fixedSpeedCamera", lat: 52.52, lng: 13.405 },
      });
      await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: await tokenFor("bob"),
        payload: { type: "mobileSpeedCamera", lat: 52.52, lng: 13.405, speedKmh: 90 },
      });

      const auth = await tokenFor("alice");
      const nearby = await app.inject({ method: "GET", url: "/v1/speed-cameras/nearby?lat=52.52&lng=13.405&radiusM=1000", headers: auth });
      expect(nearby.json()).toEqual({ cameras: [], zones: [] });

      const hazardNearby = await app.inject({ method: "GET", url: "/v1/hazard-reports/nearby?lat=52.52&lng=13.405&radiusM=1000", headers: auth });
      expect(hazardNearby.json().reports).toEqual([]);

      const snapshot = await app.inject({ method: "GET", url: "/v1/snapshot", headers: auth });
      expect(snapshot.json().fixedSpeedCameras).toEqual([]);
      expect(snapshot.json().cameraZones).toEqual([]);

      const delta = await app.inject({ method: "GET", url: "/v1/delta?since=0", headers: auth });
      const payloadTypes = delta.json().events.map((e: { payload: { type?: string } }) => e.payload.type);
      expect(payloadTypes).not.toContain("mobileSpeedCamera");
      expect(payloadTypes).not.toContain("fixedSpeedCamera");
    });
  });

  describe("default (cameras are delivered in full in every country)", () => {
    let app: FastifyInstance;
    beforeAll(async () => {
      app = await buildTestApp();
    });
    afterAll(async () => app.close());

    it("merges a second nearby fixedSpeedCamera report instead of creating a duplicate", async () => {
      const first = await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: await tokenFor("alice"),
        payload: { type: "fixedSpeedCamera", lat: 52.52, lng: 13.405 },
      });
      const second = await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: await tokenFor("bob"),
        payload: { type: "fixedSpeedCamera", lat: 52.5209, lng: 13.405 },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().merged).toBe(true);
      expect(second.json().camera.id).toBe(first.json().camera.id);

      const events = await testDb.db.execute<{ type: string } & Record<string, unknown>>(
        sql`select type from event_log where entity_id = ${first.json().camera.id} order by sequence asc`,
      );
      expect(events.map((e) => e.type)).toEqual(["StaticDataUpdated", "StaticDataUpdated"]);
    });

    it("removes a fixed camera once distinct removal reports reach the threshold", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: await tokenFor("alice"),
        payload: { type: "fixedSpeedCamera", lat: 60, lng: 10 },
      });
      const id = created.json().camera.id;

      const first = await app.inject({
        method: "POST",
        url: `/v1/speed-cameras/${id}/removal-reports`,
        headers: await tokenFor("bob"),
      });
      expect(first.json().removed).toBe(false);
      expect(first.json().camera.status).toBe("active");

      // CAMERA_REMOVAL_THRESHOLD=2 for this test app.
      const second = await app.inject({
        method: "POST",
        url: `/v1/speed-cameras/${id}/removal-reports`,
        headers: await tokenFor("carol"),
      });
      expect(second.json().removed).toBe(true);
      expect(second.json().camera.status).toBe("removed");

      const nearby = await app.inject({
        method: "GET",
        url: "/v1/speed-cameras/nearby?lat=60&lng=10&radiusM=1000",
        headers: await tokenFor("alice"),
      });
      expect(nearby.json().cameras).toEqual([]);
    });

    it("does not double-count a repeat removal report from the same reporter", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: await tokenFor("alice"),
        payload: { type: "fixedSpeedCamera", lat: 61, lng: 11 },
      });
      const id = created.json().camera.id;

      await app.inject({ method: "POST", url: `/v1/speed-cameras/${id}/removal-reports`, headers: await tokenFor("bob") });
      const repeat = await app.inject({
        method: "POST",
        url: `/v1/speed-cameras/${id}/removal-reports`,
        headers: await tokenFor("bob"),
      });
      expect(repeat.json().recorded).toBe(false);
      expect(repeat.json().removed).toBe(false);
    });

    it("surfaces dynamic camera types via speed-cameras/nearby but not the general hazard-reports/nearby", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: await tokenFor("alice"),
        payload: { type: "mobileSpeedCamera", lat: 70, lng: 20, speedKmh: 100 },
      });

      const auth = await tokenFor("alice");
      const cameras = await app.inject({ method: "GET", url: "/v1/speed-cameras/nearby?lat=70&lng=20&radiusM=1000", headers: auth });
      expect(cameras.json().cameras).toHaveLength(1);

      const hazards = await app.inject({ method: "GET", url: "/v1/hazard-reports/nearby?lat=70&lng=20&radiusM=1000", headers: auth });
      expect(hazards.json().reports).toEqual([]);
    });

    it("includes fixedSpeedCamera events in delta when explicitly requested", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: await tokenFor("alice"),
        payload: { type: "fixedSpeedCamera", lat: 80, lng: 30 },
      });
      const delta = await app.inject({
        method: "GET",
        url: "/v1/delta?since=0&types=fixedSpeedCamera",
        headers: await tokenFor("alice"),
      });
      const payloadTypes = delta.json().events.map((e: { payload: { type?: string } }) => e.payload.type);
      expect(payloadTypes).toContain("fixedSpeedCamera");
    });
  });
});
