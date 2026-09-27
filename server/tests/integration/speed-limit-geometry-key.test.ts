import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/client.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";

/**
 * The formula documented in docs/schema.md, written out independently of the SQL
 * function: any other implementation (a client, an ingestion tool) can check
 * itself against this.
 */
function referenceKey(coords: [number, number][]): string {
  const pts = coords.map(([lng, lat]) => `${Math.round(lng * 1e7)},${Math.round(lat * 1e7)}`);
  const fwd = pts.join(";");
  const rev = [...pts].reverse().join(";");
  return createHash("sha256").update(fwd < rev ? fwd : rev).digest("hex").slice(0, 32);
}

function wkt(coords: [number, number][]): string {
  return `LINESTRING(${coords.map(([lng, lat]) => `${lng} ${lat}`).join(", ")})`;
}

describe("speed_limit_geometry_key / segment geometry_key", () => {
  let testDb: TestDatabase;
  beforeAll(async () => {
    testDb = await startTestDatabase();
  });
  afterAll(async () => {
    await testDb.teardown();
  });

  async function insert(coords: [number, number][], speedLimit = 50): Promise<{ id: string; key: string }> {
    const rows = await testDb.db.execute<{ id: string; geometry_key: string } & Record<string, unknown>>(sql`
      insert into speed_limit_segments (geometry, speed_limit, speed_limit_unit, source)
      values (ST_SetSRID(ST_GeomFromText(${wkt(coords)}), 4326), ${speedLimit}, 'kmh', 'test')
      returning id, geometry_key
    `);
    return { id: rows[0]!.id, key: rows[0]!.geometry_key };
  }

  it("fills geometry_key automatically as 32 lowercase hex characters", async () => {
    const { key } = await insert([[11.5, 48.1], [11.5005, 48.1005]]);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("matches the documented formula (independent reference implementation)", async () => {
    const shapes: [number, number][][] = [
      [[11.5, 48.1], [11.5005, 48.1005]],
      [[11.1234567, 48.7654321], [11.2, 48.8], [11.3000001, 48.9]],
      [[-0.1275, 51.5072], [-0.12, 51.51]],
      [[-73.9857, 40.7484], [-73.98, 40.75], [-73.97, 40.76]],
      [[0.0000001, 0.0000002], [0.0000003, 0.0000004]],
    ];
    for (const coords of shapes) {
      const { key } = await insert(coords);
      expect(key).toBe(referenceKey(coords));
    }
  });

  it("gives the same key to the same road digitised in the opposite direction", async () => {
    const forward: [number, number][] = [[10.1, 50.1], [10.2, 50.2], [10.3, 50.15]];
    const a = await insert(forward);
    const b = await insert([...forward].reverse());
    expect(a.key).toBe(b.key);
    expect(a.id).not.toBe(b.id);
  });

  it("gives identical rows (a re-import) the same key, and different geometry a different one", async () => {
    const coords: [number, number][] = [[9.1, 49.1], [9.2, 49.2]];
    const a = await insert(coords, 30);
    const b = await insert(coords, 50);
    const other = await insert([[9.1, 49.1], [9.2, 49.2000002]]);
    expect(a.key).toBe(b.key);
    expect(other.key).not.toBe(a.key);
  });

  it("ignores sub-centimetre noise (rounding to 1e-7 degrees)", async () => {
    const a = await insert([[7.12345671, 47.1], [7.2, 47.2]]);
    const b = await insert([[7.12345669, 47.1], [7.2, 47.2]]);
    expect(a.key).toBe(b.key);
  });

  it("is recomputed automatically and cannot be written by hand", async () => {
    await expect(
      testDb.db.execute(sql`update speed_limit_segments set geometry_key = 'x' where false`),
    ).rejects.toThrow();
  });
});

describe("migration 0007 on a database that already holds segments", () => {
  it("computes the key for existing rows and bumps the static-data version once", async () => {
    const container = await new PostgreSqlContainer("postgis/postgis:16-3.4").start();
    const scratch = mkdtempSync(path.join(tmpdir(), "migrations-0006-"));
    try {
      // A migrations folder that stops at 0006 — the state of every existing deployment.
      cpSync("./src/db/migrations", scratch, { recursive: true });
      const journalPath = path.join(scratch, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
      // ...and the state after 0007 alone: later migrations (0008, 0009) have their own tests and must not
      // move the counted version, which is what this test pins to 0007.
      const upToSeven = JSON.parse(JSON.stringify(journal)) as typeof journal;
      upToSeven.entries = upToSeven.entries.filter((e) => e.idx <= 7);
      journal.entries = journal.entries.filter((e) => e.idx <= 6);
      writeFileSync(journalPath, JSON.stringify(journal));

      const old = createDb({ DATABASE_URL: container.getConnectionUri() });
      await migrate(old.db, { migrationsFolder: scratch });
      const coords: [number, number][] = [[13.4, 52.5], [13.41, 52.51]];
      await old.db.execute(sql`
        insert into speed_limit_segments (geometry, speed_limit, speed_limit_unit, source)
        values (ST_SetSRID(ST_GeomFromText(${wkt(coords)}), 4326), 30, 'kmh', 'legacy')
      `);
      const before = await old.db.execute<{ version: number } & Record<string, unknown>>(sql`select version from static_data_state where id = 1`);
      await old.client.end();

      const upgraded = createDb({ DATABASE_URL: container.getConnectionUri() });
      writeFileSync(journalPath, JSON.stringify(upToSeven));
      await migrate(upgraded.db, { migrationsFolder: scratch });
      const rows = await upgraded.db.execute<{ geometry_key: string; speed_limit: number } & Record<string, unknown>>(sql`
        select geometry_key, speed_limit from speed_limit_segments
      `);
      const after = await upgraded.db.execute<{ version: number; corrections_overlay_enabled: boolean } & Record<string, unknown>>(sql`
        select version, corrections_overlay_enabled from static_data_state where id = 1
      `);
      await upgraded.client.end();

      expect(rows).toHaveLength(1);
      expect(rows[0]!.geometry_key).toBe(referenceKey(coords));
      expect(rows[0]!.speed_limit).toBe(30);
      expect(after[0]!.version).toBe((before[0]!.version as number) + 1);
      expect(after[0]!.corrections_overlay_enabled).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      await container.stop();
    }
  }, 120_000);
});
