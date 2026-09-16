import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";

/**
 * docs/prompt-phase1-server.md section "ROLLE & ARBEITSWEISE" point 6 and
 * docs/concept.md section 7: a freshly set-up server with an empty database is a
 * valid, functioning state — it must not 500, it just has no data yet. Every read
 * endpoint added in a milestone gets a line here (per the plan's P1.5 task list).
 */
describe("empty database", () => {
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

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  it("reports healthy against a freshly migrated, empty database", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", database: "ok" });
  });

  it("returns 404 (not empty arrays/500) for a point speed-limit lookup with no data", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/speed-limit?lat=52.5&lng=13.4" });
    expect(res.statusCode).toBe(404);
  });

  it.each([
    "/v1/speed-limit-segments/nearby?lat=52.5&lng=13.4&radiusM=1000",
    "/v1/static-signs/nearby?lat=52.5&lng=13.4&radiusM=1000",
    "/v1/hazard-reports/nearby?lat=52.5&lng=13.4&radiusM=1000",
  ])("returns 200 with an empty list for %s", async (url) => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const [, list] = Object.entries(body)[0] as [string, unknown[]];
    expect(list).toEqual([]);
  });

  it("returns 200 with an empty list for hazard-reports/by-tile", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/hazard-reports/by-tile?tile=871f200d3ffffff&k=1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reports: [] });
  });

  it("returns an empty snapshot with sequence 0", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/snapshot" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      snapshotSequence: 0,
      speedLimitSegments: [],
      staticSigns: [],
      hazardReports: [],
    });
  });

  it("returns an empty delta page for since=0", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/delta?since=0" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [], nextSince: null, hasMore: false });
  });

  it("rejects delta for a since far in the future as SNAPSHOT_REQUIRED (log is empty, cannot prove no gap)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/delta?since=999" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SNAPSHOT_REQUIRED");
  });
});
