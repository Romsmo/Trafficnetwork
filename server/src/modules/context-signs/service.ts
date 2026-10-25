import { latLngToCell } from "h3-js";
import type { Database, Queryable, Transaction } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import {
  bumpVersion,
  clearBlocked,
  countProposalsBySubmitterSince,
  countUnconfirmedNear,
  countVotesBySubmitterSince,
  deleteBan,
  entryKeysVotedBy,
  expireDueEntries,
  findBan,
  findEntry,
  insertBan,
  insertEntryIfMissing,
  insertVote,
  listEntriesWithOtherResolution,
  listStandingVotes,
  lockEntryKey,
  setBlocked,
  setTiles,
  writeDerived,
  type EntryRow,
} from "../../db/queries/context-signs.js";
import { forbidden, tooManyRequests, unprocessable } from "../../lib/errors.js";
import type { ContextSignDescriptor, ValidatedDescriptor } from "./descriptor.js";
import { deriveState, tallyEntry, type TallyRules } from "./tally.js";

/**
 * Applying votes and re-deriving entries (docs/context-signs.md D4-D6). Votes are the source of truth; the entry row is a
 * materialised view, recomputed from the whole vote set on every vote - never from the previous row - so it cannot depend on
 * the order in which votes arrived.
 */

export function tallyRules(env: Env): TallyRules {
  return {
    confirmationsRequired: { prohibition: env.CONTEXT_SIGNS_CONFIRMATIONS_PROHIBITION, hazard: env.CONTEXT_SIGNS_CONFIRMATIONS_HAZARD },
    disputeMinDenials: env.CONTEXT_SIGNS_DISPUTE_MIN_DENIALS,
    unconfirmedDays: env.CONTEXT_SIGNS_UNCONFIRMED_DAYS,
    openEndedDays: env.CONTEXT_SIGNS_OPEN_ENDED_DAYS,
  };
}

/** The H3 tiles a shape touches - the vertex rule of the static-data packages, so clients tile entries the way they tile everything else. */
export function tilesOf(geometry: readonly [number, number][], resolution: number): string[] {
  const tiles = new Set<string>();
  for (const [lng, lat] of geometry) tiles.add(latLngToCell(lat, lng, resolution));
  return [...tiles].sort();
}

/** Is the entry something clients get? (The version counter moves when this, or "confirmed", changes.) */
function delivered(row: Pick<EntryRow, "status" | "expiresAt">, now: number): boolean {
  return (row.status === "proposed" || row.status === "confirmed") && (row.expiresAt === null || Date.parse(row.expiresAt) > now);
}

/** Re-derives one entry from its votes. Returns the row afterwards and whether what clients receive changed. */
export async function recomputeEntry(tx: Transaction, env: Env, entryKey: string): Promise<{ entry: EntryRow | null; changed: boolean }> {
  await lockEntryKey(tx, entryKey);
  const before = await findEntry(tx, entryKey);
  if (!before) return { entry: null, changed: false };
  const now = Date.now();

  const tally = tallyEntry(await listStandingVotes(tx, entryKey));
  const state = deriveState({
    tally,
    signClass: before.signClass,
    validity: before.descriptor.validity,
    blocked: before.blockedAt !== null,
    rules: tallyRules(env),
  });
  const confirmedAt = state.confirmed ? (before.confirmedAt ? new Date(before.confirmedAt) : new Date(now)) : null;
  await writeDerived(tx, entryKey, {
    status: state.status,
    supportCount: tally.support,
    denyCount: tally.deny,
    lastVoteAt: new Date(tally.lastVoteAt || Date.parse(before.lastVoteAt)),
    confirmedAt,
    lastConfirmedAt: state.confirmed && tally.lastSupportAt > 0 ? new Date(tally.lastSupportAt) : null,
    expiresAt: state.expiresAt === null ? null : new Date(state.expiresAt),
  });
  const after = (await findEntry(tx, entryKey))!;
  const changed = delivered(before, now) !== delivered(after, now) || (before.status === "confirmed") !== (after.status === "confirmed");
  if (changed) await bumpVersion(tx);
  return { entry: after, changed };
}

export interface ApplyVoteInput {
  /** Cross-server vote id for a signed vote, `local:<uuid>` for an unsigned one. */
  id: string;
  kind: "support" | "deny";
  validated: ValidatedDescriptor | null;
  /** Needed when no descriptor came with the vote (a deny): the key it names. */
  entryKey: string;
  reporterId: string;
  submittedBy: string | null;
  voteTimestamp: Date;
  envelope: unknown;
  originNodeId: string | null;
}

