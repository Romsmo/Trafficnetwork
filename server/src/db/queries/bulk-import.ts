import { sql } from "drizzle-orm";
import { latLngToCell } from "h3-js";
import type { Queryable } from "../client.js";
import { pgArray } from "../pg-array.js";
import { bumpStaticDataVersion } from "./sync-state.js";
import { fillMissingBaseValues } from "./speed-limit-corrections.js";
import { markTilesDirty } from "./static-packages.js";

/**
 * Bulk-import writes go straight to the materialized tables without appending
 * event_log rows — a deliberate rule (docs/concept.md section 7): one call can
 * insert thousands of rows, and logging one event per row would let a single
 * ingestion run dominate the event log's size and the retention window's
 * relevance for everyone else. Static data catch-up after a bulk import is via
 * the static packages (or a fresh snapshot), not /v1/delta. Each call still bumps
 * static_data_state (see bumpStaticDataVersion) and marks the partition tiles it
 * touched as dirty in the same transaction, so the package builder (add-on E-B,
 * docs/europe-scale.md) rebuilds exactly those tiles and clients see a new
 * version — with zero event-log rows however large the import is
 * (tests/integration/europe-scale.test.ts pins that).
 *
 * One `insert … select … from unnest(arrays)` statement per call instead of one
 * INSERT per row: the per-row round trip was the whole cost (about 1,200 rows/s
 * measured at 0.5M rows against a local Postgres; see docs/operating.md for the
 * batched figure). Arrays go in as text literals (db/pg-array.ts) and are cast
 * back per column, which also keeps the statement text — and so the plan — the same
 * whatever the batch size.
 */

export interface BulkImportOptions {
  /** STATIC_DATA_PARTITION_H3_RESOLUTION — needed to know which package tiles the rows dirty. */
  partitionResolution: number;
}

export interface SpeedLimitSegmentImportRow {
  lineString: [number, number][];
  speedLimit: number;
  speedLimitUnit: "kmh" | "mph";
  source: string;
  sourceLicense?: string;
  importedAt?: string;
}

export async function bulkInsertSpeedLimitSegments(db: Queryable, rows: SpeedLimitSegmentImportRow[], opts: BulkImportOptions): Promise<number> {
  const nowIso = new Date().toISOString();
  const tiles = new Set<string>();
  for (const row of rows) for (const [lng, lat] of row.lineString) tiles.add(latLngToCell(lat, lng, opts.partitionResolution));

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into speed_limit_segments (geometry, speed_limit, speed_limit_unit, source, source_license, imported_at)
      select ST_SetSRID(ST_GeomFromText(t.wkt), 4326), t.speed_limit, t.unit::speed_limit_unit, t.source, nullif(t.license, ''), t.imported_at
      from unnest(
        ${pgArray(rows.map((r) => `LINESTRING(${r.lineString.map(([lng, lat]) => `${lng} ${lat}`).join(", ")})`))}::text[],
        ${pgArray(rows.map((r) => String(r.speedLimit)))}::int[],
        ${pgArray(rows.map((r) => r.speedLimitUnit))}::text[],
        ${pgArray(rows.map((r) => r.source))}::text[],
        ${pgArray(rows.map((r) => r.sourceLicense ?? ""))}::text[],
        ${pgArray(rows.map((r) => r.importedAt ?? nowIso))}::timestamptz[]
      ) as t(wkt, speed_limit, unit, source, license, imported_at)
    `);
    // Import only ever *adds* rows — it never touches an applied community
    // correction (those live in their own table, keyed by geometry, and are
    // overlaid at read time). The one bookkeeping step: a correction that was
    // voted on before its segment existed learns the value it now sits on.
    await fillMissingBaseValues(tx);
    await bumpStaticDataVersion(tx);
    await markTilesDirty(tx, [...tiles]);
    return rows.length;
  });
}

export interface StaticSignImportRow {
  lat: number;
  lng: number;
  signType: string;
  source: string;
  sourceLicense?: string;
  importedAt?: string;
}

export async function bulkInsertStaticSigns(db: Queryable, rows: StaticSignImportRow[], opts: BulkImportOptions): Promise<number> {
  const nowIso = new Date().toISOString();
  const tiles = new Set(rows.map((r) => latLngToCell(r.lat, r.lng, opts.partitionResolution)));

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into static_signs (position, sign_type, source, source_license, imported_at)
      select ST_SetSRID(ST_MakePoint(t.lng, t.lat), 4326), t.sign_type, t.source, nullif(t.license, ''), t.imported_at
      from unnest(
        ${pgArray(rows.map((r) => String(r.lng)))}::float8[],
        ${pgArray(rows.map((r) => String(r.lat)))}::float8[],
        ${pgArray(rows.map((r) => r.signType))}::text[],
        ${pgArray(rows.map((r) => r.source))}::text[],
        ${pgArray(rows.map((r) => r.sourceLicense ?? ""))}::text[],
        ${pgArray(rows.map((r) => r.importedAt ?? nowIso))}::timestamptz[]
      ) as t(lng, lat, sign_type, source, license, imported_at)
    `);
    await bumpStaticDataVersion(tx);
    await markTilesDirty(tx, [...tiles]);
    return rows.length;
  });
}

export interface FixedSpeedCameraImportRow {
  lat: number;
  lng: number;
  source: string;
  sourceLicense?: string;
  importedAt?: string;
}

export async function bulkInsertFixedSpeedCameras(db: Queryable, rows: FixedSpeedCameraImportRow[], opts: BulkImportOptions): Promise<number> {
  const nowIso = new Date().toISOString();
  const tiles = new Set(rows.map((r) => latLngToCell(r.lat, r.lng, opts.partitionResolution)));

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into fixed_speed_cameras (position, source, source_license, imported_at)
      select ST_SetSRID(ST_MakePoint(t.lng, t.lat), 4326), t.source, nullif(t.license, ''), t.imported_at
      from unnest(
        ${pgArray(rows.map((r) => String(r.lng)))}::float8[],
        ${pgArray(rows.map((r) => String(r.lat)))}::float8[],
        ${pgArray(rows.map((r) => r.source))}::text[],
        ${pgArray(rows.map((r) => r.sourceLicense ?? ""))}::text[],
        ${pgArray(rows.map((r) => r.importedAt ?? nowIso))}::timestamptz[]
      ) as t(lng, lat, source, license, imported_at)
    `);
    await bumpStaticDataVersion(tx);
    await markTilesDirty(tx, [...tiles]);
    return rows.length;
  });
}
