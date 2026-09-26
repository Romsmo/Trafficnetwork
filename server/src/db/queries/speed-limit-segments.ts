import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import type { SpeedLimitUnit } from "../../config/constants.js";
import { isoTimestamp } from "../sql-iso.js";
import { bboxPrefilter } from "../../lib/geo-bbox.js";

/**
 * Community-correction detail attached to a segment whose *effective* value is
 * a correction (add-on K-A). Absent entirely on an uncorrected segment, so the
 * static packages only pay for it where it applies.
 */
export interface SpeedLimitCorrectionInfo {
  id: string;
  /** Distinct devices currently supporting this value (as of the last transition when read from a package). */
  confirmations: number;
  denials: number;
  /** When this server put the correction into effect. */
  appliedAt: string | null;
  /** The imported value changed to something else since the correction was proposed — see docs/speed-limit-corrections.md D7. */
  needsReview: boolean;
}

export interface SpeedLimitSegmentApi {
  id: string;
  geometry: unknown; // GeoJSON LineString
  /** Cross-server-stable identity of the geometry (32 hex chars) — what a device-signed correction vote references. */
  segmentKey: string;
  /** The *effective* value: the applied community correction if there is one, else the imported value. */
  speedLimit: number;
  speedLimitUnit: SpeedLimitUnit;
  source: string;
  sourceLicense: string | null;
  importedAt: string;
  lastConfirmedAt: string | null;
  /** Present (and always "community") only when `speedLimit` is a correction rather than the imported value. */
  correctedBy?: "community";
  /** The value from the import source — kept so the origin stays checkable. Only present alongside correctedBy. */
  importedSpeedLimit?: number;
  correction?: SpeedLimitCorrectionInfo;
}

interface Row extends Record<string, unknown> {
  id: string;
  geometry_geojson: unknown;
  segment_key: string;
  speed_limit: number;
  speed_limit_unit: SpeedLimitUnit;
  source: string;
  source_license: string | null;
  imported_at: string;
  last_confirmed_at: string | null;
  imported_speed_limit: number;
  correction_id: string | null;
  support_count: number | null;
  deny_count: number | null;
  correction_applied_at: string | null;
  needs_review: boolean | null;
}

/**
 * Every segment read goes through this one column list and FROM clause, so the
 * effective value can never differ between snapshot, packages, nearby and
 * lookup. `overlay` is COMMUNITY_CORRECTIONS_ENABLED: when off, the join can
 * never match and every read returns the imported value.
 *
 * The overlay applies only for an `applied` correction on the same geometry
 * key *and unit* whose value actually differs from the row's imported value —
 * if a later import already agrees with the community, the correction is
 * redundant and the row is served as a plain imported one.
 */
const COLUMNS = sql`
  s.id, ST_AsGeoJSON(s.geometry)::json as geometry_geojson, s.geometry_key as segment_key,
  coalesce(c.value, s.speed_limit) as speed_limit, s.speed_limit_unit,
  s.source, s.source_license, s.imported_at, s.last_confirmed_at,
  s.speed_limit as imported_speed_limit,
  c.id as correction_id, c.support_count, c.deny_count, ${isoTimestamp("c.applied_at")} as correction_applied_at,
  (c.id is not null and c.base_value is not null and s.speed_limit <> c.base_value) as needs_review
`;

function fromClause(overlay: boolean) {
  return overlay
    ? sql`from speed_limit_segments s
          left join speed_limit_corrections c
            on c.segment_key = s.geometry_key and c.unit = s.speed_limit_unit
           and c.status = 'applied' and c.value <> s.speed_limit`
    : sql`from speed_limit_segments s left join speed_limit_corrections c on false`;
}

export function toSegmentApi(row: Row): SpeedLimitSegmentApi {
  const api: SpeedLimitSegmentApi = {
    id: row.id,
    geometry: row.geometry_geojson,
    segmentKey: row.segment_key,
    speedLimit: row.speed_limit,
    speedLimitUnit: row.speed_limit_unit,
    source: row.source,
    sourceLicense: row.source_license,
    importedAt: row.imported_at,
    lastConfirmedAt: row.last_confirmed_at,
  };
  if (row.correction_id) {
    api.correctedBy = "community";
    api.importedSpeedLimit = row.imported_speed_limit;
    api.correction = {
      id: row.correction_id,
      confirmations: row.support_count ?? 0,
      denials: row.deny_count ?? 0,
      appliedAt: row.correction_applied_at,
      needsReview: row.needs_review ?? false,
    };
  }
  return api;
}

