import { createHash } from "node:crypto";
import type { CorrectionReason, CorrectionStatus, CorrectionVoteKind, SpeedLimitUnit } from "../../config/constants.js";

/**
 * The pure core of community speed-limit corrections (docs/speed-limit-corrections.md
 * D2–D5): no database, no clock, no environment. Everything a server needs to
 * decide "which value is in effect" is a function of the *set* of votes, so two
 * servers holding the same signed votes reach the same answer in any arrival
 * order — that is what makes the federated merge deterministic.
 */

export interface VoteInput {
  /** Unique per vote; also the final tie-break for ordering. */
  id: string;
  /** Pseudonymous device identity — one voice per reporter per segment. */
  reporterId: string;
  kind: CorrectionVoteKind;
  value: number;
  unit: SpeedLimitUnit;
  /** Milliseconds since epoch: the signed timestamp for a device-signed vote, receive time for an unsigned one. */
  timestamp: number;
  reason?: CorrectionReason | null;
}

export function candidateKey(unit: SpeedLimitUnit, value: number): string {
  return `${unit}:${value}`;
}

export interface CandidateTally {
  key: string;
  unit: SpeedLimitUnit;
  value: number;
  /** Distinct reporters whose current stance is "the limit is `value`". */
  support: number;
  /** Distinct reporters whose current stance is "`value` is wrong". */
  deny: number;
  /** support − deny: the number compared against the threshold. */
  net: number;
  /** Earliest / latest timestamp of any vote naming this candidate (standing or not). */
  firstVoteAt: number;
  lastVoteAt: number;
  /** Reason of the earliest support vote that carried one. */
  reason: CorrectionReason | null;
}

interface Stance {
  support: string | null;
  denies: Set<string>;
}

/** Deterministic total order: signed timestamp, then vote id. */
function compareVotes(a: VoteInput, b: VoteInput): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Folds the votes into per-candidate tallies.
 *
 * Per reporter, in (timestamp, id) order:
 *  - `support(X)` sets the reporter's one support to X (withdrawing an earlier
 *    `support(Y)`) and clears their own `deny(X)`;
 *  - `deny(X)` adds X to the reporter's denials and withdraws their own `support(X)`.
 * Repeating the same stance changes nothing, so the fold is idempotent.
 */
export function tallyVotes(votes: readonly VoteInput[]): Map<string, CandidateTally> {
  const ordered = [...votes].sort(compareVotes);
  const stances = new Map<string, Stance>();
  const meta = new Map<string, Omit<CandidateTally, "support" | "deny" | "net">>();

  for (const vote of ordered) {
    const key = candidateKey(vote.unit, vote.value);
    let candidate = meta.get(key);
    if (!candidate) {
      candidate = { key, unit: vote.unit, value: vote.value, firstVoteAt: vote.timestamp, lastVoteAt: vote.timestamp, reason: null };
      meta.set(key, candidate);
    }
    candidate.lastVoteAt = vote.timestamp;
    if (vote.kind === "support" && candidate.reason === null && vote.reason) candidate.reason = vote.reason;

    let stance = stances.get(vote.reporterId);
    if (!stance) {
      stance = { support: null, denies: new Set() };
      stances.set(vote.reporterId, stance);
    }
    if (vote.kind === "support") {
      stance.support = key;
      stance.denies.delete(key);
    } else {
      stance.denies.add(key);
      if (stance.support === key) stance.support = null;
    }
  }

  const supports = new Map<string, number>();
  const denies = new Map<string, number>();
  for (const stance of stances.values()) {
    if (stance.support) supports.set(stance.support, (supports.get(stance.support) ?? 0) + 1);
    for (const key of stance.denies) denies.set(key, (denies.get(key) ?? 0) + 1);
  }

  const result = new Map<string, CandidateTally>();
  for (const [key, candidate] of meta) {
    const support = supports.get(key) ?? 0;
    const deny = denies.get(key) ?? 0;
    result.set(key, { ...candidate, support, deny, net: support - deny });
  }
  return result;
}

/**
 * Winner per unit (docs D4): among candidates that are not operator-blocked and
 * whose net confirmations reach the threshold, the highest net wins. A tie for
 * first place has **no** winner — the imported value stays until one side gets
 * another confirmation. Returns unit → winning candidate key (or null).
 */
export function decideWinners(
  tallies: ReadonlyMap<string, CandidateTally>,
  threshold: number,
  blocked: ReadonlySet<string>,
): Map<SpeedLimitUnit, string | null> {
  const winners = new Map<SpeedLimitUnit, string | null>();
  const byUnit = new Map<SpeedLimitUnit, CandidateTally[]>();
  for (const tally of tallies.values()) {
    if (!byUnit.has(tally.unit)) byUnit.set(tally.unit, []);
    byUnit.get(tally.unit)!.push(tally);
  }
  for (const [unit, candidates] of byUnit) {
    const eligible = candidates.filter((c) => !blocked.has(c.key) && c.net >= threshold);
    if (eligible.length === 0) {
      winners.set(unit, null);
      continue;
    }
    const top = Math.max(...eligible.map((c) => c.net));
    const leaders = eligible.filter((c) => c.net === top);
    winners.set(unit, leaders.length === 1 ? leaders[0]!.key : null);
  }
  return winners;
}

/**
 * Lifecycle status (docs D5). `wasApplied` is node-local history (the row's
 * applied_at is set) — it only distinguishes "never made it" (`proposed`) from
 * "was in effect once" (`reverted`/`superseded`); it never influences *which*
 * value is in effect.
 */
export function deriveStatus(input: {
  tally: CandidateTally;
  winnerKey: string | null;
  threshold: number;
  blocked: boolean;
  wasApplied: boolean;
}): CorrectionStatus {
  if (input.blocked) return "reverted";
  if (input.winnerKey === input.tally.key) return "applied";
  if (input.winnerKey !== null) {
    return input.tally.net >= input.threshold || input.wasApplied ? "superseded" : "proposed";
  }
  return input.wasApplied ? "reverted" : "proposed";
}

/**
 * The stance a reporter currently holds on a candidate — used to make repeated
 * votes idempotent (a no-op is neither stored nor counted against the rate limit).
 */
export function currentStance(votes: readonly VoteInput[], reporterId: string, unit: SpeedLimitUnit, value: number): "support" | "deny" | null {
  const key = candidateKey(unit, value);
  const ordered = votes.filter((v) => v.reporterId === reporterId).sort(compareVotes);
  let support: string | null = null;
  const denies = new Set<string>();
  for (const vote of ordered) {
    const k = candidateKey(vote.unit, vote.value);
    if (vote.kind === "support") {
      support = k;
      denies.delete(k);
    } else {
      denies.add(k);
      if (support === k) support = null;
    }
  }
  if (support === key) return "support";
  if (denies.has(key)) return "deny";
  return null;
}

/** Deterministic, cross-server-stable id of a correction record: sha256 of its natural key, first 128 bits as a UUID. */
export function correctionId(segmentKey: string, unit: SpeedLimitUnit, value: number): string {
  const hex = createHash("sha256").update(`speedLimitCorrection|${segmentKey}|${unit}|${value}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
