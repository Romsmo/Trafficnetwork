import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { speedLimitUnitEnum } from "./enums.js";
import { geometryColumn } from "./geometry.js";

/**
 * Static/semi-static entity: docs/concept.md section 3.1. Synced fully and
 * globally to every client (small enough — low single-digit GB for all of
 * Europe per the concept doc's estimate).
 */
export const speedLimitSegments = pgTable(
  "speed_limit_segments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    geometry: geometryColumn("geometry", "LineString").notNull(),
    speedLimit: integer("speed_limit").notNull(),
    speedLimitUnit: speedLimitUnitEnum("speed_limit_unit").notNull(),
    source: text("source").notNull(),
    sourceLicense: text("source_license"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
  },
  (t) => [index("speed_limit_segments_geometry_gist").using("gist", t.geometry)],
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
