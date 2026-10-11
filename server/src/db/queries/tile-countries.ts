import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import type { TileCentre } from "../../modules/static-data/regions.js";

/** The fingerprint of the loaded boundary dataset, or null when none is loaded (the regions fall back to coarse H3 cells). */
export async function boundaryContentHash(db: Queryable): Promise<string | null> {
  const rows = await db.execute<{ content_hash: string | null; parts: number } & Record<string, unknown>>(sql`
    select (select content_hash from country_boundary_state order by id limit 1) as content_hash,
           (select count(*)::int from country_boundary_parts) as parts
  `);
  const row = rows[0];
  if (!row || row.parts === 0) return null;
  return `${row.content_hash ?? "loaded"}:${row.parts}`;
}

/** A tile centre further than this (degrees, ≈ 60 km) from every boundary part belongs to no country. */
const MAX_DISTANCE_DEGREES = 0.55;

/**
 * The country of each tile, by its centre: the nearest boundary part, if one lies within MAX_DISTANCE_DEGREES — so a tile
 * whose centre is just off the coast still has a country, and one far out at sea has none. All null when no boundary data is
 * loaded (the table is empty), which is a valid state: the regions then fall back to coarse H3 cells.
 */
export async function countriesOfTiles(db: Queryable, centres: readonly TileCentre[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (centres.length === 0) return result;
  const rows = await db.execute<{ tile: string; iso2: string | null } & Record<string, unknown>>(sql`
    select v.tile, c.iso2
    from jsonb_to_recordset(${JSON.stringify(centres)}::jsonb) as v(tile text, lat double precision, lng double precision)
    left join lateral (
      select p.iso2, p.geom <-> ST_SetSRID(ST_MakePoint(v.lng, v.lat), 4326) as d
      from country_boundary_parts p
      order by p.geom <-> ST_SetSRID(ST_MakePoint(v.lng, v.lat), 4326)
      limit 1
    ) c on c.d < ${MAX_DISTANCE_DEGREES}
  `);
  for (const r of rows) result.set(r.tile, r.iso2);
  return result;
}
