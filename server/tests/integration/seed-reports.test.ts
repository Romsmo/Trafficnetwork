import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { insertHazardReport } from "./helpers.js";
import { positionToRegionTile } from "../../src/lib/h3.js";

/**
 * Seed reports (POST /v1/bulk-import/seed-reports and .../retire) — see modules/bulk-import/seed-reports.ts
 * for the lifecycle these tests pin down: upsert by (feed, external id), events only for real changes,
 * runs that retire what they did not see, and the dead-man's-switch expiry for rows without an end date.
 */
describe("seed reports (roadworks import)", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    resetEnvCache();
    const env = loadEnv({ DATABASE_URL: testDb.container.getConnectionUri(), JWT_SECRET: "a".repeat(32) });
    app = await buildApp({ env, db: testDb.db });
  });

  afterEach(async () => {
    await testDb.db.execute(sql`truncate table hazard_confirmations, hazard_reports, event_log restart identity cascade`);
  });

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  async function bulkHeaders() {
    return authHeader(await testToken(app.deps.env, { sub: "importer", scopes: ["bulk-import"] }));
  }

  async function upsert(payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/v1/bulk-import/seed-reports", headers: await bulkHeaders(), payload });
  }

  async function retire(payload: Record<string, unknown>) {
    return app.inject({ method: "POST", url: "/v1/bulk-import/seed-reports/retire", headers: await bulkHeaders(), payload });
  }

  const report = (externalId: string, extra: Record<string, unknown> = {}) => ({ externalId, type: "construction", lat: 48.87, lng: 11.46, ...extra });
  const batch = (runId: string, reports: unknown[], feedId = "de-autobahn") => ({ feedId, runId, sourceLicense: "ungeklärt", reports });

  async function rows() {
    return testDb.db.execute<Record<string, unknown>>(sql`
      select source_feed, external_id, status, source, source_license, reporter_id, type, last_seen_run,
             expires_at, ST_X(position) as lng, ST_Y(position) as lat
      from hazard_reports order by external_id
    `);
  }

  async function events() {
    return testDb.db.execute<{ type: string; source: string; entity_id: string } & Record<string, unknown>>(sql`
      select type, source, entity_id from event_log order by sequence
    `);
  }

  describe("authorization and validation", () => {
    it("needs the bulk-import scope", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/bulk-import/seed-reports",
        headers: authHeader(await testToken(app.deps.env, { scopes: ["client"] })),
        payload: batch("r1", [report("a")]),
      });
      expect(res.statusCode).toBe(403);
      const retired = await app.inject({
        method: "POST",
        url: "/v1/bulk-import/seed-reports/retire",
        headers: authHeader(await testToken(app.deps.env, { scopes: ["client"] })),
        payload: { feedId: "de-autobahn", runId: "r1" },
      });
      expect(retired.statusCode).toBe(403);
    });

    it.each([
      ["a feedId with upper case", { ...batch("r1", [report("a")]), feedId: "DE-Autobahn" }],
      ["no reports", batch("r1", [])],
      ["a type other than construction", batch("r1", [{ ...report("a"), type: "accident" }])],
      ["a missing sourceLicense", { feedId: "de-autobahn", runId: "r1", reports: [report("a")] }],
      ["a latitude out of range", batch("r1", [report("a", { lat: 91 })])],
      ["an end date without a time zone", batch("r1", [report("a", { endsAt: "2026-12-31T00:00:00" })])],
    ])("rejects %s with 400", async (_label, payload) => {
      const res = await upsert(payload as Record<string, unknown>);
      expect(res.statusCode).toBe(400);
    });
  });

  describe("upsert", () => {
    it("creates active seed reports with full provenance and announces each new one", async () => {
      const end = inHours(72);
      const res = await upsert(batch("r1", [report("a", { endsAt: end }), report("b", { lat: 50.1, lng: 8.6 })]));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ created: 2, reactivated: 0, updated: 0, refreshed: 0, skippedEnded: 0, duplicatesInRequest: 0 });

      const stored = await rows();
      expect(stored).toHaveLength(2);
      expect(stored[0]).toMatchObject({ source_feed: "de-autobahn", external_id: "a", status: "active", source: "seed", source_license: "ungeklärt", reporter_id: "importer", type: "construction", last_seen_run: "r1" });
      expect(new Date(stored[0]!.expires_at as string).toISOString()).toBe(end); // the source's end date is the expiry

      const log = await events();
      expect(log.map((e) => [e.type, e.source])).toEqual([
        ["ReportCreated", "seed"],
        ["ReportCreated", "seed"],
      ]);
    });

    it("is idempotent: sending the same batch again changes nothing and emits no events", async () => {
      const payload = batch("r1", [report("a", { endsAt: inHours(72) }), report("b")]);
      await upsert(payload);
      const before = await events();

      const again = await upsert({ ...payload, runId: "r2" });
      expect(again.json()).toMatchObject({ created: 0, updated: 0, refreshed: 2 });
      expect(await rows()).toHaveLength(2);
      expect(await events()).toHaveLength(before.length);
      expect((await rows()).every((r) => r.last_seen_run === "r2")).toBe(true);
    });

    it("gives a report without an end date the ttl and renews it on every sighting (dead-man's switch)", async () => {
      await upsert(batch("r1", [report("a", { ttlHours: 24 })]));
      const first = new Date((await rows())[0]!.expires_at as string).getTime();
      expect(first).toBeGreaterThan(Date.now() + 23 * 3_600_000);
      expect(first).toBeLessThan(Date.now() + 25 * 3_600_000);

      await testDb.db.execute(sql`update hazard_reports set expires_at = now() + interval '1 hour'`); // pretend most of the ttl passed
      await upsert(batch("r2", [report("a", { ttlHours: 24 })]));
      const renewed = new Date((await rows())[0]!.expires_at as string).getTime();
      expect(renewed).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    });

    it("defaults the ttl to the construction band when none is given", async () => {
      await upsert(batch("r1", [report("a")]));
      const days = app.deps.env.HAZARD_EXPIRY_CONSTRUCTION_DAYS;
      const expires = new Date((await rows())[0]!.expires_at as string).getTime();
      expect(Math.abs(expires - (Date.now() + days * 86_400_000))).toBeLessThan(60_000);
    });

    it("emits a ReportConfirmed with the new state when the source's end date changes, and none for jitter", async () => {
      await upsert(batch("r1", [report("a", { endsAt: inHours(72) })]));
      await upsert(batch("r2", [report("a", { endsAt: inHours(72 + 1 / 3600) })])); // one second later: unchanged
      expect((await events()).map((e) => e.type)).toEqual(["ReportCreated"]);

      const extended = inHours(24 * 30);
      const res = await upsert(batch("r3", [report("a", { endsAt: extended })]));
      expect(res.json()).toMatchObject({ updated: 1, refreshed: 0 });
      expect((await events()).map((e) => e.type)).toEqual(["ReportCreated", "ReportConfirmed"]);
      expect(new Date((await rows())[0]!.expires_at as string).toISOString()).toBe(extended);
    });

    it("moves the report and updates its region tile when the position changes by more than 100 m, not for less", async () => {
      await upsert(batch("r1", [report("a", { lat: 48.87, lng: 11.46 })]));
      await upsert(batch("r2", [report("a", { lat: 48.8702, lng: 11.4601 })])); // ≈25 m
      expect((await events()).map((e) => e.type)).toEqual(["ReportCreated"]);

      const res = await upsert(batch("r3", [report("a", { lat: 48.9, lng: 11.5 })]));
      expect(res.json()).toMatchObject({ updated: 1 });
      const [stored] = await rows();
      expect(Number(stored!.lat)).toBeCloseTo(48.9, 5);
      const tile = await testDb.db.execute<{ region_tile: string } & Record<string, unknown>>(sql`select region_tile from hazard_reports`);
      expect(tile[0]!.region_tile).toBe(positionToRegionTile(48.9, 11.5, app.deps.env));
    });

    it("does not create a report whose end date is already past", async () => {
      const res = await upsert(batch("r1", [report("old", { endsAt: inHours(-2) }), report("current", { endsAt: inHours(5) })]));
      expect(res.json()).toMatchObject({ created: 1, skippedEnded: 1 });
      expect((await rows()).map((r) => r.external_id)).toEqual(["current"]);
    });

    it("counts a repeated externalId in one request once (the last occurrence wins)", async () => {
      const res = await upsert(batch("r1", [report("a", { lat: 48.0 }), report("a", { lat: 49.0 })]));
      expect(res.json()).toMatchObject({ created: 1, duplicatesInRequest: 1 });
      expect(Number((await rows())[0]!.lat)).toBeCloseTo(49.0, 5);
    });

    it("keeps feeds apart: the same externalId in two feeds is two reports", async () => {
      await upsert(batch("r1", [report("a")], "de-autobahn"));
      await upsert(batch("r1", [report("a")], "fr-tipi"));
      expect((await rows()).map((r) => `${r.source_feed}:${r.external_id}`).sort()).toEqual(["de-autobahn:a", "fr-tipi:a"]);
    });

    it("serves seeded roadworks through the ordinary hazard read API, marked as seed", async () => {
      await upsert(batch("r1", [report("a", { endsAt: inHours(48) })]));
      const res = await app.inject({
        method: "GET",
        url: "/v1/hazard-reports/nearby?lat=48.87&lng=11.46&radiusM=1000",
        headers: authHeader(await testToken(app.deps.env, { scopes: ["client"] })),
      });
      expect(res.statusCode).toBe(200);
      const found = res.json().reports as { type: string; source: string; sourceLicense: string | null }[];
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ type: "construction", source: "seed", sourceLicense: "ungeklärt" });
    });
  });

  describe("retire", () => {
    it("expires what a complete run did not re-send, announces it, and leaves everything else alone", async () => {
      await upsert(batch("r1", [report("a"), report("b"), report("c")]));
      await upsert(batch("r1", [report("other-feed")], "fr-tipi"));
      const community = await insertHazardReport(testDb.db, { lat: 48.87, lng: 11.46, type: "construction", regionTile: "8a1f00000000000", expiresAt: new Date(Date.now() + 3_600_000) });

      await upsert(batch("r2", [report("a"), report("c")])); // b disappeared from the feed
      const res = await retire({ feedId: "de-autobahn", runId: "r2" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ retired: 1 });

      const byId = Object.fromEntries((await rows()).map((r) => [`${r.source_feed}:${r.external_id}`, r.status]));
      expect(byId["de-autobahn:a"]).toBe("active");
      expect(byId["de-autobahn:b"]).toBe("expired");
      expect(byId["de-autobahn:c"]).toBe("active");
      expect(byId["fr-tipi:other-feed"]).toBe("active"); // another feed is never touched
      const communityRow = await testDb.db.execute<{ status: string } & Record<string, unknown>>(sql`select status from hazard_reports where id = ${community}`);
      expect(communityRow[0]!.status).toBe("active");

      const log = await events();
      expect(log.at(-1)).toMatchObject({ type: "ReportExpired", source: "seed" });
    });

    it("refuses to retire on a run that wrote nothing (an empty or failed fetch must not wipe the feed)", async () => {
      await upsert(batch("r1", [report("a")]));
      const res = await retire({ feedId: "de-autobahn", runId: "never-ran" });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("SEED_RUN_EMPTY");
      expect((await rows())[0]!.status).toBe("active");
    });

    it("re-activates a retired report that the feed lists again, announcing it as new", async () => {
      await upsert(batch("r1", [report("a"), report("b")]));
      await upsert(batch("r2", [report("a")]));
      await retire({ feedId: "de-autobahn", runId: "r2" }); // b retired
      const res = await upsert(batch("r3", [report("a"), report("b")]));
      expect(res.json()).toMatchObject({ reactivated: 1, refreshed: 1 });
      expect((await rows()).every((r) => r.status === "active")).toBe(true);
      expect((await events()).map((e) => e.type)).toEqual(["ReportCreated", "ReportCreated", "ReportExpired", "ReportCreated"]);
    });

    it("retiring twice is a no-op", async () => {
      await upsert(batch("r1", [report("a"), report("b")]));
      await upsert(batch("r2", [report("a")]));
      expect((await retire({ feedId: "de-autobahn", runId: "r2" })).json()).toEqual({ retired: 1 });
      expect((await retire({ feedId: "de-autobahn", runId: "r2" })).json()).toEqual({ retired: 0 });
    });
  });

  it("a community report near a seeded roadwork merges into it as a confirmation instead of creating a second one", async () => {
    await upsert(batch("r1", [report("a", { endsAt: inHours(48) })]));
    const res = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: authHeader(await testToken(app.deps.env, { sub: "driver-1", scopes: ["client"] })),
      payload: { type: "construction", lat: 48.8701, lng: 11.4601 },
    });
    expect(res.statusCode).toBe(200); // merged (200), not created (201)
    expect(await rows()).toHaveLength(1);
  });
});
