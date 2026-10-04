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
    /**
     * Country set of the camera an event is about (null for every other event), copied from the entity at append time so
     * delta, WebSocket push and federation egress decide without re-deriving a country (docs/camera-country-policy.md).
     */
    cameraCountries: text("camera_countries").array(),
    moderationStatus: moderationStatusEnum("moderation_status").notNull().default("accepted"),
    source: text("source").notNull(),
    // Federation (F-S3), all nullable — null means "not federation-eligible",
    // i.e. everything before this milestone and every event whose reporting
    // device never signed its own content (see modules/federation/device-event.ts).
    // federationEventId = sha256(canonical({payload, signature})) of the
    // device-signed SignedEnvelope<DeviceCreateEventPayload> that produced
    // this row — a cross-server-stable id, unlike `sequence` (per-server,
    // per-process bigserial). UNIQUE so re-ingesting the same event (pushed
    // by two different peers, or pushed then pulled) is a plain insert
    // conflict the ingest path already checks for before writing, not a
    // silent duplicate.
    federationEventId: text("federation_event_id").unique(),
    // The full SignedEnvelope, verbatim — kept so this event can be
    // re-broadcast to other peers, or re-verified independently by anyone,
    // without reconstructing it from the (already-derived) materialized payload.
    federationEnvelope: jsonb("federation_envelope"),
    // The peer this event was received from (POST /v1/federation/events or
    // GET /v1/federation/events pull) — null when it originated locally on
    // this server (a device submitted it directly to us). Used only to avoid
    // immediately gossiping an event straight back to the peer that just sent
    // it; never a trust signal (see modules/crypto/envelope.ts's keyId comment
    // — the same "hint, not a boundary" principle applies here).
    originNodeId: text("origin_node_id"),
  },
  (t) => [
    index("event_log_occurred_at_idx").on(t.occurredAt),
    index("event_log_region_tile_idx").on(t.regionTile),
    index("event_log_type_idx").on(t.type),
    index("event_log_federation_event_id_idx").on(t.federationEventId),
  ],
);
