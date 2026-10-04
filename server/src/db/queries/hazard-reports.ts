import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import type { HazardType } from "../../config/constants.js";
import { pgArray } from "../pg-array.js";
import { envelopeOverlap, type Envelope } from "../../lib/geo-bbox.js";
import { toRecord, type CameraRecord } from "./camera-record.js";

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
  countries: string[] | null;
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

/** A report with its country set and position (see camera-record.ts); the set is only filled for the camera types. */
export type HazardReportRecord = CameraRecord<HazardReportApi>;

function toHazardRecord(row: Row): HazardReportRecord {
  return toRecord(toApi(row), row.countries);
}

const SELECT_COLUMNS = sql`
  id, type, ST_AsGeoJSON(position)::json as position_geojson, countries, region_tile, reported_at, reporter_id,
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
export async function findHazardReportRecordsByTiles(
  db: Queryable,
  tiles: string[],
  types?: HazardType[],
): Promise<HazardReportRecord[]> {
  const typeFilter = types && types.length > 0 ? sql`and type = any(${pgArray(types)}::hazard_type[])` : sql``;
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS}
    from hazard_reports
    where status = 'active' and region_tile = any(${pgArray(tiles)}) ${typeFilter}
  `);
  return rows.map(toHazardRecord);
}

/** For the general /v1/hazard-reports/* reads, which only ever ask for non-camera types (no policy involved). */
export async function findHazardReportsByTiles(db: Queryable, tiles: string[], types?: HazardType[]): Promise<HazardReportApi[]> {
  return (await findHazardReportRecordsByTiles(db, tiles, types)).map((r) => r.item);
}

/** Active reports of the given types whose position lies in one of the envelopes (index-assisted superset; the caller narrows by cell). */
export async function findHazardReportRecordsInEnvelopes(
  db: Queryable,
  envelopes: readonly Envelope[],
  types: HazardType[],
): Promise<HazardReportRecord[]> {
  if (types.length === 0 || envelopes.length === 0) return [];
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS}
    from hazard_reports
    where status = 'active' and type = any(${pgArray(types)}::hazard_type[]) and ${envelopeOverlap(sql`position`, envelopes)}
  `);
  return rows.map(toHazardRecord);
}

/** Every active report of the given types, wherever it is (camera snapshot: the number of live camera reports is small by construction — they expire within hours). */
export async function findAllActiveHazardReportRecords(db: Queryable, types: HazardType[]): Promise<HazardReportRecord[]> {
  if (types.length === 0) return [];
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS}
    from hazard_reports
    where status = 'active' and type = any(${pgArray(types)}::hazard_type[])
  `);
  return rows.map(toHazardRecord);
}

export async function findHazardReportsNearby(
  db: Queryable,
  lat: number,
  lng: number,
  radiusM: number,
  types?: HazardType[],
): Promise<HazardReportApi[]> {
  return (await findHazardReportRecordsNearby(db, lat, lng, radiusM, types)).map((r) => r.item);
}

export async function findHazardReportRecordsNearby(
  db: Queryable,
  lat: number,
  lng: number,
  radiusM: number,
  types?: HazardType[],
): Promise<HazardReportRecord[]> {
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
  return rows.map(toHazardRecord);
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
): Promise<HazardReportRecord | null> {
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
  return row ? toHazardRecord(row) : null;
}

/** Also locks the row — the confirm endpoint mutates it in the same transaction. */
export async function findHazardReportByIdForUpdate(db: Queryable, id: string): Promise<HazardReportRecord | null> {
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS} from hazard_reports where id = ${id} for update
  `);
  const row = rows[0];
  return row ? toHazardRecord(row) : null;
}

export interface InsertHazardReportInput {
  type: Exclude<HazardType, "fixedSpeedCamera">;
  lat: number;
  lng: number;
  reporterId: string;
  speedKmh?: number;
  regionTile: string;
  expiresAt: Date;
  /** Set for the camera types: CAMERA_POLICY_BORDER_MARGIN_M, so the country set is computed here, once. Omitted for every other type. */
  countryMarginM?: number;
}

export async function insertHazardReportRow(db: Queryable, input: InsertHazardReportInput): Promise<HazardReportRecord> {
  const countries =
    input.countryMarginM === undefined
      ? sql`null`
      : sql`camera_countries(ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326), ${input.countryMarginM})`;
  const rows = await db.execute<Row>(sql`
    insert into hazard_reports (type, position, countries, region_tile, reporter_id, speed_kmh, expires_at, status, source)
    values (
      ${input.type}::hazard_type,
      ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326),
      ${countries},
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
  return toHazardRecord(row);
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
): Promise<HazardReportRecord> {
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
  return toHazardRecord(row);
}

// ---------------------------------------------------------------------------------------------
// Seed reports (source = 'seed'): authoritative, periodically re-imported reports such as roadworks
// from a national access point. Identity is (source_feed, external_id); see db/schema/hazards.ts and
// modules/bulk-import/seed-reports.ts for the rules that use these.
// ---------------------------------------------------------------------------------------------

