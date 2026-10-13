import { latLngToCell } from "h3-js";
import { sql } from "drizzle-orm";
import type { Queryable } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { coveredTiles } from "../../db/queries/roads.js";
import { markTilesDirty } from "../../db/queries/static-packages.js";
import { bumpStaticDataVersion } from "../../db/queries/sync-state.js";
import { cameraPackageTiles } from "../cameras/policy/cells.js";
import { segmentTilesOf } from "../static-data/tiles.js";
import { pgArray } from "../../db/pg-array.js";
import { COVERAGE_RESOLUTION, ensureCoverage, type ResolveDeps } from "./resolve.js";
import { boxOf } from "./overpass.js";

/**
 * Ties every sign, camera and community stretch to the road network (docs/road-network.md, "Attached to a road").
 *
 * A row is `pending` until looked at. Looked at means: the nearest road within ROAD_SNAP_TOLERANCE_M is found among the road
 * ways and the imported speed-limit segments (which are roads, too); if there is one the item is moved onto it (so it is never
 * "schief") and remembered as `attached`; if there is none, the *area's* roads decide: where the area is covered (its whole road
 * network is known) the item is off the road and is not delivered (`off_road`); where it is not covered nothing can be said and
 * the item stays delivered (`unknown`), to be looked at again once the area has been covered.
 */
export type AttachTable = "static_signs" | "fixed_speed_cameras";

const TABLES: AttachTable[] = ["static_signs", "fixed_speed_cameras"];
const BATCH = 500;

export interface AttachCounts {
  looked: number;
  attached: number;
  offRoad: number;
  unknown: number;
}

const zero = (): AttachCounts => ({ looked: 0, attached: 0, offRoad: 0, unknown: 0 });

interface PendingRow extends Record<string, unknown> {
  id: string;
  lng: number;
  lat: number;
  status: string;
}

interface NearestRow extends Record<string, unknown> {
  id: string;
  road_source: string | null;
  road_id: string | null;
  lng: number | null;
  lat: number | null;
  dist: number | null;
  offset_m: number | null;
}

const degrees = (meters: number) => (meters * 3) / 111_320 + 0.0002;

/** Items matching a removal that an operator or enough visitors decided on stay hidden after a re-import (docs "Defect reports"). */
async function removedMatchKeys(db: Queryable, table: AttachTable): Promise<Set<string>> {
  const type = table === "static_signs" ? "staticSign" : "fixedSpeedCamera";
  const rows = await db.execute<{ match_key: string } & Record<string, unknown>>(sql`
    select match_key from data_defect_removals where target_type = ${type} and restored_at is null
  `);
  return new Set(rows.map((r) => r.match_key));
}

async function matchKeysOf(db: Queryable, table: AttachTable, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const query =
    table === "static_signs"
      ? sql`select id, md5(sign_type || ':' || ST_AsText(position)) as k from static_signs where id = any(${pgArray(ids)}::uuid[])`
      : sql`select id, md5(camera_type::text || ':' || ST_AsText(position)) as k from fixed_speed_cameras where id = any(${pgArray(ids)}::uuid[])`;
  const rows = await db.execute<{ id: string; k: string } & Record<string, unknown>>(query);
  return new Map(rows.map((r) => [r.id, r.k]));
}

/**
 * Looks at up to `limit` rows of one table with the given status. `statuses` is ['pending'] for new rows and ['unknown'] when
 * coverage has arrived since. Returns the counts and the package tiles that must be rebuilt.
 */
