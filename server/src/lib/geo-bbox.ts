import { sql, type SQL } from "drizzle-orm";

/**
 * Index-friendly bounding-box prefilter for "within N meters of a point" queries.
 *
 * `ST_DWithin(col::geography, point::geography, r)` cannot use the GiST index on the
 * *geometry* column (the cast hides it), so every such query was a sequential scan of
 * the whole table — ~0.9 s at 438k segments regardless of radius. Adding
 * `col && ST_MakeEnvelope(...)` in front lets Postgres use that index to find the few
 * candidates first; ST_DWithin then still decides exactly, so results are identical
 * (measured on real Bayern data: same 828 rows, 900 ms -> 23 ms).
 *
 * The envelope must be a SUPERSET of the circle, so all bounds are conservative:
 *  - one degree of latitude is at least 110,574 m on the WGS84 ellipsoid (at the equator),
 *  - one degree of longitude is at most 111,320 m (at the equator) and shrinks with cos(lat);
 *    the smaller cosine of the envelope's two latitude edges is used,
 *  - geography treats a segment's edges as geodesics while `&&` compares the planar bounding
 *    box of the vertices; the two differ by the (tiny) bulge of the geodesic, so the radius is
 *    padded by max(100 m, 5 %) — enough for edges up to roughly 50 km between two vertices.
 *
 * Near the poles and the antimeridian a flat box stops being a superset (longitude wraps,
 * parallels collapse), so no prefilter is applied there and the exact, slower query runs.
 */
const METERS_PER_DEGREE_LAT_MIN = 110_574;
const METERS_PER_DEGREE_LNG_AT_EQUATOR = 111_320;

export interface Envelope {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function envelopeForRadius(lat: number, lng: number, radiusM: number): Envelope | null {
  const paddedM = radiusM + Math.max(100, radiusM * 0.05);
  const dLat = paddedM / METERS_PER_DEGREE_LAT_MIN;
  const north = lat + dLat;
  const south = lat - dLat;
  if (north >= 89 || south <= -89) return null;

  const worstLat = Math.max(Math.abs(north), Math.abs(south));
  const dLng = paddedM / (METERS_PER_DEGREE_LNG_AT_EQUATOR * Math.cos((worstLat * Math.PI) / 180));
  const west = lng - dLng;
  const east = lng + dLng;
  if (west <= -180 || east >= 180) return null;

  return { west, south, east, north };
}

/**
 * SQL fragment `<column> && <envelope> and ` (note the trailing "and"), or an empty fragment when no
 * safe envelope exists. Put it directly in front of the ST_DWithin condition inside a WHERE clause.
 */
export function bboxPrefilter(column: SQL, lat: number, lng: number, radiusM: number): SQL {
  const env = envelopeForRadius(lat, lng, radiusM);
  if (!env) return sql``;
  return sql`${column} && ST_MakeEnvelope(${env.west}, ${env.south}, ${env.east}, ${env.north}, 4326) and `;
}

/**
 * SQL predicate "column && any of these envelopes" (parenthesised). Used to find a
 * partition tile's candidate rows through the GiST index; exactness is the caller's job.
 */
export function envelopeOverlap(column: SQL, envelopes: readonly Envelope[]): SQL {
  const parts = envelopes.map((e) => sql`${column} && ST_MakeEnvelope(${e.west}, ${e.south}, ${e.east}, ${e.north}, 4326)`);
  return sql`(${sql.join(parts, sql` or `)})`;
}
