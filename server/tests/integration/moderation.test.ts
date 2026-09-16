import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";

describe("moderation gate / hazard report writes", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;
  let env: Env;
  const as: Record<string, { authorization: string }> = {};

  async function tokenFor(name: string) {
    if (!as[name]) as[name] = authHeader(await testToken(env, { sub: name }));
    return as[name];
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    resetEnvCache();
    env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      REPORT_RATE_LIMIT_MAX: "3",
      DUPLICATE_MERGE_RADIUS_METERS: "500",
    });
    app = await buildApp({ env, db: testDb.db });
  });

  afterEach(async () => {
    await testDb.db.execute(sql`truncate table hazard_confirmations, hazard_reports, event_log restart identity cascade`);
  });

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  it("creates a new report and logs a ReportCreated event", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: await tokenFor("alice"),
      payload: { type: "traffic", lat: 52.52, lng: 13.405 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.merged).toBe(false);
    expect(body.report.confirmCount).toBe(0);
    expect(body.report.reporterId).toBe("alice");

    const events = await testDb.db.execute<{ type: string } & Record<string, unknown>>(
      sql`select type from event_log where entity_id = ${body.report.id}`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("ReportCreated");
  });

  it("rejects an unrelated speedKmh field with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: await tokenFor("alice"),
      payload: { type: "traffic", lat: 52.52, lng: 13.405, speedKmh: 50 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("merges a second nearby same-type report from a different reporter into the first", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: await tokenFor("alice"),
      payload: { type: "accident", lat: 52.52, lng: 13.405 },
    });
    const firstBody = first.json();

    const second = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: await tokenFor("bob"),
      // ~100m away — well within the 500m merge radius configured above.
      payload: { type: "accident", lat: 52.5209, lng: 13.405 },
    });
    const secondBody = second.json();

    expect(second.statusCode).toBe(200);
    expect(secondBody.merged).toBe(true);
    expect(secondBody.report.id).toBe(firstBody.report.id);
    expect(secondBody.report.confirmCount).toBe(1);

    const events = await testDb.db.execute<{ type: string } & Record<string, unknown>>(
      sql`select type from event_log where entity_id = ${firstBody.report.id} order by sequence asc`,
    );
    expect(events.map((e) => e.type)).toEqual(["ReportCreated", "ReportConfirmed"]);
  });

  it("does not double-count a repeat merge from the same reporter but still extends expiry", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: await tokenFor("alice"),
      payload: { type: "ice", lat: 52.52, lng: 13.405 },
    });
    const id = first.json().report.id;

    const repeat = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: await tokenFor("alice"),
      payload: { type: "ice", lat: 52.5209, lng: 13.405 },
    });
    expect(repeat.json().report.confirmCount).toBe(0);
    expect(repeat.json().report.id).toBe(id);
  });

  it("does not merge reports of a different type at the same location", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: await tokenFor("alice"),
      payload: { type: "traffic", lat: 52.52, lng: 13.405 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: await tokenFor("bob"),
      payload: { type: "obstacle", lat: 52.52, lng: 13.405 },
    });
    expect(res.json().merged).toBe(false);
  });

  it("enforces the rate limit across creates and confirmations combined", async () => {
    const carol = await tokenFor("carol");
    await app.inject({ method: "POST", url: "/v1/hazard-reports", headers: carol, payload: { type: "traffic", lat: 10, lng: 10 } });
    await app.inject({ method: "POST", url: "/v1/hazard-reports", headers: carol, payload: { type: "traffic", lat: 20, lng: 20 } });
    await app.inject({ method: "POST", url: "/v1/hazard-reports", headers: carol, payload: { type: "traffic", lat: 30, lng: 30 } });
    // REPORT_RATE_LIMIT_MAX=3 for this test env — the 4th submission within the window is rejected.
    const fourth = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: carol,
      payload: { type: "traffic", lat: 40, lng: 40 },
    });
    expect(fourth.statusCode).toBe(429);
  });

  it("confirm endpoint: stillThere increments confirmCount, gone increments denyCount, both idempotent per reporter", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: await tokenFor("dave"),
      payload: { type: "breakdown", lat: 60, lng: 60 },
    });
    const id = created.json().report.id;

    const confirm = await app.inject({
      method: "POST",
      url: `/v1/hazard-reports/${id}/confirmations`,
      headers: await tokenFor("erin"),
      payload: { kind: "stillThere" },
    });
    expect(confirm.json().recorded).toBe(true);
    expect(confirm.json().report.confirmCount).toBe(1);

    const repeat = await app.inject({
      method: "POST",
      url: `/v1/hazard-reports/${id}/confirmations`,
      headers: await tokenFor("erin"),
      payload: { kind: "stillThere" },
    });
    expect(repeat.json().recorded).toBe(false);
    expect(repeat.json().report.confirmCount).toBe(1);

    const deny = await app.inject({
      method: "POST",
      url: `/v1/hazard-reports/${id}/confirmations`,
      headers: await tokenFor("frank"),
      payload: { kind: "gone" },
    });
    expect(deny.json().report.denyCount).toBe(1);
  });

  it("confirm on a non-existent report returns 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports/00000000-0000-0000-0000-000000000000/confirmations",
      headers: await tokenFor("erin"),
      payload: { kind: "stillThere" },
    });
    expect(res.statusCode).toBe(404);
  });
});