export async function attachRows(
  db: Queryable,
  env: Pick<Env, "ROAD_SNAP_TOLERANCE_M" | "CAMERA_POLICY_BORDER_MARGIN_M" | "STATIC_DATA_PARTITION_H3_RESOLUTION" | "CAMERA_ZONE_H3_RESOLUTION">,
  table: AttachTable,
  statuses: readonly string[],
  limit: number,
  /** Continue after this row id (rows are taken in id order): how a long list of "unknown" rows is gone through over several passes. */
  afterId: string | null = null,
): Promise<{ counts: AttachCounts; tiles: Set<string>; lastId: string | null; taken: number }> {
  const counts = zero();
  const tiles = new Set<string>();
  const tableSql = sql.raw(table);
  const after = afterId ? sql`and id > ${afterId}::uuid` : sql``;
  const pending = await db.execute<PendingRow>(sql`
    select id, ST_X(position) as lng, ST_Y(position) as lat, attach_status as status from ${tableSql}
    where attach_status = any(${pgArray([...statuses])}::text[]) ${after} order by id limit ${limit}
  `);
  if (pending.length === 0) return { counts, tiles, lastId: null, taken: 0 };

  const ids = pending.map((p) => p.id);
  const nearest = await db.execute<NearestRow>(sql`
    select f.id, c.road_source, c.road_id, ST_X(c.pt) as lng, ST_Y(c.pt) as lat, c.dist, c.offset_m
    from ${tableSql} f
    left join lateral (
      select * from (
        (select 'road_way'::text as road_source, r.id as road_id, ST_ClosestPoint(r.geometry, f.position) as pt,
                ST_Distance(r.geometry::geography, f.position::geography) as dist,
                ST_LineLocatePoint(r.geometry, f.position) * ST_Length(r.geometry::geography) as offset_m
         from road_ways r where r.geometry && ST_Expand(f.position, ${degrees(env.ROAD_SNAP_TOLERANCE_M)})
         order by r.geometry <-> f.position limit 3)
        union all
        (select 'segment'::text, s.id, ST_ClosestPoint(s.geometry, f.position),
                ST_Distance(s.geometry::geography, f.position::geography),
                ST_LineLocatePoint(s.geometry, f.position) * ST_Length(s.geometry::geography)
         from speed_limit_segments s
         where s.visible and s.source <> 'community' and s.geometry && ST_Expand(f.position, ${degrees(env.ROAD_SNAP_TOLERANCE_M)})
         order by s.geometry <-> f.position limit 3)
      ) x order by dist asc limit 1
    ) c on true
    where f.id = any(${pgArray(ids)}::uuid[])
  `);
  const nearestById = new Map(nearest.map((n) => [n.id, n]));

  const cells = pending.map((p) => latLngToCell(p.lat, p.lng, COVERAGE_RESOLUTION));
  const covered = await coveredTiles(db, [...new Set(cells)], 365);
  const removedKeys = await removedMatchKeys(db, table);
  const matchKeys = removedKeys.size > 0 ? await matchKeysOf(db, table, ids) : new Map<string, string>();

  for (let i = 0; i < pending.length; i += 1) {
    const row = pending[i]!;
    const near = nearestById.get(row.id);
    counts.looked += 1;
    const removedByVisitors = matchKeys.has(row.id) && removedKeys.has(matchKeys.get(row.id)!);
    const onRoad = near && near.dist !== null && near.dist <= env.ROAD_SNAP_TOLERANCE_M && near.lng !== null && near.lat !== null;
    const isCovered = covered.has(cells[i]!);
    // dirty tiles: the place it was and, if it moved, the place it is
    const addTiles = (lat: number, lng: number) => {
      if (table === "fixed_speed_cameras") {
        for (const t of cameraPackageTiles(lat, lng, env.STATIC_DATA_PARTITION_H3_RESOLUTION, env.CAMERA_ZONE_H3_RESOLUTION)) tiles.add(t);
      } else {
        tiles.add(latLngToCell(lat, lng, env.STATIC_DATA_PARTITION_H3_RESOLUTION));
      }
    };
    // Only what changed for a client makes a tile dirty: a row that stays where it is and stays served does not.
    const moved = Boolean(onRoad) && (Math.abs(near!.lat! - row.lat) > 1e-7 || Math.abs(near!.lng! - row.lng) > 1e-7);

    if (onRoad) {
      counts.attached += 1;
      if (moved || removedByVisitors) {
        addTiles(row.lat, row.lng);
        addTiles(near.lat!, near.lng!);
      }
      const countryUpdate =
        table === "fixed_speed_cameras"
          ? sql`, countries = camera_countries(ST_SetSRID(ST_MakePoint(${near.lng}, ${near.lat}), 4326), ${env.CAMERA_POLICY_BORDER_MARGIN_M}::float8)`
          : sql``;
      await db.execute(sql`
        update ${tableSql}
        set position = ST_SetSRID(ST_MakePoint(${near.lng}, ${near.lat}), 4326), road_source = ${near.road_source}, road_id = ${near.road_id},
            road_offset_m = ${near.offset_m}, attach_status = 'attached',
            visible = ${!removedByVisitors}, hidden_reason = ${removedByVisitors ? "defect" : null}
            ${countryUpdate}
        where id = ${row.id}
      `);
    } else if (isCovered || removedByVisitors) {
      counts.offRoad += isCovered ? 1 : 0;
      addTiles(row.lat, row.lng);
      await db.execute(sql`
        update ${tableSql}
        set attach_status = ${isCovered ? "off_road" : "unknown"}, visible = false, hidden_reason = ${removedByVisitors ? "defect" : "off_road"}
        where id = ${row.id}
      `);
    } else {
      counts.unknown += 1;
      if (row.status !== "unknown") await db.execute(sql`update ${tableSql} set attach_status = 'unknown' where id = ${row.id}`);
    }
  }
  return { counts, tiles, lastId: pending[pending.length - 1]!.id, taken: pending.length };
}

