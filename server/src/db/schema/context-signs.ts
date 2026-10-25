import { bigserial, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { geometryColumn } from "./geometry.js";

/**
 * Context signs (docs/context-signs.md): traffic signs that apply on a stretch of road, with a direction and a validity in time,
 * entered by users and confirmed by other devices. The votes are the source of truth, the entries a materialised view.
 */

/**
 * One row per entry a vote names. `entry_key` is content-derived (a hash of the canonical descriptor: sign, shape, direction,
 * validity, value), so the same proposal made by different devices - on different servers - is the same row, with no
 * coordination. The descriptor is stored verbatim as the voters signed it; nothing is recomputed from the road network.
 */
export const contextSignEntries = pgTable(
  "context_sign_entries",
  {
    entryKey: text("entry_key").primaryKey(),
    descriptor: jsonb("descriptor").notNull(),
    signType: text("sign_type").notNull(),
    /** 'prohibition' or 'hazard' - decides the confirmation threshold. */
    signClass: text("sign_class").notNull(),
    geometry: geometryColumn("geometry", "LineString").notNull(),
    lengthM: integer("length_m").notNull(),
    /** The H3 tiles (at `tile_resolution`) the shape touches, by the same vertex rule as the static-data packages. */
    tiles: text("tiles").array().notNull(),
    tileResolution: integer("tile_resolution").notNull(),
    /** proposed | confirmed | disputed | expired | removed - derived from the votes (tally.ts), `removed` by an operator. */
    status: text("status").notNull().default("proposed"),
    supportCount: integer("support_count").notNull().default(0),
    denyCount: integer("deny_count").notNull().default(0),
    firstProposedAt: timestamp("first_proposed_at", { withTimezone: true }).notNull(),
    lastVoteAt: timestamp("last_vote_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
    /** After this the entry is no longer delivered (null = until revoked). Derived, see tally.ts. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Node-local operator decision: removed entries are not delivered whatever the votes say, until restored. */
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    blockedReason: text("blocked_reason"),
    /** The client that first sent it to this server (rate limit of new proposals); null when it arrived by federation. */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("context_sign_entries_geometry_gist").using("gist", t.geometry),
    index("context_sign_entries_tiles_gin").using("gin", t.tiles),
    index("context_sign_entries_status_idx").on(t.status, t.expiresAt),
    index("context_sign_entries_created_by_idx").on(t.createdBy, t.createdAt),
  ],
);

/**
 * Append-only log of votes (support / deny). `id` is the cross-server vote id (sha256 over the signed envelope) for a signed
 * vote, `local:<uuid>` for an unsigned one; `seq` is this server's own cursor for the federation pull stream.
 */
export const contextSignVotes = pgTable(
  "context_sign_votes",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    id: text("id").notNull().unique(),
    entryKey: text("entry_key").notNull(),
    reporterId: text("reporter_id").notNull(),
    submittedBy: text("submitted_by"),
    kind: text("kind").notNull(),
    voteTimestamp: timestamp("vote_timestamp", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** The full SignedEnvelope, verbatim - null for an unsigned (node-local) vote, which is never replicated. */
    envelope: jsonb("envelope"),
    originNodeId: text("origin_node_id"),
  },
  (t) => [
    index("context_sign_votes_entry_idx").on(t.entryKey),
    index("context_sign_votes_reporter_idx").on(t.reporterId),
    index("context_sign_votes_submitted_by_idx").on(t.submittedBy, t.receivedAt),
  ],
);

/** Operator-maintained: votes by a banned reporter are excluded from every tally. Local policy, never federated. */
export const contextSignBans = pgTable("context_sign_bans", {
  reporterId: text("reporter_id").primaryKey(),
  reason: text("reason"),
  bannedAt: timestamp("banned_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A counter clients compare to know whether the delivered set changed (one row, id = 1). */
export const contextSignState = pgTable("context_sign_state", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
