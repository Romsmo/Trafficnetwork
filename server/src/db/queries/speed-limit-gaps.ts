import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import type { SpeedLimitUnit } from "../../config/constants.js";
import { stretchGeoJson, type CommunityStretch } from "../../modules/speed-limit-corrections/stretch.js";

/**
 * Persistence for stretches of road the community proposes a speed limit for (docs/road-network.md; first released as "gaps",
 * docs/speed-limit-corrections.md D13). The rules live in modules/speed-limit-corrections/{stretch,service}.ts and
 * modules/roads; this file is only SQL.
 */

export const COMMUNITY_SOURCE = "community";
export const COMMUNITY_LICENSE = "community contribution";

/** An imported way is "under" an interval when this much of it lies within SPLIT_BUFFER_M of the interval (or 80 % of a short one). */
export const SPLIT_BUFFER_M = 5;
const SPLIT_MIN_OVERLAP_M = 25;
const PIECE_MIN_LENGTH_M = 5;

/** Remembers where a stretch is. Idempotent: the key is derived from the geometry, so a second vote for the same place is a no-op. */
export async function upsertGap(tx: Queryable, stretch: CommunityStretch): Promise<void> {
  await tx.execute(sql`
    insert into speed_limit_gaps (segment_key, ref, road_name, road_ref, road_class, length_m, cell, axis, geometry)
    values (${stretch.segmentKey}, ${stretch.ref}, ${stretch.roadName}, ${stretch.roadRef}, ${stretch.roadClass}, ${stretch.lengthM},
            ${stretch.cell}, ${stretch.axis}, ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(stretchGeoJson(stretch))}), 4326))
    on conflict (segment_key) do nothing
  `);
}

export interface GapRow {
  segmentKey: string;
  ref: string | null;
  cell: string | null;
  axis: number | null;
  roadName: string | null;
  roadRef: string | null;
  roadClass: string | null;
  lengthM: number | null;
  geometry: { type: "LineString"; coordinates: [number, number][] };
  needsReview: boolean;
}

interface GapRaw extends Record<string, unknown> {
  segment_key: string;
  ref: string | null;
  cell: string | null;
  axis: number | null;
  road_name: string | null;
  road_ref: string | null;
  road_class: string | null;
  length_m: number | null;
  geometry_geojson: GapRow["geometry"];
  needs_review: boolean;
}