export interface ExistingSeedRow {
  id: string;
  externalId: string;
  status: "active" | "expired" | "removed";
  expiresAt: Date;
  lat: number;
  lng: number;
}

/** Locks (FOR UPDATE) the existing rows of one feed for a batch of external ids — the upsert decides per row from this. */
export async function findSeedReportsForUpdate(db: Queryable, feedId: string, externalIds: string[]): Promise<ExistingSeedRow[]> {
  const rows = await db.execute<{ id: string; external_id: string; status: ExistingSeedRow["status"]; expires_at: string; lat: number; lng: number } & Record<string, unknown>>(sql`
    select id, external_id, status, expires_at, ST_Y(position) as lat, ST_X(position) as lng
    from hazard_reports
    where source_feed = ${feedId} and external_id = any(${pgArray(externalIds)}::text[])
    for update
  `);
  return rows.map((r) => ({ id: r.id, externalId: r.external_id, status: r.status, expiresAt: new Date(r.expires_at), lat: Number(r.lat), lng: Number(r.lng) }));
}

export interface InsertSeedReportInput {
  type: Exclude<HazardType, "fixedSpeedCamera">;
  lat: number;
  lng: number;
  reporterId: string;
  regionTile: string;
  expiresAt: Date;
  sourceLicense: string;
  feedId: string;
  externalId: string;
  runId: string;
}

/** Returns null when a concurrent import inserted the same (feed, external id) first — the caller then treats it as an existing row. */
export async function insertSeedReportRow(db: Queryable, input: InsertSeedReportInput): Promise<HazardReportApi | null> {
  const rows = await db.execute<Row>(sql`
    insert into hazard_reports (type, position, region_tile, reporter_id, expires_at, status, source, source_license, source_feed, external_id, last_seen_run)
    values (
      ${input.type}::hazard_type,
      ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326),
      ${input.regionTile},
      ${input.reporterId},
      ${input.expiresAt.toISOString()},
      'active',
      'seed',
      ${input.sourceLicense},
      ${input.feedId},
      ${input.externalId},
      ${input.runId}
    )
    on conflict (source_feed, external_id) where source_feed is not null do nothing
    returning ${SELECT_COLUMNS}
  `);
  const row = rows[0];
  return row ? toApi(row) : null;
}

export interface UpdateSeedReportInput {
  id: string;
  lat: number;
  lng: number;
  regionTile: string;
  expiresAt: Date;
  sourceLicense: string;
  runId: string;
}

/** Re-activates (if it had expired) and refreshes position/expiry/license of an existing seed row; returns the new state. */
export async function updateSeedReportRow(db: Queryable, input: UpdateSeedReportInput): Promise<HazardReportApi> {
  const rows = await db.execute<Row>(sql`
    update hazard_reports
    set position = ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326),
        region_tile = ${input.regionTile},
        expires_at = ${input.expiresAt.toISOString()},
        status = 'active',
        source_license = ${input.sourceLicense},
        last_seen_run = ${input.runId},
        updated_at = now()
    where id = ${input.id}
    returning ${SELECT_COLUMNS}
  `);
  const row = rows[0];
  if (!row) throw new Error("updateSeedReportRow: update returned no row");
  return toApi(row);
}

/** Marks rows as seen by this run and (optionally) moves their expiry, without changing anything a client would render. No event. */
export async function touchSeedReports(db: Queryable, ids: string[], runId: string, newExpiresAt?: Date): Promise<void> {
  if (ids.length === 0) return;
  await db.execute(sql`
    update hazard_reports
    set last_seen_run = ${runId},
        expires_at = ${newExpiresAt ? newExpiresAt.toISOString() : sql`expires_at`},
        updated_at = now()
    where id = any(${pgArray(ids)}::uuid[])
  `);
}

export async function countSeedReportsOfRun(db: Queryable, feedId: string, runId: string): Promise<number> {
  const rows = await db.execute<{ n: number } & Record<string, unknown>>(sql`
    select count(*)::int as n from hazard_reports where source_feed = ${feedId} and last_seen_run = ${runId}
  `);
  return Number(rows[0]?.n ?? 0);
}

export interface RetiredSeedRow {
  id: string;
  type: string;
  regionTile: string;
}

/** Expires every active row of the feed that this run did not see (locks them first); returns what was retired for the events. */
export async function retireUnseenSeedReports(db: Queryable, feedId: string, runId: string): Promise<RetiredSeedRow[]> {
  const rows = await db.execute<{ id: string; type: string; region_tile: string } & Record<string, unknown>>(sql`
    update hazard_reports
    set status = 'expired', updated_at = now()
    where id in (
      select id from hazard_reports
      where source_feed = ${feedId} and status = 'active' and last_seen_run is distinct from ${runId}
      for update skip locked
    )
    returning id, type, region_tile
  `);
  return rows.map((r) => ({ id: r.id, type: r.type, regionTile: r.region_tile }));
}