export interface AttachReport {
  signs: AttachCounts;
  cameras: AttachCounts;
  stretchesHidden: number;
}

/**
 * Legacy places (the synthetic 120 m line through a tapped position, first released before intervals): where the area's roads are
 * known and the line does not run along one, the community segment on it is hidden - this is the "line in the field".
 */
export async function checkLegacyStretches(db: Queryable, partitionResolution: number): Promise<{ hidden: number; tiles: Set<string> }> {
  const rows = await db.execute<{ segment_key: string; lat: number; lng: number; fraction: number | null } & Record<string, unknown>>(sql`
    select g.segment_key, ST_Y(ST_LineInterpolatePoint(g.geometry, 0.5)) as lat, ST_X(ST_LineInterpolatePoint(g.geometry, 0.5)) as lng,
           (
             -- share of 13 points along the line that are within 12 m of a road (a road way or an imported limit line)
             select count(*) filter (where exists (
                      select 1 from road_ways r
                      where r.geometry && ST_Expand(p.pt, 0.0003) and ST_DWithin(r.geometry::geography, p.pt::geography, 12)
                    ) or exists (
                      select 1 from speed_limit_segments s
                      where s.visible and s.source <> 'community' and s.geometry && ST_Expand(p.pt, 0.0003)
                        and ST_DWithin(s.geometry::geography, p.pt::geography, 12)
                    ))::float8 / 13
             from (select ST_LineInterpolatePoint(g.geometry, i / 12.0) as pt from generate_series(0, 12) i) p
           ) as fraction
    from speed_limit_gaps g
    where g.axis is not null and g.checked_at is null
    limit 200
  `);
  const tiles = new Set<string>();
  let hidden = 0;
  if (rows.length === 0) return { hidden, tiles };
  const cells = rows.map((r) => latLngToCell(r.lat, r.lng, COVERAGE_RESOLUTION));
  const covered = await coveredTiles(db, [...new Set(cells)], 365);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (!covered.has(cells[i]!)) continue; // cannot say: look again when the area is covered
    const alongRoad = (row.fraction ?? 0) >= 0.6;
    if (!alongRoad) {
      const done = await db.execute<{ id: string; geometry_geojson: unknown } & Record<string, unknown>>(sql`
        update speed_limit_segments set visible = false, hidden_reason = 'off_road'
        where geometry_key = ${row.segment_key} and source = 'community' and visible
        returning id, ST_AsGeoJSON(geometry)::json as geometry_geojson
      `);
      if (done.length > 0) hidden += 1;
      for (const d of done) for (const t of segmentTilesOf(d.geometry_geojson, partitionResolution)) tiles.add(t);
    }
    await db.execute(sql`update speed_limit_gaps set checked_at = now() where segment_key = ${row.segment_key}`);
  }
  return { hidden, tiles };
}

/** Where the next pass of "unknown" rows goes on (per table): a long list is gone through in slices, not the first slice again and again. */
const unknownCursor = new Map<AttachTable, string>();

