import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { runRetentionCleanup } from "../../src/modules/expiry/retention.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { insertHazardReport } from "./helpers.js";
import { positionToRegionTile } from "../../src/lib/h3.js";

describe("retention cleanup", () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await startTestDatabase();
  });

  afterEach(async () => {
    await testDb.db.execute(sql`truncate table hazard_reports, event_log restart identity cascade`);
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  function env(overrides: Record<string, string> = {}) {
    resetEnvCache();
    return loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      EVENT_LOG_RETENTION_DAYS_DYNAMIC: "3",
      EVENT_LOG_RETENTION_DAYS_STATIC: "30",
      ...overrides,
    });
  }

  async function insertEventAt(type: "ReportCreated" | "StaticDataUpdated", occurredAt: Date) {
    await testDb.db.execute(sql`
      insert into event_log (occurred_at, type, entity_type, entity_id, payload, source)
      values (${occurredAt.toISOString()}, ${type}::event_type,
              ${type === "ReportCreated" ? "hazardReport" : "staticSign"}::entity_type,
              ${crypto.randomUUID()}, '{}'::jsonb, 'seed')
    `);
  }

  it("deletes dynamic events older than the dynamic retention window, keeps recent ones", async () => {
    await insertEventAt("ReportCreated", new Date(Date.now() - 4 * 24 * 60 * 60_000)); // 4 days old
    await insertEventAt("ReportCreated", new Date(Date.now() - 1 * 24 * 60 * 60_000)); // 1 day old

    const result = await runRetentionCleanup(testDb.db, env());
    expect(result.dynamicEventsDeleted).toBe(1);

    const remaining = await testDb.db.execute<{ count: number } & Record<string, unknown>>(
      sql`select count(*)::int as count from event_log`,
    );
    expect(remaining[0]?.count).toBe(1);
  });

  it("keeps static events within the (longer) static retention window even if past the dynamic one", async () => {
    await insertEventAt("StaticDataUpdated", new Date(Date.now() - 10 * 24 * 60 * 60_000)); // 10 days old

    const result = await runRetentionCleanup(testDb.db, env());
    expect(result.staticEventsDeleted).toBe(0);

    const remaining = await testDb.db.execute<{ count: number } & Record<string, unknown>>(
      sql`select count(*)::int as count from event_log`,
    );
    expect(remaining[0]?.count).toBe(1);
  });

  it("hard-deletes stale expired/removed hazard reports but leaves active ones alone", async () => {
    const tile = positionToRegionTile(52.52, 13.405, { REGION_TILE_H3_RESOLUTION: 7 });
    const staleExpiredId = await insertHazardReport(testDb.db, {
      lat: 52.52,
      lng: 13.405,
      regionTile: tile,
      expiresAt: new Date(Date.now() - 5 * 24 * 60 * 60_000),
      status: "expired",
    });
    await testDb.db.execute(
      sql`update hazard_reports set updated_at = now() - interval '5 days' where id = ${staleExpiredId}`,
    );
    const activeId = await insertHazardReport(testDb.db, {
      lat: 52.52,
      lng: 13.405,
      regionTile: tile,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await runRetentionCleanup(testDb.db, env());
    expect(result.staleHazardReportsDeleted).toBe(1);

    const remaining = await testDb.db.execute<{ id: string } & Record<string, unknown>>(
      sql`select id from hazard_reports`,
    );
    expect(remaining.map((r) => r.id)).toEqual([activeId]);
  });
});
