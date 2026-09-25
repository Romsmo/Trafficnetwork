import { sql, type SQL } from "drizzle-orm";
import type { Queryable } from "../client.js";
import { bboxPrefilter, envelopeOverlap, type Envelope } from "../../lib/geo-bbox.js";

export interface StaticSignApi {
  id: string;
  position: unknown; // GeoJSON Point
  signType: string;
  source: string;
  sourceLicense: string | null;
  importedAt: string;
}

interface Row extends Record<string, unknown> {
  id: string;
  position_geojson: unknown;
  sign_type: string;
  source: string;
  source_license: string | null;
  imported_at: string;
}

function toApi(row: Row): StaticSignApi {
  return {
    id: row.id,
    position: row.position_geojson,
    signType: row.sign_type,
    source: row.source,
    sourceLicense: row.source_license,
    importedAt: row.imported_at,
  };
}

export async function findAllStaticSigns(db: Queryable): Promise<StaticSignApi[]> {
  const rows = await db.execute<Row>(sql`
    select id, ST_AsGeoJSON(position)::json as position_geojson, sign_type,
           source, source_license, imported_at
    from static_signs
  `);
  return rows.map(toApi);
}

export async function findStaticSignsNearby(
  db: Queryable,
  lat: number,
  lng: number,
  radiusM: number,
): Promise<StaticSignApi[]> {
  const rows = await db.execute<Row>(sql`
    select id, ST_AsGeoJSON(position)::json as position_geojson, sign_type,
           source, source_license, imported_at
    from static_signs
    where ${bboxPrefilter(sql`position`, lat, lng, radiusM)}ST_DWithin(
      position::geography,
      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
      ${radiusM}
    )
  `);
  return rows.map(toApi);
}

/** Candidate rows of one partition tile (bounding-box match, ordered by id for stable package hashes) and how to shape them. */
export function tileStaticSignsQuery(envelopes: readonly Envelope[]): { query: SQL; map: (row: Record<string, unknown>) => StaticSignApi } {
  return {
    query: sql`
      select id, ST_AsGeoJSON(position)::json as position_geojson, sign_type, source, source_license, imported_at
      from static_signs where ${envelopeOverlap(sql`position`, envelopes)} order by id
    `,
    map: (row) => toApi(row as Row),
  };
}
