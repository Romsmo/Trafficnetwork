import { randomUUID } from "node:crypto";
import type { Database, Queryable, Transaction } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import type { CorrectionReason, CorrectionVoteKind, SpeedLimitUnit } from "../../config/constants.js";
import { appendEvent } from "../../db/append-event.js";
import {
  countRecentVotesBySubmitter,
  deleteCorrectionRow,
  findBan,
  findCorrectionApiById,
  findCorrectionRowById,
  insertVote,
  listCorrectionRowsForKey,
  listStandingVotes,
  lockSegmentKey,
  lookupBaseValue,
  upsertCorrection,
  zeroCorrectionCounters,
  type CorrectionApi,
  type NewVote,
} from "../../db/queries/speed-limit-corrections.js";
import { findSpeedLimitSegmentById, findSpeedLimitSegmentsByKey, type SpeedLimitSegmentApi } from "../../db/queries/speed-limit-segments.js";
import { conflict, forbidden, notFound, tooManyRequests, unprocessable } from "../../lib/errors.js";
import { validateCorrectionValue } from "./plausibility.js";
import { candidateKey, correctionId, currentStance, decideWinners, deriveStatus, tallyVotes } from "./tally.js";

type AppendedEvent = Awaited<ReturnType<typeof appendEvent>>;

/** The effective value of one (segment, unit) changed — what has to be announced as static-data. `null` means "the imported value". */
export interface EffectiveChange {
  segmentKey: string;
  unit: SpeedLimitUnit;
  before: number | null;
  after: number | null;
}

/**
 * Re-derives the materialised corrections of one segment from its votes
 * (docs D2) and reports whether the *effective* value of any unit changed.
 * Everything here is a function of the vote set, the threshold and the
 * operator's blocks — never of arrival order.
 *
 * Caller must hold the segment lock (lockSegmentKey) — taken again here, which
 * is a no-op inside the same transaction, so a direct call is safe too.
 */
export async function recomputeSegment(tx: Transaction, env: Env, segmentKey: string): Promise<EffectiveChange[]> {
  await lockSegmentKey(tx, segmentKey);
  const threshold = env.COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED;

  const tallies = tallyVotes(await listStandingVotes(tx, segmentKey));
  const existing = await listCorrectionRowsForKey(tx, segmentKey);
  const existingByKey = new Map(existing.map((row) => [candidateKey(row.unit, row.value), row]));
  const blocked = new Set(existing.filter((row) => row.blockedAt !== null).map((row) => candidateKey(row.unit, row.value)));
  const winners = decideWinners(tallies, threshold, blocked);

  const before = new Map<SpeedLimitUnit, number>();
  for (const row of existing) if (row.status === "applied") before.set(row.unit, row.value);

  for (const tally of tallies.values()) {
    const row = existingByKey.get(tally.key);
    // An objection to a value nobody supports (a replicated `deny` that arrived
    // first, or for a value that was never proposed) is kept in the vote log —
    // the tally needs it if supporters show up later — but is not a correction
    // worth a row of its own.
    if (tally.support === 0 && !row) continue;
    const status = deriveStatus({
      tally,
      winnerKey: winners.get(tally.unit) ?? null,
      threshold,
      blocked: blocked.has(tally.key),
      wasApplied: row?.appliedAt != null,
    });
    await upsertCorrection(tx, {
      id: row?.id ?? correctionId(segmentKey, tally.unit, tally.value),
      segmentKey,
      unit: tally.unit,
      value: tally.value,
      reason: tally.reason,
      status,
      supportCount: tally.support,
      denyCount: tally.deny,
      firstProposedAt: new Date(tally.firstVoteAt),
      lastVoteAt: new Date(tally.lastVoteAt),
      appliedNow: status === "applied" && row?.status !== "applied",
      revertedNow: row?.status === "applied" && status !== "applied",
      baseValue: row?.baseValue ?? (await lookupBaseValue(tx, segmentKey, tally.unit)),
    });
  }

  // Rows whose every vote is gone (all their reporters banned): an operator-blocked
  // row is kept — so an unban followed by new votes still respects the reset — anything else disappears.
  for (const row of existing) {
    if (tallies.has(candidateKey(row.unit, row.value))) continue;
    if (row.blockedAt !== null) await zeroCorrectionCounters(tx, row.id);
    else await deleteCorrectionRow(tx, row.id);
  }

  const changes: EffectiveChange[] = [];
  const units = new Set<SpeedLimitUnit>([...before.keys(), ...winners.keys()]);
  for (const unit of units) {
    const winnerKey = winners.get(unit) ?? null;
    const after = winnerKey ? (tallies.get(winnerKey)?.value ?? null) : null;
    const previous = before.get(unit) ?? null;
    if (previous !== after) changes.push({ segmentKey, unit, before: previous, after });
  }
  return changes;
}

