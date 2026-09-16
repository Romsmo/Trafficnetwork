import {
  bigserial,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { confirmationKindEnum, hazardSourceEnum, hazardStatusEnum, hazardTypeEnum } from "./enums.js";
import { geometryColumn } from "./geometry.js";

/**
 * Dynamic live report: docs/concept.md section 3.2. Synced regionally (filtered by
 * regionTile), lives on community confirmation/contradiction. type never takes the
 * value "fixedSpeedCamera" here — that classification is intercepted at the API
 * boundary and routed into fixed_speed_cameras instead (see modules/cameras).
 *
 * confirmCount/denyCount are denormalized counters maintained transactionally
 * alongside hazard_confirmations inserts (see modules/moderation/gate.ts) rather
 * than computed with a COUNT(*) join on every read — cheap at write time, since
 * every write already opens a transaction for the moderation gate.
 */
export const hazardReports = pgTable(
  "hazard_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: hazardTypeEnum("type").notNull(),
    position: geometryColumn("position", "Point").notNull(),
    regionTile: varchar("region_tile", { length: 15 }).notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    reporterId: text("reporter_id").notNull(),
    speedKmh: integer("speed_kmh"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: hazardStatusEnum("status").notNull().default("active"),
    source: hazardSourceEnum("source").notNull().default("community"),
    sourceLicense: text("source_license"),
    confirmCount: integer("confirm_count").notNull().default(0),
    denyCount: integer("deny_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("hazard_reports_position_gist").using("gist", t.position),
    index("hazard_reports_tile_status_idx").on(t.regionTile, t.status),
    index("hazard_reports_status_expires_idx").on(t.status, t.expiresAt),
    index("hazard_reports_type_idx").on(t.type),
  ],
);

/** One confirmation/denial per reporter per report (UNIQUE), enforced at the DB level. */
export const hazardConfirmations = pgTable(
  "hazard_confirmations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    hazardReportId: uuid("hazard_report_id")
      .notNull()
      .references(() => hazardReports.id, { onDelete: "cascade" }),
    reporterId: text("reporter_id").notNull(),
    confirmation: confirmationKindEnum("confirmation").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("hazard_confirmations_report_reporter_uq").on(t.hazardReportId, t.reporterId)],
);
