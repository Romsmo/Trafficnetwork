import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";

/**
 * Bulk-import writes go straight to the materialized tables without appending
 * event_log rows — a deliberate simplification: a single call can insert up to
 * BULK_IMPORT_MAX_ROWS rows, and logging one event per row would let one
 * ingestion run dominate the event log's size and the retention window's
 * relevance for everyone else. Static data catch-up after a bulk import is via
 * a fresh /v1/snapshot, not /v1/delta — acceptable since bulk-import is an
 * infrequent, mostly one-time operation (docs/concept.md section 7), not a
 * steady stream of individually-relevant changes.
 *
 * Rows are inserted one at a time inside a single transaction rather than one
 * multi-row statement — simpler code, and fine at the row-count cap used here;
 * revisit (e.g. UNNEST-based batch insert) if that cap is ever raised
 * significantly for Phase 3 ingestion's real data volumes.
 */

export interface SpeedLimitSegmentImportRow {
  lineString: [number, number][];
  speedLimit: number;
  speedLimitUnit: "kmh" | "mph";
  source: string;
  sourceLicense?: string;
  importedAt?: string;
}

export async function bulkInsertSpeedLimitSegments(db: Queryable, rows: SpeedLimitSegmentImportRow[]): Promise<number> {
  return db.transaction(async (tx) => {
    for (const row of rows) {
      const wkt = `LINESTRING(${row.lineString.map(([lng, lat]) => `${lng} ${lat}`).join(", ")})`;
      await tx.execute(sql`
        insert into speed_limit_segments (geometry, speed_limit, speed_limit_unit, source, source_license, imported_at)
        values (
          ST_SetSRID(ST_GeomFromText(${wkt}), 4326), ${row.speedLimit}, ${row.speedLimitUnit}::speed_limit_unit,
          ${row.source}, ${row.sourceLicense ?? null}, ${row.importedAt ?? new Date().toISOString()}
        )
      `);
    }
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

export async function bulkInsertStaticSigns(db: Queryable, rows: StaticSignImportRow[]): Promise<number> {
  return db.transaction(async (tx) => {
    for (const row of rows) {
      await tx.execute(sql`
        insert into static_signs (position, sign_type, source, source_license, imported_at)
        values (
          ST_SetSRID(ST_MakePoint(${row.lng}, ${row.lat}), 4326), ${row.signType},
          ${row.source}, ${row.sourceLicense ?? null}, ${row.importedAt ?? new Date().toISOString()}
        )
      `);
    }
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

export async function bulkInsertFixedSpeedCameras(db: Queryable, rows: FixedSpeedCameraImportRow[]): Promise<number> {
  return db.transaction(async (tx) => {
    for (const row of rows) {
      await tx.execute(sql`
        insert into fixed_speed_cameras (position, source, source_license, imported_at)
        values (
          ST_SetSRID(ST_MakePoint(${row.lng}, ${row.lat}), 4326),
          ${row.source}, ${row.sourceLicense ?? null}, ${row.importedAt ?? new Date().toISOString()}
        )
      `);
    }
    return rows.length;
  });
}