/**
 * Announces changed effective values as static data (docs D8): one
 * `StaticDataUpdated` event per affected local segment row (a re-import leaves
 * duplicate rows with the same key), payload = the full segment as served,
 * which also bumps static_data_state.version so the packages are rebuilt.
 * `overlay` says which value the payload carries — always true for a vote; the
 * feature-switch flip passes the *new* switch state.
 */
export async function announceChanges(
  tx: Transaction,
  changes: readonly Pick<EffectiveChange, "segmentKey" | "unit">[],
  overlay: boolean,
): Promise<AppendedEvent[]> {
  const events: AppendedEvent[] = [];
  for (const change of changes) {
    for (const segment of await findSpeedLimitSegmentsByKey(tx, change.segmentKey, change.unit, overlay)) {
      events.push(
        await appendEvent(tx, {
          type: "StaticDataUpdated",
          entityType: "speedLimitSegment",
          entityId: segment.id,
          payload: segment,
          regionTile: null,
          source: "community",
        }),
      );
    }
  }
  return events;
}

export interface ApplyVoteOptions {
  /** A vote sent to *this* server's API: enforces ban, no-op detection and the per-client rate limit. False for a replicated vote. */
  local: boolean;
}

export interface ApplyVoteResult {
  recorded: boolean;
  /** Why nothing was stored: the reporter already holds exactly this stance, or the same signed vote was already known. */
  noop?: "already_holds_stance" | "duplicate";
  changes: EffectiveChange[];
  events: AppendedEvent[];
}

/**
 * The one write path for a vote, local or replicated: lock the segment,
 * insert idempotently, recompute, announce. A replicated vote from a banned
 * reporter is still stored (a ban is local policy and can be lifted) — it just
 * isn't counted.
 */
export async function applyVote(db: Database["db"], env: Env, vote: NewVote, opts: ApplyVoteOptions): Promise<ApplyVoteResult> {
  return db.transaction(async (tx) => {
    await lockSegmentKey(tx, vote.segmentKey);

    if (opts.local) {
      if (await findBan(tx, vote.reporterId)) {
        throw forbidden("This reporter has been barred from submitting speed-limit corrections");
      }
      const standing = await listStandingVotes(tx, vote.segmentKey);
      const stance = currentStance(standing, vote.reporterId, vote.unit, vote.value);
      if (stance === vote.kind) return { recorded: false, noop: "already_holds_stance", changes: [], events: [] };

      // Per calling client, not per reporter: alternating signed and unsigned
      // votes (two reporter identities, one client) must not double the budget.
      const recent = await countRecentVotesBySubmitter(tx, vote.submittedBy ?? vote.reporterId, env.COMMUNITY_CORRECTIONS_RATE_LIMIT_WINDOW_MINUTES);
      if (recent >= env.COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX) {
        throw tooManyRequests(
          `Rate limit exceeded: max ${env.COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX} speed-limit corrections per ${env.COMMUNITY_CORRECTIONS_RATE_LIMIT_WINDOW_MINUTES} minutes`,
        );
      }
    }

    const seq = await insertVote(tx, vote);
    if (seq === null) return { recorded: false, noop: "duplicate", changes: [], events: [] };

    const changes = await recomputeSegment(tx, env, vote.segmentKey);
    const events = await announceChanges(tx, changes, true);
    return { recorded: true, changes, events };
  });
}

