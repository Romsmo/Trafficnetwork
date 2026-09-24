import { bigserial, index, integer, pgTable, text, timestamp, unique, uuid, jsonb } from "drizzle-orm/pg-core";
import { correctionReasonEnum, correctionStatusEnum, correctionVoteKindEnum, speedLimitUnitEnum } from "./enums.js";

/**
 * Community speed-limit corrections (add-on K-A, docs/speed-limit-corrections.md).
 * Both tables reference a segment by `segment_key` — the content-derived key of
 * its geometry (speed_limit_segments.geometry_key), *not* the per-server row
 * id — so a device-signed vote means the same thing on every federated server.
 * There is deliberately no foreign key to speed_limit_segments: a vote may
 * arrive before its segment is imported, and must survive a wipe-and-reimport.
 */

/**
 * Append-only log of votes, the source of truth. The effective state is a pure
 * function of the set of non-banned votes (see modules/speed-limit-corrections/tally.ts).
 * `id` is the cross-server-stable vote id (sha256 over the signed envelope) for
 * a signed vote, `local:<uuid>` for an unsigned one; `seq` is this server's own
 * insertion order and the cursor for the federation pull stream.
 */
export const speedLimitCorrectionVotes = pgTable(
  "speed_limit_correction_votes",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    id: text("id").notNull().unique(),
    segmentKey: text("segment_key").notNull(),
    reporterId: text("reporter_id").notNull(),
    // The authenticated client that submitted it locally (JWT subject) — what
    // the per-client rate limit counts. Null for a vote replicated from a peer.
    submittedBy: text("submitted_by"),
    kind: correctionVoteKindEnum("kind").notNull(),
    value: integer("value").notNull(),
    unit: speedLimitUnitEnum("unit").notNull(),
    reason: correctionReasonEnum("reason"),
    // The signed timestamp for a device-signed vote, receive time otherwise —
    // the ordering key of the per-reporter fold.
    voteTimestamp: timestamp("vote_timestamp", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    // The full SignedEnvelope, verbatim — null for an unsigned (node-local) vote,
    // which is never replicated.
    envelope: jsonb("envelope"),
    originNodeId: text("origin_node_id"),
  },
  (t) => [
    index("speed_limit_correction_votes_segment_idx").on(t.segmentKey),
    index("speed_limit_correction_votes_reporter_idx").on(t.reporterId),
    index("speed_limit_correction_votes_submitted_by_idx").on(t.submittedBy, t.receivedAt),
  ],
);

/**
 * Materialised view of the votes: one row per (segment_key, unit, value) that
 * at least one vote names. `id` is deterministic (tally.ts's correctionId), so
 * `POST /v1/speed-limit-corrections/:id/confirmations` addresses the same
 * record on every server. Counters and status are re-derived on every vote;
 * applied_at/reverted_at/base_value/blocked_* are node-local bookkeeping.
 */
export const speedLimitCorrections = pgTable(
  "speed_limit_corrections",
  {
    id: uuid("id").primaryKey(),
    segmentKey: text("segment_key").notNull(),
    unit: speedLimitUnitEnum("unit").notNull(),
    value: integer("value").notNull(),
    reason: correctionReasonEnum("reason"),
    status: correctionStatusEnum("status").notNull().default("proposed"),
    supportCount: integer("support_count").notNull().default(0),
    denyCount: integer("deny_count").notNull().default(0),
    firstProposedAt: timestamp("first_proposed_at", { withTimezone: true }).notNull(),
    lastVoteAt: timestamp("last_vote_at", { withTimezone: true }).notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    // The imported value this correction was proposed against on this server
    // (first matching segment row) — the reference for "the import changed
    // since" (needsReview). Filled lazily if the segment arrives later.
    baseValue: integer("base_value"),
    // Operator reset (npm run corrections -- reset): the candidate can never
    // win until restored, whatever the votes say.
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    blockedReason: text("blocked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("speed_limit_corrections_candidate_uq").on(t.segmentKey, t.unit, t.value),
    index("speed_limit_corrections_segment_idx").on(t.segmentKey),
    index("speed_limit_corrections_status_idx").on(t.status),
  ],
);

/** Operator-maintained: votes by a banned reporter are excluded from every tally (and can be restored by unbanning). Local policy, never federated. */
export const speedLimitCorrectionBans = pgTable("speed_limit_correction_bans", {
  reporterId: text("reporter_id").primaryKey(),
  reason: text("reason"),
  bannedAt: timestamp("banned_at", { withTimezone: true }).notNull().defaultNow(),
});
