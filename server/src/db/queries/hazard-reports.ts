import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import type { HazardType } from "../../config/constants.js";
import { pgArray } from "../pg-array.js";

export interface HazardReportApi {
  id: string;
  type: HazardType;
  position: unknown; // GeoJSON Point
  regionTile: string;
  reportedAt: string;
  reporterId: string;
  speedKmh: number | null;
  expiresAt: string;
  status: "active" | "expired" | "removed";
  source: "community" | "seed";
  sourceLicense: string | null;
  confirmCount: number;
  denyCount: number;
}

interface Row extends Record<string, unknown> {
  id: string;
  type: HazardType;
  position_geojson: unknown;
  region_tile: string;
  reported_at: string;
  reporter_id: string;
  speed_kmh: number | null;
  expires_at: string;
  status: "active" | "expired" | "removed";
  source: "community" | "seed";
  source_license: string | null;
  confirm_count: number;
  deny_count: number;
}

function toApi(row: Row): HazardReportApi {
  return {
    id: row.id,
    type: row.type,
    position: row.position_geojson,
    regionTile: row.region_tile,
    reportedAt: row.reported_at,
    reporterId: row.reporter_id,
    speedKmh: row.speed_kmh,
    expiresAt: row.expires_at,
    status: row.status,
    source: row.source,
    sourceLicense: row.source_license,
    confirmCount: row.confirm_count,
    denyCount: row.deny_count,
  };
}

const SELECT_COLUMNS = sql`
  id, type, ST_AsGeoJSON(position)::json as position_geojson, region_tile, reported_at, reporter_id,
  speed_kmh, expires_at, status, source, source_license, confirm_count, deny_count
`;

/**
 * Camera-adjacent types (mobileSpeedCamera, trailerCamera, redLightCamera,
 * distanceControl) are filtered out here unless the namespace flag is on — see
 * modules/cameras/filter.ts (introduced in milestone P1.4). Not yet applied below:
 * these functions serve the general /v1/hazard-reports/* reads, which are always
 * restricted to NON_CAMERA_HAZARD_TYPES at the route layer (see
 * modules/hazard-reports/routes.ts) regardless of what `types` the caller passes.
 */
export async function findHazardReportsByTiles(
  db: Queryable,
  tiles: string[],
  types?: HazardType[],
): Promise<HazardReportApi[]> {
  const typeFilter = types && types.length > 0 ? sql`and type = any(${pgArray(types)}::hazard_type[])` : sql``;
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS}
    from hazard_reports
    where status = 'active' and region_tile = any(${pgArray(tiles)}) ${typeFilter}
  `);
  return rows.map(toApi);
}

export async function findHazardReportsNearby(
  db: Queryable,
  lat: number,
  lng: number,
  radiusM: number,
  types?: HazardType[],
): Promise<HazardReportApi[]> {
  const typeFilter = types && types.length > 0 ? sql`and type = any(${pgArray(types)}::hazard_type[])` : sql``;
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS}
    from hazard_reports
    where status = 'active' ${typeFilter}
      and ST_DWithin(
        position::geography,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
        ${radiusM}
      )
  `);
  return rows.map(toApi);
}

/**
 * Locks a candidate row (FOR UPDATE) so two concurrent submissions at the same
 * spot can't both miss each other and create two reports — the second submission
 * blocks until the first's transaction commits, then re-evaluates. Only ever
 * called from within the write-path transaction in modules/hazard-reports/service.ts.
 */
export async function findDuplicateCandidate(
  db: Queryable,
  type: HazardType,
  lat: number,
  lng: number,
  radiusM: number,
): Promise<HazardReportApi | null> {
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS}
    from hazard_reports
    where status = 'active' and type = ${type}::hazard_type
      and ST_DWithin(
        position::geography,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
        ${radiusM}
      )
    order by reported_at asc
    limit 1
    for update
  `);
  const row = rows[0];
  return row ? toApi(row) : null;
}

/** Also locks the row — the confirm endpoint mutates it in the same transaction. */
export async function findHazardReportByIdForUpdate(db: Queryable, id: string): Promise<HazardReportApi | null> {
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS} from hazard_reports where id = ${id} for update
  `);
  const row = rows[0];
  return row ? toApi(row) : null;
}

export interface InsertHazardReportInput {
  type: Exclude<HazardType, "fixedSpeedCamera">;
  lat: number;
  lng: number;
  reporterId: string;
  speedKmh?: number;
  regionTile: string;
  expiresAt: Date;
}

export async function insertHazardReportRow(db: Queryable, input: InsertHazardReportInput): Promise<HazardReportApi> {
  const rows = await db.execute<Row>(sql`
    insert into hazard_reports (type, position, region_tile, reporter_id, speed_kmh, expires_at, status, source)
    values (
      ${input.type}::hazard_type,
      ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326),
      ${input.regionTile},
      ${input.reporterId},
      ${input.speedKmh ?? null},
      ${input.expiresAt.toISOString()},
      'active',
      'community'
    )
    returning ${SELECT_COLUMNS}
  `);
  const row = rows[0];
  if (!row) throw new Error("insertHazardReportRow: insert returned no row");
  return toApi(row);
}

/** True if this reporter had not already recorded a confirmation/denial for this report. */
export async function insertConfirmationIfAbsent(
  db: Queryable,
  hazardReportId: string,
  reporterId: string,
  kind: "stillThere" | "gone",
): Promise<boolean> {
  const rows = await db.execute<{ id: number } & Record<string, unknown>>(sql`
    insert into hazard_confirmations (hazard_report_id, reporter_id, confirmation)
    values (${hazardReportId}, ${reporterId}, ${kind}::confirmation_kind)
    on conflict (hazard_report_id, reporter_id) do nothing
    returning id
  `);
  return rows.length > 0;
}

export interface ApplyConfirmationEffectInput {
  id: string;
  incrementConfirm?: boolean;
  incrementDeny?: boolean;
  newExpiresAt?: Date;
}

/** Applies the counter/expiry side effects of a confirmation and returns the updated row. */
export async function applyConfirmationEffect(
  db: Queryable,
  input: ApplyConfirmationEffectInput,
): Promise<HazardReportApi> {
  const rows = await db.execute<Row>(sql`
    update hazard_reports
    set
      confirm_count = confirm_count + ${input.incrementConfirm ? 1 : 0},
      deny_count = deny_count + ${input.incrementDeny ? 1 : 0},
      expires_at = ${input.newExpiresAt ? input.newExpiresAt.toISOString() : sql`expires_at`},
      updated_at = now()
    where id = ${input.id}
    returning ${SELECT_COLUMNS}
  `);
  const row = rows[0];
  if (!row) throw new Error("applyConfirmationEffect: update returned no row");
  return toApi(row);
}