export async function findGap(db: Queryable, segmentKey: string): Promise<GapRow | null> {
  const rows = await db.execute<GapRaw>(sql`
    select segment_key, ref, cell, axis, road_name, road_ref, road_class, length_m, ST_AsGeoJSON(geometry)::json as geometry_geojson, needs_review
    from speed_limit_gaps where segment_key = ${segmentKey}
  `);
  const r = rows[0];
  return r
    ? {
        segmentKey: r.segment_key,
        ref: r.ref,
        cell: r.cell,
        axis: r.axis,
        roadName: r.road_name,
        roadRef: r.road_ref,
        roadClass: r.road_class,
        lengthM: r.length_m,
        geometry: r.geometry_geojson,
        needsReview: r.needs_review,
      }
    : null;
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

// ---------------------------------------------------------------- editing a limit: what an interval does to the way under it

export interface SplitResult {
  /** Imported rows that are now hidden (replaced by the community stretch and their own remainders). */
  hidden: string[];
  /** The remainders of those rows outside the stretch, new rows. */
  pieces: string[];
}

/**
 * An applied community stretch replaces whatever the import says under it. An imported way the stretch covers is hidden and
 * its parts outside the stretch are written as rows of their own (same value, same source), so that the coloured map shows the
 * new value exactly on the stretch and the old one on both sides. Idempotent per stretch key; undone by `unsplitUnder`.
 */
export async function splitImportedUnder(tx: Queryable, intervalKey: string): Promise<SplitResult> {
  const done = await tx.execute<{ one: number } & Record<string, unknown>>(sql`select 1 as one from speed_limit_splits where interval_key = ${intervalKey} limit 1`);
  if (done.length > 0) return { hidden: [], pieces: [] };

  const covered = await tx.execute<{ id: string; overlap_m: number; interval_m: number } & Record<string, unknown>>(sql`
    with g as (
      select geometry, ST_Buffer(geometry::geography, ${SPLIT_BUFFER_M})::geometry as zone,
             ST_Length(geometry::geography) as interval_m
      from speed_limit_gaps where segment_key = ${intervalKey}
    )
    select s.id, ST_Length(ST_Intersection(s.geometry, g.zone)::geography) as overlap_m, g.interval_m
    from speed_limit_segments s cross join g
    where s.visible and s.source <> ${COMMUNITY_SOURCE} and s.geometry && g.zone and ST_Intersects(s.geometry, g.zone)
    order by s.id
  `);
  const result: SplitResult = { hidden: [], pieces: [] };
  for (const row of covered) {
    const needed = Math.min(SPLIT_MIN_OVERLAP_M, row.interval_m * 0.8);
    if (row.overlap_m < needed) continue;
    const pieces = await tx.execute<{ id: string } & Record<string, unknown>>(sql`
      with g as (select ST_Buffer(geometry::geography, ${SPLIT_BUFFER_M})::geometry as zone from speed_limit_gaps where segment_key = ${intervalKey}),
      s as (select * from speed_limit_segments where id = ${row.id}),
      parts as (
        select (ST_Dump(ST_Difference(s.geometry, g.zone))).geom as geom from s cross join g
      )
      insert into speed_limit_segments (geometry, speed_limit, speed_limit_unit, source, source_license, imported_at, last_confirmed_at)
      select parts.geom, s.speed_limit, s.speed_limit_unit, s.source, s.source_license, s.imported_at, s.last_confirmed_at
      from parts cross join s
      where GeometryType(parts.geom) = 'LINESTRING' and ST_Length(parts.geom::geography) >= ${PIECE_MIN_LENGTH_M}
      returning id
    `);
    await tx.execute(sql`
      update speed_limit_segments set visible = false, hidden_reason = 'superseded' where id = ${row.id}
    `);
    await tx.execute(sql`insert into speed_limit_splits (interval_key, original_id, piece_id) values (${intervalKey}, ${row.id}, null)`);
    for (const piece of pieces) {
      await tx.execute(sql`insert into speed_limit_splits (interval_key, original_id, piece_id) values (${intervalKey}, ${row.id}, ${piece.id})`);
      result.pieces.push(piece.id);
    }
    result.hidden.push(row.id);
  }
  return result;
}

export interface UnsplitResult {
  /** Pieces deleted again (to be announced as removed - capture their payload before calling). */
  removedPieces: string[];
  /** Imported rows shown again. */
  restored: string[];
}

/** The ids `unsplitUnder` is about to delete, so the caller can describe them first. */
export async function listPiecesOf(tx: Queryable, intervalKey: string): Promise<string[]> {
  const rows = await tx.execute<{ piece_id: string } & Record<string, unknown>>(sql`
    select piece_id from speed_limit_splits where interval_key = ${intervalKey} and piece_id is not null
  `);
  return rows.map((r) => r.piece_id);
}

export async function unsplitUnder(tx: Queryable, intervalKey: string): Promise<UnsplitResult> {
  const pieces = await listPiecesOf(tx, intervalKey);
  const originals = await tx.execute<{ original_id: string } & Record<string, unknown>>(sql`
    select distinct original_id from speed_limit_splits where interval_key = ${intervalKey}
  `);
  for (const id of pieces) await tx.execute(sql`delete from speed_limit_segments where id = ${id}`);
  const restored: string[] = [];
  for (const o of originals) {
    const done = await tx.execute<{ id: string } & Record<string, unknown>>(sql`
      update speed_limit_segments set visible = true, hidden_reason = null
      where id = ${o.original_id} and hidden_reason = 'superseded' returning id
    `);
    if (done.length > 0) restored.push(o.original_id);
  }
  await tx.execute(sql`delete from speed_limit_splits where interval_key = ${intervalKey}`);
  return { removedPieces: pieces, restored };
}

// ---------------------------------------------------------------- roads that already have a limit

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
    where s.source <> ${COMMUNITY_SOURCE} and s.visible
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

/** Limits already on record under a stretch - what the preview tells before anybody proposes something. */
export interface CoveredSegment {
  segmentId: string;
  segmentKey: string;
  speedLimit: number;
  unit: SpeedLimitUnit;
  source: string;
  coveredMeters: number;
}

export async function findSegmentsUnder(db: Queryable, coordinates: readonly (readonly [number, number])[]): Promise<CoveredSegment[]> {
  const line = JSON.stringify({ type: "LineString", coordinates });
  const rows = await db.execute<{ id: string; segment_key: string; speed_limit: number; unit: SpeedLimitUnit; source: string; covered: number } & Record<string, unknown>>(sql`
    with g as (
      select ST_SetSRID(ST_GeomFromGeoJSON(${line}), 4326) as geometry
    ), z as (select geometry, ST_Buffer(geometry::geography, ${SPLIT_BUFFER_M})::geometry as zone from g)
    select s.id, s.geometry_key as segment_key, s.speed_limit, s.speed_limit_unit as unit, s.source,
           least(ST_Length(ST_Intersection(s.geometry, z.zone)::geography), ST_Length(z.geometry::geography)) as covered
    from speed_limit_segments s cross join z
    where s.visible and s.geometry && z.zone and ST_Intersects(s.geometry, z.zone)
    order by covered desc
    limit 12
  `);
  return rows
    .filter((r) => r.covered >= 5)
    .map((r) => ({ segmentId: r.id, segmentKey: r.segment_key, speedLimit: r.speed_limit, unit: r.unit, source: r.source, coveredMeters: Math.round(r.covered) }));
}

/** Legacy places that have a community segment on this node and are not flagged yet - what the import hook re-examines. */
export async function listUnflaggedLiveGaps(tx: Queryable): Promise<{ segmentKey: string; lat: number; lng: number; axis: number }[]> {
  const rows = await tx.execute<{ segment_key: string; lat: number; lng: number; axis: number } & Record<string, unknown>>(sql`
    select g.segment_key, ST_Y(ST_LineInterpolatePoint(g.geometry, 0.5)) as lat, ST_X(ST_LineInterpolatePoint(g.geometry, 0.5)) as lng, g.axis
    from speed_limit_gaps g
    where g.needs_review = false and g.axis is not null
      and exists (select 1 from speed_limit_segments s where s.geometry_key = g.segment_key and s.source = ${COMMUNITY_SOURCE})
  `);
  return rows.map((r) => ({ segmentKey: r.segment_key, lat: r.lat, lng: r.lng, axis: r.axis }));
}

export async function flagGapNeedsReview(tx: Queryable, segmentKey: string): Promise<void> {
  await tx.execute(sql`update speed_limit_gaps set needs_review = true where segment_key = ${segmentKey}`);
}
