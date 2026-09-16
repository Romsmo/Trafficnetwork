import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { insertHazardReport, insertSpeedLimitSegment, insertStaticSign } from "./helpers.js";
import { appendEvent } from "../../src/db/append-event.js";
import { positionToRegionTile } from "../../src/lib/h3.js";

describe("snapshot and delta", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
    });
    app = await buildApp({ env, db: testDb.db });
  });

  afterEach(async () => {
    await testDb.db.execute(sql`
      truncate table hazard_confirmations, hazard_reports, camera_removal_reports,
      fixed_speed_cameras, static_signs, speed_limit_segments, event_log restart identity cascade
    `);
  });

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  const berlinTile = positionToRegionTile(52.52, 13.405, { REGION_TILE_H3_RESOLUTION: 7 });
  const parisTile = positionToRegionTile(48.8566, 2.3522, { REGION_TILE_H3_RESOLUTION: 7 });

  it("returns static data in full regardless of tiles, and dynamic data only for requested tiles", async () => {
    await insertStaticSign(testDb.db, { lat: 52.52, lng: 13.405 });
    await insertSpeedLimitSegment(testDb.db, {
      lineString: [
        [13.4, 52.52],
        [13.41, 52.53],
      ],
      speedLimit: 50,
    });
    await insertHazardReport(testDb.db, {
      lat: 52.52,
      lng: 13.405,
      regionTile: berlinTile,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await insertHazardReport(testDb.db, {
      lat: 48.8566,
      lng: 2.3522,
      regionTile: parisTile,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const noTiles = await app.inject({ method: "GET", url: "/v1/snapshot" });
    expect(noTiles.json().staticSigns).toHaveLength(1);
    expect(noTiles.json().speedLimitSegments).toHaveLength(1);
    expect(noTiles.json().hazardReports).toHaveLength(0);

    const berlinOnly = await app.inject({ method: "GET", url: `/v1/snapshot?tiles=${berlinTile}` });
    expect(berlinOnly.json().staticSigns).toHaveLength(1);
    expect(berlinOnly.json().hazardReports).toHaveLength(1);
    expect(berlinOnly.json().hazardReports[0].reporterId).toBe("test-reporter");
  });

  it("excludes expired/removed hazard reports from nearby and by-tile reads", async () => {
    await insertHazardReport(testDb.db, {
      lat: 52.52,
      lng: 13.405,
      regionTile: berlinTile,
      expiresAt: new Date(Date.now() - 60_000),
      status: "expired",
    });

    const nearby = await app.inject({ method: "GET", url: "/v1/hazard-reports/nearby?lat=52.52&lng=13.405&radiusM=1000" });
    expect(nearby.json().reports).toHaveLength(0);

    const byTile = await app.inject({ method: "GET", url: `/v1/hazard-reports/by-tile?tile=${berlinTile}` });
    expect(byTile.json().reports).toHaveLength(0);
  });

  it("paginates delta and reports hasMore/nextSince correctly", async () => {
    for (let i = 0; i < 3; i++) {
      await testDb.db.transaction(async (tx) => {
        await appendEvent(tx, {
          type: "StaticDataUpdated",
          entityType: "staticSign",
          entityId: crypto.randomUUID(),
          payload: { seq: i },
          source: "seed",
        });
      });
    }

    const page1 = await app.inject({ method: "GET", url: "/v1/delta?since=0&limit=2" });
    const body1 = page1.json();
    expect(body1.events).toHaveLength(2);
    expect(body1.hasMore).toBe(true);
    expect(body1.nextSince).toBe(body1.events[1].sequence);

    const page2 = await app.inject({ method: "GET", url: `/v1/delta?since=${body1.nextSince}&limit=2` });
    const body2 = page2.json();
    expect(body2.events).toHaveLength(1);
    expect(body2.hasMore).toBe(false);
  });

  it("returns 409 SNAPSHOT_REQUIRED when since predates the retained log", async () => {
    for (let i = 0; i < 5; i++) {
      await testDb.db.transaction(async (tx) => {
        await appendEvent(tx, {
          type: "StaticDataUpdated",
          entityType: "staticSign",
          entityId: crypto.randomUUID(),
          payload: { seq: i },
          source: "seed",
        });
      });
    }
    // Simulate the retention job having purged the first 3 events.
    await testDb.db.execute(sql`delete from event_log where sequence <= 3`);

    const res = await app.inject({ method: "GET", url: "/v1/delta?since=1" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SNAPSHOT_REQUIRED");

    // since=3 (one below the new earliest retained sequence 4) is still gap-free.
    const ok = await app.inject({ method: "GET", url: "/v1/delta?since=3" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().events).toHaveLength(2);
  });
});
