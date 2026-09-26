import { bigserial, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { cameraStatusEnum, cameraTypeEnum } from "./enums.js";
import { geometryColumn } from "./geometry.js";

/**
 * fixedSpeedCamera lives in its own table rather than hazard_reports: per
 * docs/concept.md section 3.2 it is the one hazard-adjacent type with no automatic
 * expiry, removed only via accumulated distinct-reporter "gone" reports — same
 * lifecycle shape as static_signs, not hazard_reports. Gated from all reads by
 * SPEED_CAMERA_NAMESPACE_ENABLED (see modules/cameras/filter.ts); writes/ingestion
 * are never blocked by the flag (docs/prompt-phase1-server.md section 6).
 *
 * Add-on D generalises the table to every permanently installed enforcement device:
 * `camera_type` says which (red-light and distance devices as well as speed cameras).
 * The table name stays; rows that existed before the column are speed cameras by default.
 */
export const fixedSpeedCameras = pgTable(
  "fixed_speed_cameras",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    position: geometryColumn("position", "Point").notNull(),
    cameraType: cameraTypeEnum("camera_type").notNull().default("fixedSpeedCamera"),
    status: cameraStatusEnum("status").notNull().default("active"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    source: text("source").notNull(),
    sourceLicense: text("source_license"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
  },
  (t) => [index("fixed_speed_cameras_position_gist").using("gist", t.position)],
);

/** One "this camera is gone" vote per reporter; distinct-reporter count drives removal. */
export const cameraRemovalReports = pgTable(
  "camera_removal_reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    cameraId: uuid("camera_id")
      .notNull()
      .references(() => fixedSpeedCameras.id, { onDelete: "cascade" }),
    reporterId: text("reporter_id").notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("camera_removal_reports_camera_reporter_uq").on(t.cameraId, t.reporterId)],
);
