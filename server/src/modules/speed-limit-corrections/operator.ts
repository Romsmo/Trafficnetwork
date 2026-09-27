import type { Database, Transaction } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import type { appendEvent } from "../../db/append-event.js";
import {
  deleteBan,
  findCorrectionRowById,
  insertBan,
  listCorrections,
  listSegmentKeysVotedBy,
  listVoteLog,
  lockSegmentKey,
  setCorrectionBlocked,
  type CorrectionApi,
  type VoteLogEntry,
} from "../../db/queries/speed-limit-corrections.js";
import { findSpeedLimitSegmentById, findSpeedLimitSegmentsByKey, type SpeedLimitSegmentApi } from "../../db/queries/speed-limit-segments.js";
import { notFound, badRequest } from "../../lib/errors.js";
import { announceChanges, recomputeSegment, type EffectiveChange } from "./service.js";
import { SEGMENT_KEY_PATTERN } from "./vote.js";

/**
 * The operator's tools for community speed-limit corrections
 * (scripts/corrections.mts is the CLI over these; docs/operating.md has the
 * runbook). Everything here is local policy: it changes what *this* server
 * counts and serves, and is never replicated — another operator may
 * legitimately decide differently about the same votes.
 */

export interface OperatorOutcome {
  /** Effective values that changed as a result (empty if the action didn't alter what is served). */
  changes: EffectiveChange[];
  events: Awaited<ReturnType<typeof appendEvent>>[];
}

/** Recompute (and, when the feature is on, announce) inside one transaction per segment. */
async function recomputeAndAnnounce(
  db: Database["db"],
  env: Env,
  segmentKey: string,
  before?: (tx: Transaction) => Promise<unknown>,
): Promise<OperatorOutcome> {
  return db.transaction(async (tx) => {
    await lockSegmentKey(tx, segmentKey);
    if (before) await before(tx);
    const changes = await recomputeSegment(tx, env, segmentKey);
    const events = env.COMMUNITY_CORRECTIONS_ENABLED ? await announceChanges(tx, changes, true, env.STATIC_DATA_PARTITION_H3_RESOLUTION) : [];
    return { changes, events };
  });
}

/** A segment id (UUID) or a segment key (32 hex characters) → the segment key. */
export async function resolveSegmentKey(db: Database["db"], ref: string): Promise<string> {
  if (SEGMENT_KEY_PATTERN.test(ref)) return ref;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
    const segment = await findSpeedLimitSegmentById(db, ref, false);
    if (!segment) throw notFound(`No speed-limit segment with id ${ref}`);
    return segment.segmentKey;
  }
  throw badRequest("Expected a segment id (UUID) or a segment key (32 hex characters)");
}

export interface SegmentReport {
  segmentKey: string;
  /** Every local row with this geometry (a re-import creates duplicates), overlay as currently served. */
  segments: Omit<SpeedLimitSegmentApi, "geometry">[];
  /** All statuses. */
  corrections: CorrectionApi[];
  /** Every vote, including those of banned reporters (flagged). Reporter ids are pseudonyms. */
  votes: VoteLogEntry[];
}

export async function showSegment(db: Database["db"], env: Env, ref: string): Promise<SegmentReport> {
  const segmentKey = await resolveSegmentKey(db, ref);
  const corrections = await listCorrections(db, {
    statuses: ["proposed", "applied", "superseded", "reverted"],
    segmentKey,
    includeUnsupported: true,
    limit: 1000,
  });
  const units = new Set(corrections.map((c) => c.unit));
  const rows: SpeedLimitSegmentApi[] = [];
  for (const unit of units.size > 0 ? units : new Set(["kmh", "mph"] as const)) {
    rows.push(...(await findSpeedLimitSegmentsByKey(db, segmentKey, unit, env.COMMUNITY_CORRECTIONS_ENABLED)));
  }
  return {
    segmentKey,
    segments: rows.map(({ geometry: _geometry, ...rest }) => rest),
    corrections,
    votes: await listVoteLog(db, segmentKey),
  };
}

/**
 * Reset one correction: it can never win until restored, whatever the votes
 * say — so the imported value (or the next-best candidate) is served again
 * immediately, and new votes cannot quietly bring it back. Votes are kept.
 */
export async function resetCorrection(db: Database["db"], env: Env, correctionId: string, reason: string | null): Promise<OperatorOutcome> {
  const row = await findCorrectionRowById(db, correctionId);
  if (!row) throw notFound(`No speed-limit correction with id ${correctionId}`);
  return recomputeAndAnnounce(db, env, row.segmentKey, (tx) => setCorrectionBlocked(tx, correctionId, { reason }));
}

/** Undo a reset — the correction is judged by its votes again. */
export async function restoreCorrection(db: Database["db"], env: Env, correctionId: string): Promise<OperatorOutcome> {
  const row = await findCorrectionRowById(db, correctionId);
  if (!row) throw notFound(`No speed-limit correction with id ${correctionId}`);
  return recomputeAndAnnounce(db, env, row.segmentKey, (tx) => setCorrectionBlocked(tx, correctionId, null));
}

/**
 * The one-command rollback: reset every correction that is currently in
 * effect. Resetting a winner can promote a runner-up that was waiting behind
 * it (docs D4), so this repeats until nothing is applied any more — the
 * imported values are what is served afterwards, everywhere.
 */
export async function resetAllApplied(db: Database["db"], env: Env, reason: string | null): Promise<{ reset: number }> {
  let reset = 0;
  for (let round = 0; round < 10; round++) {
    const applied = await listCorrections(db, { statuses: ["applied"], limit: 1_000_000 });
    if (applied.length === 0) break;
    for (const correction of applied) await resetCorrection(db, env, correction.id, reason);
    reset += applied.length;
  }
  return { reset };
}

/** Votes by a banned reporter stop counting on this server, retroactively; unbanning restores them. */
export async function banReporter(db: Database["db"], env: Env, reporterId: string, reason: string | null): Promise<{ newlyBanned: boolean; segmentsRecomputed: number }> {
  const newlyBanned = await insertBan(db, reporterId, reason);
  const keys = await listSegmentKeysVotedBy(db, reporterId);
  for (const key of keys) await recomputeAndAnnounce(db, env, key);
  return { newlyBanned, segmentsRecomputed: keys.length };
}

export async function unbanReporter(db: Database["db"], env: Env, reporterId: string): Promise<{ wasBanned: boolean; segmentsRecomputed: number }> {
  const wasBanned = await deleteBan(db, reporterId);
  const keys = await listSegmentKeysVotedBy(db, reporterId);
  for (const key of keys) await recomputeAndAnnounce(db, env, key);
  return { wasBanned, segmentsRecomputed: keys.length };
}
