import type { Database } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { computeFederationEventId } from "../federation/device-event.js";
import { DescriptorError, describeDescriptor, ENTRY_KEY_PATTERN, type ValidatedDescriptor } from "./descriptor.js";
import { applyVote } from "./service.js";
import { deviceReporterId, verifyContextSignVoteEnvelope, type ContextSignVoteEnvelope } from "./vote.js";

/**
 * `invalid_signature` is singled out because it is the one rejection that is evidence about *whoever relayed it*
 * (modules/federation/reputation.ts) - the others are just bad input.
 */
export type ContextVoteRejectionCode = "invalid_signature" | "future_timestamp" | "implausible";

export type ContextVoteIngestOutcome =
  | { status: "recorded"; voteId: string }
  | { status: "duplicate"; voteId: string }
  | { status: "rejected"; voteId: string; reason: string; code: ContextVoteRejectionCode };

const FUTURE_SKEW_ALLOWANCE_MS = 5 * 60_000;

/**
 * Federated ingestion of a device-signed vote on a context sign (docs/context-signs.md D9): what a peer pushes to us or what
 * the pull worker fetches. The same rules as a locally sent vote minus everything about *this node's own API* (budgets, bans,
 * freshness window, bound-key check, "is it on a road we know") - the origin node did those. The descriptor is taken as signed:
 * it is validated against the catalogue and the plausibility limits, never re-resolved against this node's road network, so
 * every node that holds the same votes derives the same entry. No maximum age: votes are durable state.
 */
export async function ingestContextSignVote(db: Database["db"], env: Env, envelope: ContextSignVoteEnvelope, originNodeId: string | null): Promise<ContextVoteIngestOutcome> {
  const voteId = computeFederationEventId(envelope);
  const p = envelope.payload;

  if (!verifyContextSignVoteEnvelope(envelope)) {
    return { status: "rejected", voteId, reason: "Signature does not verify against the envelope's own claimed devicePublicKey", code: "invalid_signature" };
  }
  const timestamp = Date.parse(p.timestamp);
  if (Number.isNaN(timestamp) || timestamp > Date.now() + FUTURE_SKEW_ALLOWANCE_MS) {
    return { status: "rejected", voteId, reason: "Vote timestamp is invalid or too far in the future", code: "future_timestamp" };
  }
  if (!ENTRY_KEY_PATTERN.test(p.entryKey)) return { status: "rejected", voteId, reason: "Not a valid entry key", code: "implausible" };

  let validated: ValidatedDescriptor | null = null;
  if (p.vote === "support" || p.entry !== undefined) {
    try {
      if (p.entry === undefined) return { status: "rejected", voteId, reason: "A supporting vote must carry the descriptor", code: "implausible" };
      validated = describeDescriptor(p.entry, { timezonePrefixes: env.CONTEXT_SIGNS_TIMEZONE_PREFIXES });
    } catch (err) {
      if (err instanceof DescriptorError) return { status: "rejected", voteId, reason: err.message, code: "implausible" };
      throw err;
    }
    if (validated.entryKey !== p.entryKey) return { status: "rejected", voteId, reason: "The descriptor does not match the entry key", code: "implausible" };
  }

  const result = await applyVote(
    db,
    env,
    {
      id: voteId,
      kind: p.vote,
      // a deny that carries the descriptor is stored as a deny; the entry row only ever comes from a support
      validated: p.vote === "support" ? validated : null,
      entryKey: p.entryKey,
      reporterId: deviceReporterId(p.devicePublicKey),
      submittedBy: null,
      voteTimestamp: new Date(timestamp),
      envelope,
      originNodeId,
    },
    { local: false },
  );
  return result.recorded ? { status: "recorded", voteId } : { status: "duplicate", voteId };
}
