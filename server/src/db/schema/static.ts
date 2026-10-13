import { sql } from "drizzle-orm";
import { boolean, doublePrecision, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    /**
     * Delivered to clients? False for a row that is out of the way: replaced by a community interval on top of it
     * (hidden_reason "superseded", see speed_limit_splits), reported as defective by enough visitors ("defect"), or sitting
     * off every road of an area whose road network is known ("off_road").
     */
    visible: boolean("visible").notNull().default(true),
    hiddenReason: text("hidden_reason"),
  },
  (t) => [
    index("speed_limit_segments_geometry_gist").using("gist", t.geometry),
    index("speed_limit_segments_geometry_key_idx").on(t.geometryKey),
  ],
);

/**
 * What ties a point item (sign, camera) to the road network (docs/road-network.md, "Attached to a road"): the road piece it was
 * snapped onto and where along it, whether it is on a road at all, and whether it is delivered. `attach_status` is "pending"
 * until the attach step has looked at it, then "attached" (snapped onto a road within the tolerance), "off_road" (the area's
 * roads are known and none is near: not delivered) or "unknown" (no road data around it: delivered, looked at again later).
 */
export function roadAttachment() {
  return {
    roadSource: text("road_source"),
    roadId: uuid("road_id"),
    roadOffsetM: doublePrecision("road_offset_m"),
    attachStatus: text("attach_status").notNull().default("pending"),
    visible: boolean("visible").notNull().default(true),
    hiddenReason: text("hidden_reason"),
  };
}

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
    ...roadAttachment(),
  },
  (t) => [index("static_signs_position_gist").using("gist", t.position)],
);
