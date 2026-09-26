import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { createDb, type Database } from "../../src/db/client.js";
import { STATEMENT_BREAKPOINT } from "../../src/db/migration-locks.js";
import { authHeader, testToken } from "./auth-helper.js";

/**
 * Migration 0009 (add-on D) against a database that already holds data in today's format: nothing may be lost,
 * every old row must come out a speed camera, the old reads must answer what they answered, a second run
 * must change nothing, and the rollback must give the old state back — and refuse to lose new-kind rows.
 * docs/persistent-enforcement-devices.md, sections 3 and 7.
 */

const MIGRATIONS = "./src/db/migrations";
const DOWN_SQL = "./src/db/rollback/0009_persistent_enforcement_devices.down.sql";
const TAG_0009 = "0009_persistent_enforcement_devices";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const COUNTED_TABLES = [
  "fixed_speed_cameras",
  "camera_removal_reports",
  "hazard_reports",
  "hazard_confirmations",
  "event_log",
  "static_signs",
  "speed_limit_segments",
];

describe("migration 0009 on a database with legacy data", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database["db"];
  let client: Database["client"];
  const dirs: string[] = [];

  /** A copy of the migrations folder whose journal stops before 0009 — the schema as it was before this add-on. */
  function migrationsBefore0009(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "migrations-before-0009-"));
    dirs.push(dir);
    cpSync(MIGRATIONS, dir, { recursive: true });
    const journalPath = path.join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => e.tag !== TAG_0009);
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    return dir;
  }

  async function withFreshConnection<T>(fn: (d: Database["db"]) => Promise<T>): Promise<T> {
    // postgres.js caches type OIDs per connection; migrations that create types need a connection opened afterwards.
    const c = createDb({ DATABASE_URL: container.getConnectionUri() });
    try {
      return await fn(c.db);
    } finally {
      await c.client.end();
    }
  }

  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of COUNTED_TABLES) {
      const rows = await db.execute<{ n: number } & Record<string, unknown>>(sql`select count(*)::int as n from ${sql.identifier(table)}`);
      out[table] = rows[0]!.n;
    }
    return out;
  }

  /** The old columns of every camera row, in a stable order — what a client could see before the change. */
  async function legacyCameraRows(): Promise<Json[]> {
    return [
      ...(await db.execute<Json>(sql`
        select id, ST_AsText(position) as position, status, removed_at, source, source_license, imported_at, last_confirmed_at
        from fixed_speed_cameras order by id`)),
    ];
  }

  async function applied(): Promise<{ n: number; last: string }> {
    const rows = await db.execute<{ n: number; last: string } & Record<string, unknown>>(
      sql`select count(*)::int as n, max(created_at)::text as last from drizzle.__drizzle_migrations`,
    );
    return { n: rows[0]!.n, last: rows[0]!.last };
  }

  async function columnExists(): Promise<boolean> {
    const rows = await db.execute(sql`
      select 1 from information_schema.columns where table_schema = 'public' and table_name = 'fixed_speed_cameras' and column_name = 'camera_type'`);
    return rows.length > 0;
  }

  /**
   * Runs a SQL file the way psql would: one connection of its own (the script has BEGIN/COMMIT, which postgres.js
   * only allows on a single-connection client), closed afterwards — a refused rollback leaves its session in an aborted transaction.
   */
  const runFile = async (file: string) => {
    const single = postgres(container.getConnectionUri(), { max: 1, prepare: false, onnotice: () => undefined });
    try {
      await single.unsafe(readFileSync(file, "utf8"));
    } finally {
      await single.end();
    }
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgis/postgis:16-3.4").start();
    await withFreshConnection((d) => migrate(d, { migrationsFolder: migrationsBefore0009() }));
    ({ db, client } = createDb({ DATABASE_URL: container.getConnectionUri() }));

    // --- data in today's format: written the way the code before this add-on wrote it (no camera_type anywhere) ---
    await db.execute(sql`
      insert into fixed_speed_cameras (id, position, status, removed_at, source, source_license, imported_at, last_confirmed_at) values
        ('00000000-0000-4000-8000-000000000001', ST_SetSRID(ST_MakePoint(13.405, 52.52), 4326), 'active', null, 'osm', 'ODbL', '2026-01-01T00:00:00Z', null),
        ('00000000-0000-4000-8000-000000000002', ST_SetSRID(ST_MakePoint(11.575, 48.137), 4326), 'active', null, 'community', null, '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z'),
        ('00000000-0000-4000-8000-000000000003', ST_SetSRID(ST_MakePoint(9.99, 53.55), 4326), 'removed', '2026-04-01T00:00:00Z', 'osm', 'ODbL', '2026-01-01T00:00:00Z', null)`);
    await db.execute(sql`
      insert into camera_removal_reports (camera_id, reporter_id) values
        ('00000000-0000-4000-8000-000000000003', 'alice'), ('00000000-0000-4000-8000-000000000003', 'bob'), ('00000000-0000-4000-8000-000000000003', 'carol')`);
    // Expiring report types the old code kept in hazard_reports, including the two this add-on makes persistent *elsewhere*.
    await db.execute(sql`
      insert into hazard_reports (id, type, position, region_tile, reporter_id, expires_at, status) values
        ('10000000-0000-4000-8000-000000000001', 'redLightCamera', ST_SetSRID(ST_MakePoint(13.41, 52.52), 4326), '871f1d489ffffff', 'alice', now() + interval '10 minutes', 'active'),
        ('10000000-0000-4000-8000-000000000002', 'distanceControl', ST_SetSRID(ST_MakePoint(13.42, 52.52), 4326), '871f1d489ffffff', 'bob', now() + interval '10 minutes', 'active'),
        ('10000000-0000-4000-8000-000000000003', 'mobileSpeedCamera', ST_SetSRID(ST_MakePoint(13.43, 52.52), 4326), '871f1d489ffffff', 'carol', now() - interval '1 hour', 'expired'),
        ('10000000-0000-4000-8000-000000000004', 'ice', ST_SetSRID(ST_MakePoint(13.44, 52.52), 4326), '871f1d489ffffff', 'dave', now() + interval '10 minutes', 'active')`);
    await db.execute(sql`insert into hazard_confirmations (hazard_report_id, reporter_id, confirmation) values ('10000000-0000-4000-8000-000000000001', 'alice', 'stillThere')`);
    await db.execute(sql`
      insert into event_log (type, entity_type, entity_id, payload, region_tile, source) values
        ('StaticDataUpdated', 'fixedSpeedCamera', '00000000-0000-4000-8000-000000000001', '{"id":"00000000-0000-4000-8000-000000000001","type":"fixedSpeedCamera","status":"active"}', null, 'community'),
        ('ReportCreated', 'hazardReport', '10000000-0000-4000-8000-000000000001', '{"id":"10000000-0000-4000-8000-000000000001","type":"redLightCamera"}', '871f1d489ffffff', 'community'),
        ('StaticDataRemoved', 'fixedSpeedCamera', '00000000-0000-4000-8000-000000000003', '{"id":"00000000-0000-4000-8000-000000000003","type":"fixedSpeedCamera","status":"removed"}', null, 'community')`);
    await db.execute(sql`insert into static_signs (position, sign_type, source) values (ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326), 'DE:274', 'osm')`);
    await db.execute(sql`
      insert into speed_limit_segments (geometry, speed_limit, speed_limit_unit, source)
      values (ST_SetSRID(ST_GeomFromText('LINESTRING(13.40 52.50, 13.41 52.51)'), 4326), 50, 'kmh', 'osm')`);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  let before: { counts: Record<string, number>; cameras: Json[]; version: number; migrations: { n: number; last: string } };

  it("starts from the legacy schema: no camera_type, the data in place", async () => {
    expect(await columnExists()).toBe(false);
    before = {
      counts: await counts(),
      cameras: await legacyCameraRows(),
      version: (await db.execute<{ v: number } & Record<string, unknown>>(sql`select version as v from static_data_state`))[0]!.v,
      migrations: await applied(),
    };
    expect(before.counts).toEqual({
      fixed_speed_cameras: 3,
      camera_removal_reports: 3,
      hazard_reports: 4,
      hazard_confirmations: 1,
      event_log: 3,
      static_signs: 1,
      speed_limit_segments: 1,
    });
  });

  it("migrates forward without losing or changing a row; every old camera becomes a speed camera", async () => {
    await withFreshConnection((d) => migrate(d, { migrationsFolder: MIGRATIONS }));

    expect(await columnExists()).toBe(true);
    expect(await counts()).toEqual(before.counts);
    expect(await legacyCameraRows()).toEqual(before.cameras);
    const kinds = await db.execute<{ camera_type: string; n: number } & Record<string, unknown>>(
      sql`select camera_type, count(*)::int as n from fixed_speed_cameras group by camera_type`,
    );
    expect(kinds.map((k) => [k.camera_type, k.n])).toEqual([["fixedSpeedCamera", 3]]);
    const column = await db.execute<{ is_nullable: string; column_default: string } & Record<string, unknown>>(sql`
      select is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'fixed_speed_cameras' and column_name = 'camera_type'`);
    expect(column[0]).toMatchObject({ is_nullable: "NO" });
    expect(column[0]!.column_default).toContain("fixedSpeedCamera");
    // The static-data version moved once, so clients refresh their packages.
    const version = (await db.execute<{ v: number } & Record<string, unknown>>(sql`select version as v from static_data_state`))[0]!.v;
    expect(version).toBe(before.version + 1);
    expect((await applied()).n).toBe(before.migrations.n + 1);
  });

  it("answers the old reads with what they answered before, plus the additive fields", async () => {
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      LOG_LEVEL: "silent",
      SPEED_CAMERA_NAMESPACE_ENABLED: "true",
      STATIC_PACKAGES_DIR: mkdtempSync(path.join(tmpdir(), "migration-packages-")),
    });
    dirs.push(env.STATIC_PACKAGES_DIR);
    const app = await buildApp({ env, db });
    try {
      const headers = authHeader(await testToken(env));
      const active = before.cameras.filter((c) => c["status"] === "active");

      const nearby = (await app.inject({ method: "GET", url: "/v1/speed-cameras/nearby?lat=52.52&lng=13.405&radiusM=2000", headers })).json().cameras as Json[];
      // Berlin's speed camera is the only persistent device there; the expiring reports keep their own types.
      expect(nearby.filter((c) => c["cameraType"] !== undefined).map((c) => c["id"])).toEqual(["00000000-0000-4000-8000-000000000001"]);
      expect(nearby.filter((c) => c["cameraType"] === undefined).map((c) => c["type"]).sort()).toEqual(["distanceControl", "redLightCamera"]);

      const snapshot = (await app.inject({ method: "GET", url: "/v1/snapshot", headers })).json() as Json;
      expect(snapshot.fixedSpeedCameras.map((c: Json) => c.id).sort()).toEqual(active.map((c) => c["id"]).sort());
      for (const camera of snapshot.fixedSpeedCameras as Json[]) {
        const old = active.find((c) => c["id"] === camera["id"])!;
        expect(camera.type).toBe("fixedSpeedCamera");
        expect(camera.status).toBe(old["status"]);
        expect(camera.source).toBe(old["source"]);
        expect(camera.sourceLicense).toBe(old["source_license"]);
        expect(camera.removalReportCount).toBe(0);
        expect(camera.cameraType).toBe("fixedSpeedCamera");
      }
      expect(snapshot.enforcementDevices.map((c: Json) => c.id).sort()).toEqual(active.map((c) => c["id"]).sort());
      expect(snapshot.staticSigns).toHaveLength(1);
      expect(snapshot.speedLimitSegments).toHaveLength(1);

      const delta = (await app.inject({ method: "GET", url: "/v1/delta?since=0&tiles=871f1d489ffffff", headers })).json().events as Json[];
      expect(delta.map((e) => [e["type"], e["entityType"]])).toEqual([
        ["StaticDataUpdated", "fixedSpeedCamera"],
        ["ReportCreated", "hazardReport"],
        ["StaticDataRemoved", "fixedSpeedCamera"],
      ]);
      expect(delta.map((e) => e["payload"]["type"])).toEqual(["fixedSpeedCamera", "redLightCamera", "fixedSpeedCamera"]);
    } finally {
      await app.close();
    }
  });

  it("runs a second time without effect on the data (the migration is guarded)", async () => {
    const statements = readFileSync(path.join(MIGRATIONS, `${TAG_0009}.sql`), "utf8")
      .split(STATEMENT_BREAKPOINT)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) await db.execute(sql.raw(statement));

    expect(await counts()).toEqual(before.counts);
    expect(await legacyCameraRows()).toEqual(before.cameras);
    const kinds = await db.execute<{ camera_type: string; n: number } & Record<string, unknown>>(sql`select camera_type, count(*)::int as n from fixed_speed_cameras group by camera_type`);
    expect(kinds.map((k) => [k.camera_type, k.n])).toEqual([["fixedSpeedCamera", 3]]);
  });

  it("names the migration's timestamp in the rollback script — the script and the journal cannot drift apart", () => {
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    const when = journal.entries.find((e) => e.tag === TAG_0009)!.when;
    expect(readFileSync(DOWN_SQL, "utf8")).toContain(`"created_at" = ${when}`);
  });

  it("rolls back to exactly the legacy state, and the migration can then run again", async () => {
    await runFile(DOWN_SQL);

    expect(await columnExists()).toBe(false);
    const type = await db.execute(sql`select 1 from pg_type where typname = 'camera_type'`);
    expect(type).toHaveLength(0);
    expect(await counts()).toEqual(before.counts);
    expect(await legacyCameraRows()).toEqual(before.cameras);
    expect(await applied()).toEqual(before.migrations);

    // A second rollback changes nothing and does not fail.
    await runFile(DOWN_SQL);
    expect(await counts()).toEqual(before.counts);

    await withFreshConnection((d) => migrate(d, { migrationsFolder: MIGRATIONS }));
    expect(await columnExists()).toBe(true);
    expect(await counts()).toEqual(before.counts);
    expect((await applied()).n).toBe(before.migrations.n + 1);
  });

  it("refuses to roll back while red-light or distance devices exist, and changes nothing", async () => {
    await db.execute(sql`
      insert into fixed_speed_cameras (position, camera_type, source) values (ST_SetSRID(ST_MakePoint(8.0, 50.0), 4326), 'redLightCamera', 'osm')`);
    const countsWithDevice = await counts();
    const migrationsBefore = await applied();

    await expect(runFile(DOWN_SQL)).rejects.toThrow(/Rollback refused/);

    expect(await columnExists()).toBe(true);
    expect(await counts()).toEqual(countsWithDevice);
    expect(await applied()).toEqual(migrationsBefore);
    const kinds = await db.execute<{ camera_type: string } & Record<string, unknown>>(sql`select camera_type from fixed_speed_cameras where camera_type <> 'fixedSpeedCamera'`);
    expect(kinds.map((k) => k.camera_type)).toEqual(["redLightCamera"]);

    // The documented way out: remove the rows on purpose, then roll back.
    await db.execute(sql`delete from fixed_speed_cameras where camera_type <> 'fixedSpeedCamera'`);
    await runFile(DOWN_SQL);
    expect(await columnExists()).toBe(false);
    expect(await counts()).toEqual(before.counts);
  });
});