export interface ApplyVoteResult {
  recorded: boolean;
  noop?: "duplicate" | "already_holds_stance";
  entry: EntryRow | null;
  created: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Stores one vote and re-derives its entry. `local` is a vote sent to this node's own API: it enforces the ban, the per-client
 * budgets and the cap of unconfirmed entries per area. A replicated vote skips them - the origin node did those, and the vote
 * is durable state every node must converge on.
 */
export async function applyVote(db: Database["db"], env: Env, input: ApplyVoteInput, options: { local: boolean }): Promise<ApplyVoteResult> {
  if (options.local) {
    const ban = await findBan(db, input.reporterId);
    if (ban) throw forbidden("This device is blocked from voting on context signs on this node");
    if (input.submittedBy) {
      const since = new Date(Date.now() - DAY_MS);
      if ((await countVotesBySubmitterSince(db, input.submittedBy, since)) >= env.CONTEXT_SIGNS_VOTES_PER_DAY) {
        throw tooManyRequests(`Daily limit of ${env.CONTEXT_SIGNS_VOTES_PER_DAY} votes on context signs reached`);
      }
    }
  }

  return db.transaction(async (tx) => {
    await lockEntryKey(tx, input.entryKey);
    let existing = await findEntry(tx, input.entryKey);
    let created = false;

    if (input.kind === "support") {
      if (!input.validated) throw unprocessable("INVALID_DESCRIPTOR", "A supporting vote needs the descriptor of the sign");
      if (!existing) {
        if (options.local && input.submittedBy) {
          const since = new Date(Date.now() - DAY_MS);
          if ((await countProposalsBySubmitterSince(tx, input.submittedBy, since)) >= env.CONTEXT_SIGNS_PROPOSALS_PER_DAY) {
            throw tooManyRequests(`Daily limit of ${env.CONTEXT_SIGNS_PROPOSALS_PER_DAY} new context signs reached`);
          }
        }
        const first = input.validated.descriptor.geometry[0]!;
        if (options.local && (await countUnconfirmedNear(tx, first[0], first[1])) >= env.CONTEXT_SIGNS_MAX_UNCONFIRMED_PER_CELL) {
          throw tooManyRequests("There are too many context signs waiting for confirmation in this area - confirm or remove some first");
        }
        const resolution = env.STATIC_DATA_PARTITION_H3_RESOLUTION;
        created = await insertEntryIfMissing(tx, {
          entryKey: input.entryKey,
          descriptor: input.validated.descriptor,
          signClass: input.validated.signClass,
          lengthM: input.validated.lengthM,
          tiles: tilesOf(input.validated.descriptor.geometry, resolution),
          tileResolution: resolution,
          firstProposedAt: input.voteTimestamp,
          createdBy: options.local ? input.submittedBy : null,
        });
        existing = await findEntry(tx, input.entryKey);
      }
    }

    if (options.local && existing) {
      // the same stance again changes nothing: say so instead of spending the budget on it
      const own = (await listStandingVotes(tx, input.entryKey)).filter((v) => v.reporterId === input.reporterId).sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
      if (own.at(-1)?.kind === input.kind) return { recorded: false, noop: "already_holds_stance" as const, entry: existing, created: false };
    }

    const inserted = await insertVote(tx, {
      id: input.id,
      entryKey: input.entryKey,
      reporterId: input.reporterId,
      submittedBy: input.submittedBy,
      kind: input.kind,
      voteTimestamp: input.voteTimestamp,
      envelope: input.envelope,
      originNodeId: input.originNodeId,
    });
    if (!inserted) return { recorded: false, noop: "duplicate" as const, entry: existing, created: false };

    const { entry, changed } = await recomputeEntry(tx, env, input.entryKey);
    if (created && !changed) await bumpVersion(tx); // a new entry that nobody can see yet still counts for clients that list proposals
    return { recorded: true, entry, created };
  });
}

// ---------------------------------------------------------------- operator

export async function removeEntry(db: Database["db"], env: Env, entryKey: string, reason: string | null): Promise<EntryRow | null> {
  return db.transaction(async (tx) => {
    await lockEntryKey(tx, entryKey);
    if (!(await findEntry(tx, entryKey))) return null;
    await setBlocked(tx, entryKey, reason);
    return (await recomputeEntry(tx, env, entryKey)).entry;
  });
}

export async function restoreEntry(db: Database["db"], env: Env, entryKey: string): Promise<EntryRow | null> {
  return db.transaction(async (tx) => {
    await lockEntryKey(tx, entryKey);
    if (!(await findEntry(tx, entryKey))) return null;
    await clearBlocked(tx, entryKey);
    return (await recomputeEntry(tx, env, entryKey)).entry;
  });
}

async function recomputeAllVotedBy(db: Database["db"], env: Env, reporterId: string): Promise<number> {
  return db.transaction(async (tx) => {
    let n = 0;
    for (const key of await entryKeysVotedBy(tx, reporterId)) {
      await recomputeEntry(tx, env, key);
      n++;
    }
    return n;
  });
}

export async function banReporter(db: Database["db"], env: Env, reporterId: string, reason: string | null): Promise<{ newlyBanned: boolean; recomputed: number }> {
  const newlyBanned = await db.transaction((tx) => insertBan(tx, reporterId, reason));
  return { newlyBanned, recomputed: await recomputeAllVotedBy(db, env, reporterId) };
}

export async function unbanReporter(db: Database["db"], env: Env, reporterId: string): Promise<{ wasBanned: boolean; recomputed: number }> {
  const wasBanned = await db.transaction((tx) => deleteBan(tx, reporterId));
  return { wasBanned, recomputed: await recomputeAllVotedBy(db, env, reporterId) };
}

// ---------------------------------------------------------------- housekeeping

/** The periodic job: entries past their end stop being delivered. Returns how many. */
export async function expireEntries(db: Database["db"]): Promise<number> {
  return db.transaction(async (tx) => {
    const n = await expireDueEntries(tx);
    if (n > 0) await bumpVersion(tx);
    return n;
  });
}

/** After an operator changed STATIC_DATA_PARTITION_H3_RESOLUTION: the stored tiles of every entry are brought in line with it. */
export async function retileEntries(db: Database["db"], env: Env): Promise<number> {
  const resolution = env.STATIC_DATA_PARTITION_H3_RESOLUTION;
  const stale = await listEntriesWithOtherResolution(db, resolution);
  if (stale.length === 0) return 0;
  await db.transaction(async (tx: Queryable) => {
    for (const row of stale) await setTiles(tx, row.entryKey, tilesOf(row.descriptor.geometry as ContextSignDescriptor["geometry"], resolution), resolution);
    await bumpVersion(tx);
  });
  return stale.length;
}
