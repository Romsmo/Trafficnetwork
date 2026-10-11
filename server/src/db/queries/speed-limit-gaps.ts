import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import type { SpeedLimitUnit } from "../../config/constants.js";
import type { GapGeometry } from "../../modules/speed-limit-corrections/gap.js";
import { gapGeoJson } from "../../modules/speed-limit-corrections/gap.js";

/**
 * Persistence for "this road has no speed limit on record" proposals (docs/speed-limit-corrections.md D13). The rules
 * live in modules/speed-limit-corrections/{gap,service}.ts; this file is only SQL.
 */

export const COMMUNITY_SOURCE = "community";
export const COMMUNITY_LICENSE = "community contribution";

/** Remembers where a gap is. Idempotent: the key is derived from the geometry, so a second vote for the same place is a no-op. */
export async function upsertGap(tx: Queryable, gap: GapGeometry): Promise<void> {
  await tx.execute(sql`
    insert into speed_limit_gaps (segment_key, cell, axis, geometry)
    values (${gap.segmentKey}, ${gap.cell}, ${gap.axis}, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(gapGeoJson(gap))}), 4326))
    on conflict (segment_key) do nothing
  `);
}

export interface GapRow {
  segmentKey: string;
  cell: string;
  axis: number;
  geometry: { type: "LineString"; coordinates: [number, number][] };
  needsReview: boolean;
}

interface GapRaw extends Record<string, unknown> {
  segment_key: string;
  cell: string;
  axis: number;
  geometry_geojson: GapRow["geometry"];
  needs_review: boolean;
}

export async function findGap(db: Queryable, segmentKey: string): Promise<GapRow | null> {
  const rows = await db.execute<GapRaw>(sql`
    select segment_key, cell, axis, ST_AsGeoJSON(geometry)::json as geometry_geojson, needs_review
    from speed_limit_gaps where segment_key = ${segmentKey}
  `);
  const r = rows[0];
  return r ? { segmentKey: r.segment_key, cell: r.cell, axis: r.axis, geometry: r.geometry_geojson, needsReview: r.needs_review } : null;
}

export interface CommunitySegmentRow {
  id: string;
  speedLimit: number;
  unit: SpeedLimitUnit;
  geometry: unknown;
}

/** The community rows of a key, whatever the feature switch says (reads hide them while it is off; the writer must still see them). */
export async function findCommunitySegments(tx: Queryable, segmentKey: string): Promise<CommunitySegmentRow[]> {
  const rows = await tx.execute<{ id: string; speed_limit: number; speed_limit_unit: SpeedLimitUnit; geometry_geojson: unknown } & Record<string, unknown>>(sql`
    select id, speed_limit, speed_limit_unit, ST_AsGeoJSON(geometry)::json as geometry_geojson
    from speed_limit_segments
    where geometry_key = ${segmentKey} and source = ${COMMUNITY_SOURCE}
    order by imported_at, id
  `);
  return rows.map((r) => ({ id: r.id, speedLimit: r.speed_limit, unit: r.speed_limit_unit, geometry: r.geometry_geojson }));
}

/** Writes the stretch of road as an ordinary segment, from the geometry remembered for the gap. Returns false if the gap is unknown here. */
export async function insertCommunitySegment(tx: Queryable, segmentKey: string, unit: SpeedLimitUnit, value: number): Promise<boolean> {
  const rows = await tx.execute<{ id: string } & Record<string, unknown>>(sql`
    insert into speed_limit_segments (geometry, speed_limit, speed_limit_unit, source, source_license)
    select g.geometry, ${value}, ${unit}::speed_limit_unit, ${COMMUNITY_SOURCE}, ${COMMUNITY_LICENSE}
    from speed_limit_gaps g where g.segment_key = ${segmentKey}
    returning id
  `);
  return rows.length > 0;
}

