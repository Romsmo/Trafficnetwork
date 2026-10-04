import { bigserial, doublePrecision, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { geometryColumn } from "./geometry.js";

/**
 * Country boundaries for the camera policy (docs/camera-country-policy.md, section 3). Loaded by the operator
 * (`npm run cameras -- load-boundaries <file.geojson>`) — the server ships no geodata. Polygons are stored
 * *subdivided* (ST_Subdivide, at most 256 vertices each) so that the SQL function camera_countries() is an
 * index probe over small shapes instead of a distance computation against a country-sized polygon.
 * Empty table = no camera has a known country = nothing is delivered (fail closed).
 */
export const countryBoundaryParts = pgTable(
  "country_boundary_parts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    iso2: text("iso2").notNull(),
    geom: geometryColumn("geom", "Polygon").notNull(),
  },
  (t) => [index("country_boundary_parts_geom_gist").using("gist", t.geom), index("country_boundary_parts_iso2_idx").on(t.iso2)],
);

/** Single row (id = 1): what the last `load-boundaries` / `resolve-countries` run used, so a node can tell stale from fresh. */
export const countryBoundaryState = pgTable("country_boundary_state", {
  id: integer("id").primaryKey(),
  dataset: text("dataset"),
  features: integer("features"),
  loadedAt: timestamp("loaded_at", { withTimezone: true }),
  /** The CAMERA_POLICY_BORDER_MARGIN_M the stored country sets were last computed with. */
  marginM: doublePrecision("margin_m"),
  contentHash: text("content_hash"),
});
