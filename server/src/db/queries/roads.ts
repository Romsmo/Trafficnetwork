import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import { pgArray } from "../pg-array.js";
import type { BoundingBox, FetchedWay } from "../../modules/roads/overpass.js";
import type { RoadWay } from "../../modules/roads/pathfinder.js";

/**
 * SQL of the road network (docs/road-network.md). The rules - which road a stretch runs along, what is attached where - live
 * in modules/roads; this file only reads and writes rows.
 */

interface WayRow extends Record<string, unknown> {
  id: string;
  kind: "road_way" | "segment";
  geometry_geojson: { type: "LineString"; coordinates: [number, number][] };
  highway: string | null;
  name: string | null;
  ref: string | null;
}

/**
 * The road pieces in a box. Where the node has road ways there, those are the network; the imported speed-limit segments
 * (which are roads, but only those with a limit) are used only where it has none - so an area never mixes the two.
 */
export async function loadWaysInBox(db: Queryable, box: BoundingBox, limit = 6000): Promise<RoadWay[]> {
  const envelope = sql`ST_MakeEnvelope(${box.west}, ${box.south}, ${box.east}, ${box.north}, 4326)`;
  const ways = await db.execute<WayRow>(sql`
    select r.id, 'road_way' as kind, ST_AsGeoJSON(r.geometry)::json as geometry_geojson, r.highway, r.name, r.ref
    from road_ways r where r.geometry && ${envelope} limit ${limit}
  `);
  if (ways.length > 0) return ways.map(toWay);
  const segments = await db.execute<WayRow>(sql`
    select s.id, 'segment' as kind, ST_AsGeoJSON(s.geometry)::json as geometry_geojson, null::text as highway, null::text as name, null::text as ref
    from speed_limit_segments s
    where s.visible and s.source <> 'community' and s.geometry && ${envelope} limit ${limit}
  `);
  return segments.map(toWay);
}

function toWay(r: WayRow): RoadWay {
  return { id: r.id, kind: r.kind, coordinates: r.geometry_geojson.coordinates, highway: r.highway, name: r.name, ref: r.ref };
}

/** Inserts or refreshes ways from a source (an extract import or a lookup). Returns how many rows were written. */
export async function upsertRoadWays(db: Queryable, source: string, ways: readonly FetchedWay[]): Promise<number> {
  if (ways.length === 0) return 0;
  const written = await db.execute<{ id: string } & Record<string, unknown>>(sql`
    insert into road_ways (source, external_id, geometry, highway, name, ref, fetched_at)
    select ${source}, t.external_id, ST_SetSRID(ST_GeomFromText(t.wkt), 4326), t.highway, nullif(t.name, ''), nullif(t.ref, ''), now()
    from unnest(
      ${pgArray(ways.map((w) => w.externalId))}::text[],
      ${pgArray(ways.map((w) => `LINESTRING(${w.coordinates.map(([lng, lat]) => `${lng} ${lat}`).join(", ")})`))}::text[],
      ${pgArray(ways.map((w) => w.highway))}::text[],
      ${pgArray(ways.map((w) => w.name ?? ""))}::text[],
      ${pgArray(ways.map((w) => w.ref ?? ""))}::text[]
    ) as t(external_id, wkt, highway, name, ref)
    on conflict (source, external_id) do update
      set geometry = excluded.geometry, highway = excluded.highway, name = excluded.name, ref = excluded.ref, fetched_at = now()
    returning id
  `);
  return written.length;
}

/** Which of these cells are covered, and not older than `maxAgeDays`. */
export async function coveredTiles(db: Queryable, tiles: readonly string[], maxAgeDays: number): Promise<Set<string>> {
  if (tiles.length === 0) return new Set();
  const rows = await db.execute<{ tile: string } & Record<string, unknown>>(sql`
    select tile from road_coverage_tiles
    where tile = any(${pgArray(tiles)}::text[]) and fetched_at > now() - make_interval(days => ${maxAgeDays})
  `);
  return new Set(rows.map((r) => r.tile));
}

export async function markCovered(db: Queryable, tiles: readonly string[], via: "lookup" | "import", wayCounts?: ReadonlyMap<string, number>): Promise<void> {
  if (tiles.length === 0) return;
  await db.execute(sql`
    insert into road_coverage_tiles (tile, via, way_count, fetched_at)
    select t.tile, ${via}, t.way_count, now()
    from unnest(${pgArray(tiles)}::text[], ${pgArray(tiles.map((t) => String(wayCounts?.get(t) ?? 0)))}::int[]) as t(tile, way_count)
    on conflict (tile) do update set via = excluded.via, way_count = excluded.way_count, fetched_at = now()
  `);
}

export interface RoadCounts {
  ways: number;
  coveredTiles: number;
}

export async function roadCounts(db: Queryable): Promise<RoadCounts> {
  const rows = await db.execute<{ ways: string; tiles: string } & Record<string, unknown>>(sql`
    select (select count(*) from road_ways)::text as ways, (select count(*) from road_coverage_tiles)::text as tiles
  `);
  const r = rows[0];
  return { ways: Number(r?.ways ?? 0), coveredTiles: Number(r?.tiles ?? 0) };
}
