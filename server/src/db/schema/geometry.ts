import { customType } from "drizzle-orm/pg-core";

/**
 * PostGIS geometry column, used for every geometry column in this schema (not just
 * non-Point shapes). Drizzle's built-in `geometry()` helper accepts a `srid` option
 * in its TypeScript config type, but in the drizzle-orm version pinned in
 * package.json its getSQLType() ignores that config entirely and always emits the
 * bare, unqualified `geometry(point)` SQL type — silently dropping the SRID. Since
 * every spatial query here compares stored geometry against `ST_MakePoint(lng, lat)`
 * wrapped in SRID 4326 (see work order "phase1-server" (kept outside the repo) section 4 — SRID 4326 is
 * implied by lat/lng input), an unqualified column would make Postgres reject those
 * comparisons as mixed-SRID operations. This custom type always emits an explicit,
 * correct `geometry(<subtype>,<srid>)` column type instead.
 *
 * Values are read/written as GeoJSON strings via ST_AsGeoJSON/ST_GeomFromGeoJSON in
 * the SQL layer — callers should not attempt to insert/select through this column
 * with Drizzle's typed insert/select helpers, always go through the raw `sql`
 * template (see each module's repository file).
 *
 * subtype: the PostGIS geometry subtype, e.g. "Point", "LineString".
 */
export function geometryColumn(name: string, subtype: string, srid = 4326) {
  return customType<{ data: string; driverData: string }>({
    dataType() {
      return `geometry(${subtype},${srid})`;
    },
  })(name);
}
