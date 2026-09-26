import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import { bboxPrefilter } from "../../lib/geo-bbox.js";

export interface SpeedLimitSegmentApi {
  id: string;
  geometry: unknown; // GeoJSON LineString
  speedLimit: number;
  speedLimitUnit: "kmh" | "mph";
  source: string;
  sourceLicense: string | null;
  importedAt: string;
  lastConfirmedAt: string | null;
}

interface Row extends Record<string, unknown> {
  id: string;
  geometry_geojson: unknown;
  speed_limit: number;
  speed_limit_unit: "kmh" | "mph";
  source: string;
  source_license: string | null;
  imported_at: string;
  last_confirmed_at: string | null;
}

function toApi(row: Row): SpeedLimitSegmentApi {
  return {
    id: row.id,
    geometry: row.geometry_geojson,
    speedLimit: row.speed_limit,
    speedLimitUnit: row.speed_limit_unit,
    source: row.source,
    sourceLicense: row.source_license,
    importedAt: row.imported_at,
    lastConfirmedAt: row.last_confirmed_at,
  };
}

/** Full table — used by the snapshot endpoint (static data syncs globally, always in full). */
export async function findAllSpeedLimitSegments(db: Queryable): Promise<SpeedLimitSegmentApi[]> {
  const rows = await db.execute<Row>(sql`
    select id, ST_AsGeoJSON(geometry)::json as geometry_geojson, speed_limit, speed_limit_unit,
           source, source_license, imported_at, last_confirmed_at
    from speed_limit_segments
  `);
  return rows.map(toApi);
}

export async function findSpeedLimitSegmentsNearby(
  db: Queryable,
  lat: number,
  lng: number,
  radiusM: number,
): Promise<SpeedLimitSegmentApi[]> {
  const rows = await db.execute<Row>(sql`
    select id, ST_AsGeoJSON(geometry)::json as geometry_geojson, speed_limit, speed_limit_unit,
           source, source_license, imported_at, last_confirmed_at
    from speed_limit_segments
    where ${bboxPrefilter(sql`geometry`, lat, lng, radiusM)}ST_DWithin(
      geometry::geography,
      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
      ${radiusM}
    )
  `);
  return rows.map(toApi);
}

export interface SpeedLimitLookupResult {
  speedLimit: number;
  speedLimitUnit: "kmh" | "mph";
  distanceMeters: number;
  segmentId: string;
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
): Promise<SpeedLimitLookupResult | null> {
  const rows = await db.execute<
    {
      id: string;
      speed_limit: number;
      speed_limit_unit: "kmh" | "mph";
      distance_m: number;
    } & Record<string, unknown>
  >(sql`
    select id, speed_limit, speed_limit_unit,
           ST_Distance(geometry::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) as distance_m
    from speed_limit_segments
    where ${bboxPrefilter(sql`geometry`, lat, lng, maxDistanceM)}ST_DWithin(
      geometry::geography,
      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
      ${maxDistanceM}
    )
    order by distance_m asc
    limit 1
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    segmentId: row.id,
    speedLimit: row.speed_limit,
    speedLimitUnit: row.speed_limit_unit,
    distanceMeters: row.distance_m,
  };
}
