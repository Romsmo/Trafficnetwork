import { bigserial, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { geometryColumn } from "./geometry.js";

/**
 * The road network (docs/road-network.md): every drivable way the node knows, with its shape. It is what a picked stretch of
 * road is resolved against, and what signs, cameras and community speed limits are attached to - no limit, camera or sign is
 * delivered that sits off a road. Filled by `POST /v1/bulk-import/roads` (the ingestion's `roads` section, OpenStreetMap
 * extracts) and, where an operator allows it, from an Overpass-compatible service on demand; a row says where it came from.
 */
export const roadWays = pgTable(
  "road_ways",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: text("source").notNull(),
    /** The way's id at its source (OpenStreetMap way id). */
    externalId: text("external_id").notNull(),
    geometry: geometryColumn("geometry", "LineString").notNull(),
    highway: text("highway").notNull(),
    name: text("name"),
    ref: text("ref"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("road_ways_source_external_uq").on(t.source, t.externalId),
    index("road_ways_geometry_gist").using("gist", t.geometry),
  ],
);

/**
 * Areas (H3 cells, resolution 8, ~0.7 km2) whose road network is complete in `road_ways`. Only a covered cell can say "there
 * is no road here"; outside covered cells an item that no road is near is *unknown*, not wrong, and stays delivered.
 */
export const roadCoverageTiles = pgTable("road_coverage_tiles", {
  tile: text("tile").primaryKey(),
  /** How the cell became covered: "lookup" (Overpass fetch) or "import" (a road import around it). */
  via: text("via").notNull(),
  wayCount: integer("way_count").notNull().default(0),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * "This entry is wrong - take it out" (docs/road-network.md, "Defect reports"): one row per reporter and target. Enough
 * distinct reporters hide the target (DEFECT_REMOVAL_THRESHOLD); an operator can restore it. Node-local, never federated.
 */
export const dataDefectReports = pgTable(
  "data_defect_reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    reporterId: text("reporter_id").notNull(),
    reason: text("reason"),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("data_defect_reports_target_reporter_uq").on(t.targetType, t.targetId, t.reporterId),
    index("data_defect_reports_target_idx").on(t.targetType, t.targetId),
  ],
);

/**
 * What a community interval did to the imported rows under it (docs/road-network.md, "Editing a limit"): an imported way the
 * interval covers is hidden and replaced by the pieces of it that lie outside the interval. Dropping the interval's value
 * undoes exactly this (the pieces go, the original is shown again). One row per hidden original (piece_id null) and one per piece.
 */
export const speedLimitSplits = pgTable(
  "speed_limit_splits",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    intervalKey: text("interval_key").notNull(),
    originalId: uuid("original_id").notNull(),
    pieceId: uuid("piece_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("speed_limit_splits_interval_idx").on(t.intervalKey)],
);

/**
 * Entries visitors took out ("defect reports" reached the threshold) or an operator removed, remembered by what identifies them
 * across a re-import: the geometry key of a speed-limit segment, a hash of type and position for a sign or camera. A re-import
 * that brings the entry back is hidden again. `restored_at` set = it is allowed again.
 */
export const dataDefectRemovals = pgTable(
  "data_defect_removals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    targetType: text("target_type").notNull(),
    matchKey: text("match_key").notNull(),
    reason: text("reason"),
    removedAt: timestamp("removed_at", { withTimezone: true }).notNull().defaultNow(),
    restoredAt: timestamp("restored_at", { withTimezone: true }),
  },
  (t) => [unique("data_defect_removals_target_key_uq").on(t.targetType, t.matchKey)],
);
