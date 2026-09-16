import { bigserial, index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { entityTypeEnum, eventTypeEnum, moderationStatusEnum } from "./enums.js";

/**
 * Append-only event log, docs/concept.md section 5.1 / docs/prompt-phase1-server.md
 * section 5.1. Never updated or deleted except by the scheduled retention-cleanup
 * job (see modules/expiry). payload holds the full current representation of the
 * entity (not a diff), so a client replaying deltas never has to fetch the entity
 * separately. sequence is a plain integer (not bigint) — at Phase 1/foreseeable
 * scale (many orders of magnitude below 2^53 events) this stays a safe JS integer,
 * which keeps it usable directly in delta query params and JSON responses without
 * bigint (de)serialization workarounds.
 */
export const eventLog = pgTable(
  "event_log",
  {
    sequence: bigserial("sequence", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    type: eventTypeEnum("type").notNull(),
    entityType: entityTypeEnum("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    payload: jsonb("payload").notNull(),
    regionTile: varchar("region_tile", { length: 15 }),
    moderationStatus: moderationStatusEnum("moderation_status").notNull().default("accepted"),
    source: text("source").notNull(),
  },
  (t) => [
    index("event_log_occurred_at_idx").on(t.occurredAt),
    index("event_log_region_tile_idx").on(t.regionTile),
    index("event_log_type_idx").on(t.type),
  ],
);