export interface LocalCaller {
  /** JWT subject of the authenticated client — what the rate limit counts. */
  sub: string;
  /** The reporter identity this caller votes as (docs D10). */
  reporterId: string;
}

export interface CastVoteInput {
  segment: SpeedLimitSegmentApi;
  kind: CorrectionVoteKind;
  value: number;
  unit: SpeedLimitUnit;
  reason: CorrectionReason | null;
  caller: LocalCaller;
  /** Present for a device-signed vote; the id/timestamp/envelope come from it. */
  signed: { voteId: string; voteTimestamp: Date; envelope: unknown; originNodeId: null } | null;
}

export interface CastVoteResult extends ApplyVoteResult {
  correction: CorrectionApi | null;
  /** The correction record for this value already existed before this vote — the vote merged into it. */
  merged: boolean;
  segment: SpeedLimitSegmentApi;
}

/**
 * A vote arriving through this server's own API (docs D3). Value/unit
 * plausibility, "must reference a concrete segment", "must differ from the
 * import" — all before anything is written.
 */
export async function castLocalVote(db: Database["db"], env: Env, input: CastVoteInput): Promise<CastVoteResult> {
  const { segment } = input;
  if (input.unit !== segment.speedLimitUnit) {
    throw unprocessable(
      "CORRECTION_UNIT_MISMATCH",
      `This segment's limit is in ${segment.speedLimitUnit}; a correction must use the unit of the source`,
      { segmentUnit: segment.speedLimitUnit },
    );
  }
  if (input.kind === "support") {
    validateCorrectionValue(input.value, input.unit, env);
    const importedValue = segment.importedSpeedLimit ?? segment.speedLimit;
    if (input.value === importedValue) {
      throw unprocessable("CORRECTION_NO_CHANGE", "The proposed value equals the imported one — nothing to correct; use a denial to object to a correction instead");
    }
  }

  const id = correctionId(segment.segmentKey, input.unit, input.value);
  const existedBefore = (await findCorrectionRowById(db, id)) !== null;

  const now = new Date();
  const vote: NewVote = {
    id: input.signed?.voteId ?? `local:${randomUUID()}`,
    segmentKey: segment.segmentKey,
    reporterId: input.caller.reporterId,
    submittedBy: input.caller.sub,
    kind: input.kind,
    value: input.value,
    unit: input.unit,
    reason: input.reason,
    voteTimestamp: input.signed?.voteTimestamp ?? now,
    envelope: input.signed?.envelope ?? null,
    originNodeId: null,
  };
  const result = await applyVote(db, env, vote, { local: true });
  if (result.noop === "duplicate") {
    throw conflict("DUPLICATE_FEDERATION_EVENT", "This exact signed vote has already been recorded");
  }

  const correction = await findCorrectionApiById(db, id);
  const effective = (await findSpeedLimitSegmentById(db, segment.id, true)) ?? segment;
  return { ...result, correction, merged: existedBefore, segment: effective };
}

/** 404 unless the correction exists *and* this server has a segment it applies to. Returns that segment (first local row). */
export async function loadCorrectionTarget(db: Queryable, env: Env, correctionIdParam: string) {
  const row = await findCorrectionRowById(db, correctionIdParam);
  if (!row) throw notFound(`No speed-limit correction with id ${correctionIdParam}`);
  const segments = await findSpeedLimitSegmentsByKey(db, row.segmentKey, row.unit, env.COMMUNITY_CORRECTIONS_ENABLED);
  const segment = segments[0];
  if (!segment) throw notFound("This server has no segment for that correction (it was proposed on another server)");
  return { row, segment };
}
