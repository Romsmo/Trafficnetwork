import type { SignClass } from "./catalog.js";
import type { Validity } from "./descriptor.js";

/**
 * The pure core of context signs (docs/context-signs.md D4-D6): no database, no clock, no environment. What an entry is -
 * proposed, confirmed, disputed - is a function of the *set* of votes, so two servers holding the same signed votes reach the
 * same answer in any arrival order. That is what makes the federated merge deterministic.
 */

export interface VoteInput {
  /** Unique per vote; the final tie-break of the order. */
  id: string;
  reporterId: string;
  kind: "support" | "deny";
  /** Milliseconds since epoch: the signed timestamp for a device-signed vote, receive time for an unsigned one. */
  timestamp: number;
}

export interface EntryTally {
  /** Distinct voices whose standing stance is "this sign applies here" (web visitors together count as at most one). */
  support: number;
  deny: number;
  firstVoteAt: number;
  lastVoteAt: number;
  /** The latest standing support: what keeps an open-ended entry alive. 0 when nobody supports it. */
  lastSupportAt: number;
}

/** Anonymous web visitors mint a new identity with every session, so they are counted together, not one by one (docs D6). */
export const WEB_REPORTER_PREFIX = "web:";

function compareVotes(a: VoteInput, b: VoteInput): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Folds the votes into the tally. Per reporter the latest vote in (timestamp, id) order is the standing stance, so repeating a
 * stance changes nothing and a reporter who changes their mind is counted once. Web visitors are folded into one voice:
 * it supports when more of them support than deny, denies when more deny, and is silent on a tie.
 */
export function tallyEntry(votes: readonly VoteInput[]): EntryTally {
  const ordered = [...votes].sort(compareVotes);
  const standing = new Map<string, VoteInput>();
  for (const vote of ordered) standing.set(vote.reporterId, vote);

  let support = 0;
  let deny = 0;
  let webSupport = 0;
  let webDeny = 0;
  let lastSupportAt = 0;
  let webLastSupportAt = 0;
  for (const vote of standing.values()) {
    const web = vote.reporterId.startsWith(WEB_REPORTER_PREFIX);
    if (vote.kind === "support") {
      if (web) {
        webSupport++;
        webLastSupportAt = Math.max(webLastSupportAt, vote.timestamp);
      } else {
        support++;
        lastSupportAt = Math.max(lastSupportAt, vote.timestamp);
      }
    } else if (web) {
      webDeny++;
    } else {
      deny++;
    }
  }
  if (webSupport > webDeny) {
    support++;
    lastSupportAt = Math.max(lastSupportAt, webLastSupportAt);
  } else if (webDeny > webSupport) {
    deny++;
  }

  return {
    support,
    deny,
    firstVoteAt: ordered[0]?.timestamp ?? 0,
    lastVoteAt: ordered.at(-1)?.timestamp ?? 0,
    lastSupportAt,
  };
}

export type EntryStatus = "proposed" | "confirmed" | "disputed" | "expired" | "removed";

export interface TallyRules {
  /** Distinct supporters needed, by class of sign. */
  confirmationsRequired: Record<SignClass, number>;
  /** At least this many objections, and as many as supporters, make an entry "disputed" - it is no longer delivered. */
  disputeMinDenials: number;
  /** An entry nobody confirmed lives this long after its last vote. */
  unconfirmedDays: number;
  /** An entry "until revoked" lives this long after its last supporting vote. */
  openEndedDays: number;
}

const DAY_MS = 86_400_000;

export interface DerivedState {
  status: Exclude<EntryStatus, "expired">;
  /** After this instant the entry is no longer delivered; null = never (a permanent sign nobody disputes). */
  expiresAt: number | null;
  confirmed: boolean;
}

/**
 * The state the votes give an entry. Whether it has *expired* is not part of it - that depends on the clock; `expiresAt` says
 * when, and the reader (or the worker) compares it with the time.
 */
export function deriveState(input: { tally: EntryTally; signClass: SignClass; validity: Validity; blocked: boolean; rules: TallyRules }): DerivedState {
  const { tally, signClass, validity, rules } = input;
  if (input.blocked) return { status: "removed", expiresAt: null, confirmed: false };

  const disputed = tally.deny >= rules.disputeMinDenials && tally.deny >= tally.support;
  const confirmed = !disputed && tally.support >= rules.confirmationsRequired[signClass];
  const status = disputed ? "disputed" : confirmed ? "confirmed" : "proposed";

  let expiresAt: number | null;
  if (!confirmed) {
    expiresAt = tally.lastVoteAt + rules.unconfirmedDays * DAY_MS;
  } else if (validity.period?.to) {
    // the end date is a local date: two days after its UTC midnight is past its end in every zone, the library reads the exact time
    expiresAt = Date.parse(`${validity.period.to}T00:00:00Z`) + 2 * DAY_MS;
  } else if (validity.period) {
    expiresAt = tally.lastSupportAt + rules.openEndedDays * DAY_MS;
  } else {
    expiresAt = null;
  }
  return { status, expiresAt, confirmed };
}