/** One pass of the attach step over everything pending: the worker and the CLI both call this. */
export async function attachAll(
  db: Queryable,
  env: Parameters<typeof attachRows>[1],
  limitPerTable = BATCH,
): Promise<AttachReport> {
  const report: AttachReport = { signs: zero(), cameras: zero(), stretchesHidden: 0 };
  const dirty = new Set<string>();
  for (const table of TABLES) {
    const into = table === "static_signs" ? report.signs : report.cameras;
    // new rows, then rows that were "unknown" and may have been covered since
    for (const statuses of [["pending"], ["unknown"]] as const) {
      const isUnknown = statuses[0] === "unknown";
      const { counts, tiles, lastId, taken } = await attachRows(db, env, table, statuses, limitPerTable, isUnknown ? (unknownCursor.get(table) ?? null) : null);
      if (isUnknown) {
        if (lastId && taken >= limitPerTable) unknownCursor.set(table, lastId);
        else unknownCursor.delete(table);
      }
      into.looked += counts.looked;
      into.attached += counts.attached;
      into.offRoad += counts.offRoad;
      into.unknown += counts.unknown;
      for (const t of tiles) dirty.add(t);
    }
  }
  const legacy = await checkLegacyStretches(db, env.STATIC_DATA_PARTITION_H3_RESOLUTION);
  report.stretchesHidden = legacy.hidden;
  for (const t of legacy.tiles) dirty.add(t);
  if (dirty.size > 0 || legacy.hidden > 0) {
    await bumpStaticDataVersion(db);
    if (dirty.size > 0) await markTilesDirty(db, [...dirty]);
  }
  return report;
}

/** How many rows await a look (what the worker asks before doing anything). */
export async function countPending(db: Queryable): Promise<number> {
  const rows = await db.execute<{ n: string } & Record<string, unknown>>(sql`
    select ((select count(*) from (select 1 from static_signs where attach_status = 'pending' limit 1000) a) +
            (select count(*) from (select 1 from fixed_speed_cameras where attach_status = 'pending' limit 1000) b))::text as n
  `);
  return Number(rows[0]?.n ?? 0);
}

/**
 * The areas (coverage cells) that hold pending rows and are not covered: what the worker asks the lookup service for, a few per
 * run. Returns [lat, lng] of one row per such area.
 */
export async function uncoveredPendingPlaces(db: Queryable, limit: number): Promise<{ lat: number; lng: number }[]> {
  const rows = await db.execute<{ lat: number; lng: number } & Record<string, unknown>>(sql`
    select lat, lng from (
      select ST_Y(position) as lat, ST_X(position) as lng from static_signs where attach_status in ('pending', 'unknown') limit 2000
    ) s
    union all
    select lat, lng from (
      select ST_Y(position) as lat, ST_X(position) as lng from fixed_speed_cameras where attach_status in ('pending', 'unknown') limit 2000
    ) c
  `);
  const seen = new Map<string, { lat: number; lng: number }>();
  for (const r of rows) {
    const cell = latLngToCell(r.lat, r.lng, COVERAGE_RESOLUTION);
    if (!seen.has(cell)) seen.set(cell, { lat: r.lat, lng: r.lng });
  }
  if (seen.size === 0) return [];
  const covered = await coveredTiles(db, [...seen.keys()], 365);
  return [...seen.entries()].filter(([cell]) => !covered.has(cell)).map(([, place]) => place).slice(0, limit);
}

/** Asks the lookup service for up to `tilesPerRun` uncovered areas that have pending items, then attaches. */
export async function attachStep(deps: ResolveDeps & { env: ResolveDeps["env"] & Parameters<typeof attachRows>[1] & Pick<Env, "ROAD_ATTACH_TILES_PER_RUN"> }): Promise<AttachReport> {
  const places = await uncoveredPendingPlaces(deps.db, deps.env.ROAD_ATTACH_TILES_PER_RUN);
  for (const place of places) {
    await ensureCoverage(deps, boxOf([[place.lng, place.lat]], 0.003), [{ lat: place.lat, lng: place.lng }]);
  }
  return attachAll(deps.db, deps.env);
}
