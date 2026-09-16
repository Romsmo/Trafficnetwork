import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { insertHazardReport } from "./helpers.js";
import { runExpirySweep } from "../../src/modules/expiry/worker.js";
import { positionToRegionTile } from "../../src/lib/h3.js";

describe("expiry sweep", () => {
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

  const tile = positionToRegionTile(52.52, 13.405, { REGION_TILE_H3_RESOLUTION: 7 });

  it("transitions past-due active reports to expired and logs a ReportExpired event", async () => {
    const id = await insertHazardReport(testDb.db, {
      lat: 52.52,
      lng: 13.405,
      regionTile: tile,
      expiresAt: new Date(Date.now() - 1000),
    });

    const events = await runExpirySweep(testDb.db);
    expect(events).toHaveLength(1);
    expect(events[0]?.regionTile).toBe(tile);

    const rows = await testDb.db.execute<{ status: string } & Record<string, unknown>>(
      sql`select status from hazard_reports where id = ${id}`,
    );
    expect(rows[0]?.status).toBe("expired");

    const loggedEvents = await testDb.db.execute<{ type: string; entity_id: string } & Record<string, unknown>>(
      sql`select type, entity_id from event_log where entity_id = ${id}`,
    );
    expect(loggedEvents).toHaveLength(1);
    expect(loggedEvents[0]?.type).toBe("ReportExpired");
  });

  it("leaves not-yet-expired active reports untouched", async () => {
    const id = await insertHazardReport(testDb.db, {
      lat: 52.52,
      lng: 13.405,
      regionTile: tile,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const events = await runExpirySweep(testDb.db);
    expect(events).toHaveLength(0);

    const rows = await testDb.db.execute<{ status: string } & Record<string, unknown>>(
      sql`select status from hazard_reports where id = ${id}`,
    );
    expect(rows[0]?.status).toBe("active");
  });
});