export async function setCommunitySegmentValue(tx: Queryable, id: string, value: number): Promise<void> {
  await tx.execute(sql`update speed_limit_segments set speed_limit = ${value}, imported_at = now() where id = ${id} and source = ${COMMUNITY_SOURCE}`);
}

export async function deleteCommunitySegment(tx: Queryable, id: string): Promise<void> {
  await tx.execute(sql`delete from speed_limit_segments where id = ${id} and source = ${COMMUNITY_SOURCE}`);
}

export interface NearbyRoad {
  segmentId: string;
  segmentKey: string;
  speedLimit: number;
  unit: SpeedLimitUnit;
  distanceM: number;
  /** Direction (degrees, 0..180, an axis) of the part of the road nearest to the point. */
  axisDegrees: number;
}

interface NearbyRaw extends Record<string, unknown> {
  id: string;
  segment_key: string;
  speed_limit: number;
  speed_limit_unit: SpeedLimitUnit;
  distance_m: number;
  azimuth: number | null;
}

/**
 * Imported roads within `radiusM` of a point, with their direction there. A direction is measured over a ~10 m window
 * around the nearest point, so a long, curved way is judged where the point is, not by its end points.
 */
export async function findImportedRoadsNear(db: Queryable, lat: number, lng: number, radiusM: number): Promise<NearbyRoad[]> {
  const rows = await db.execute<NearbyRaw>(sql`
    with p as (select ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326) as pt)
    select s.id, s.geometry_key as segment_key, s.speed_limit, s.speed_limit_unit,
           ST_Distance(s.geometry::geography, p.pt::geography) as distance_m,
           degrees(ST_Azimuth(
             ST_LineInterpolatePoint(s.geometry, greatest(f.frac - f.window, 0)),
             ST_LineInterpolatePoint(s.geometry, least(f.frac + f.window, 1))
           )) as azimuth
    from speed_limit_segments s
    cross join p
    cross join lateral (
      select ST_LineLocatePoint(s.geometry, p.pt) as frac,
             least(5.0 / greatest(ST_Length(s.geometry::geography), 1.0), 0.5) as window
    ) f
    where s.source <> ${COMMUNITY_SOURCE}
      and s.geometry && ST_Expand(p.pt, ${radiusM / 111_320 * 2 + 0.0001})
      and ST_DWithin(s.geometry::geography, p.pt::geography, ${radiusM})
    order by distance_m asc
    limit 20
  `);
  return rows
    .filter((r) => r.azimuth !== null)
    .map((r) => ({
      segmentId: r.id,
      segmentKey: r.segment_key,
      speedLimit: r.speed_limit,
      unit: r.speed_limit_unit,
      distanceM: r.distance_m,
      axisDegrees: ((r.azimuth ?? 0) % 180 + 180) % 180,
    }));
}

/** Gaps that have a community segment on this node and are not flagged yet — what the import hook re-examines. */
export async function listUnflaggedLiveGaps(tx: Queryable): Promise<{ segmentKey: string; lat: number; lng: number; axis: number }[]> {
  const rows = await tx.execute<{ segment_key: string; lat: number; lng: number; axis: number } & Record<string, unknown>>(sql`
    select g.segment_key, ST_Y(ST_LineInterpolatePoint(g.geometry, 0.5)) as lat, ST_X(ST_LineInterpolatePoint(g.geometry, 0.5)) as lng, g.axis
    from speed_limit_gaps g
    where g.needs_review = false
      and exists (select 1 from speed_limit_segments s where s.geometry_key = g.segment_key and s.source = ${COMMUNITY_SOURCE})
  `);
  return rows.map((r) => ({ segmentKey: r.segment_key, lat: r.lat, lng: r.lng, axis: r.axis }));
}

export async function flagGapNeedsReview(tx: Queryable, segmentKey: string): Promise<void> {
  await tx.execute(sql`update speed_limit_gaps set needs_review = true where segment_key = ${segmentKey}`);
}
