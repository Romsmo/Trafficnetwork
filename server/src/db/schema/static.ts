import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { speedLimitUnitEnum } from "./enums.js";
import { geometryColumn } from "./geometry.js";

/**
 * Static/semi-static entity: docs/concept.md section 3.1. Synced fully and
 * globally to every client (small enough — low single-digit GB for all of
 * Europe per the concept doc's estimate).
 *
 * `geometry_key` (add-on K-A) is a content-derived, cross-server-stable identity
 * of the geometry — a stored generated column over the SQL function
 * speed_limit_geometry_key() (see the 0007 migration and docs/schema.md for the
 * exact formula). It is what community corrections reference; the row `id`
 * stays a random per-server UUID. Import code never writes it.
 */
export const speedLimitSegments = pgTable(
  "speed_limit_segments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    geometry: geometryColumn("geometry", "LineString").notNull(),
    geometryKey: text("geometry_key").generatedAlwaysAs(sql`speed_limit_geometry_key(geometry)`),
    speedLimit: integer("speed_limit").notNull(),
    speedLimitUnit: speedLimitUnitEnum("speed_limit_unit").notNull(),
    source: text("source").notNull(),
    sourceLicense: text("source_license"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
  },
  (t) => [
    index("speed_limit_segments_geometry_gist").using("gist", t.geometry),
    index("speed_limit_segments_geometry_key_idx").on(t.geometryKey),
  ],
);

/**
 * signType is a country-prefixed catalog reference (e.g. "DE:274"), analogous to
 * OSM's traffic_sign country-prefix tagging (DE:, FR:, etc.) — not hardcoded to
 * the German StVO catalog, per docs/concept.md section 3.4.
 */
export const staticSigns = pgTable(
  "static_signs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    position: geometryColumn("position", "Point").notNull(),
    signType: text("sign_type").notNull(),
    source: text("source").notNull(),
    sourceLicense: text("source_license"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("static_signs_position_gist").using("gist", t.position)],
);