/** Full table — used by the snapshot endpoint (static data syncs globally, always in full). */
export async function findAllSpeedLimitSegments(db: Queryable, overlay: boolean): Promise<SpeedLimitSegmentApi[]> {
  const rows = await db.execute<Row>(sql`select ${COLUMNS} ${fromClause(overlay)}`);
  return rows.map(toSegmentApi);
}

export async function findSpeedLimitSegmentsNearby(
  db: Queryable,
  lat: number,
  lng: number,
  radiusM: number,
  overlay: boolean,
): Promise<SpeedLimitSegmentApi[]> {
  const rows = await db.execute<Row>(sql`
    select ${COLUMNS} ${fromClause(overlay)}
    where ${bboxPrefilter(sql`s.geometry`, lat, lng, radiusM)}ST_DWithin(
      s.geometry::geography,
      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
      ${radiusM}
    )
  `);
  return rows.map(toSegmentApi);
}

/** One segment by row id, with the overlay applied — null if there is no such row. */
export async function findSpeedLimitSegmentById(db: Queryable, id: string, overlay: boolean): Promise<SpeedLimitSegmentApi | null> {
  const rows = await db.execute<Row>(sql`select ${COLUMNS} ${fromClause(overlay)} where s.id = ${id}`);
  return rows[0] ? toSegmentApi(rows[0]) : null;
}

/** All rows sharing a geometry key (a re-import creates duplicates) and unit, overlay applied — used to emit one event per affected row. */
export async function findSpeedLimitSegmentsByKey(
  db: Queryable,
  segmentKey: string,
  unit: SpeedLimitUnit,
  overlay: boolean,
): Promise<SpeedLimitSegmentApi[]> {
  const rows = await db.execute<Row>(sql`
    select ${COLUMNS} ${fromClause(overlay)}
    where s.geometry_key = ${segmentKey} and s.speed_limit_unit = ${unit}::speed_limit_unit
    order by s.imported_at, s.id
  `);
  return rows.map(toSegmentApi);
}

export interface SpeedLimitLookupResult {
  speedLimit: number;
  speedLimitUnit: SpeedLimitUnit;
  distanceMeters: number;
  segmentId: string;
  segmentKey: string;
  /** Same additive origin fields as on a segment. */
  correctedBy?: "community";
  importedSpeedLimit?: number;
  correction?: SpeedLimitCorrectionInfo;
}

/**
 * Nearest segment within maxDistanceM, or null if nothing is close enough. Uses
 * ST_DWithin to prune candidates (index-assisted at the bounding-box level via the
 * existing geometry GIST index) before ordering the small remaining set by exact
 * geodesic distance — a plain `ORDER BY geometry <-> point LIMIT 1` would be faster
 * per-query but ambiguous once maxDistanceM is meant to be a hard cutoff, since
 * planar `<->` distance isn't in meters.
 */
export async function findNearestSpeedLimit(
  db: Queryable,
  lat: number,
  lng: number,
  maxDistanceM: number,
  overlay: boolean,
): Promise<SpeedLimitLookupResult | null> {
  const rows = await db.execute<Row & { distance_m: number }>(sql`
    select ${COLUMNS},
           ST_Distance(s.geometry::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) as distance_m
    ${fromClause(overlay)}
    where ${bboxPrefilter(sql`s.geometry`, lat, lng, maxDistanceM)}ST_DWithin(
      s.geometry::geography,
      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
      ${maxDistanceM}
    )
    order by distance_m asc
    limit 1
  `);
  const row = rows[0];
  if (!row) return null;
  const segment = toSegmentApi(row);
  const result: SpeedLimitLookupResult = {
    segmentId: segment.id,
    segmentKey: segment.segmentKey,
    speedLimit: segment.speedLimit,
    speedLimitUnit: segment.speedLimitUnit,
    distanceMeters: row.distance_m,
  };
  if (segment.correction) {
    result.correctedBy = segment.correctedBy;
    result.importedSpeedLimit = segment.importedSpeedLimit;
    result.correction = segment.correction;
  }
  return result;
}
