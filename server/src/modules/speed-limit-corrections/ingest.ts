import type { Database } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import type { appendEvent } from "../../db/append-event.js";
import { ApiError } from "../../lib/errors.js";
import { computeFederationEventId } from "../federation/device-event.js";
import { validateCorrectionValue } from "./plausibility.js";
import { gapGeometry, parseGapRef } from "./gap.js";
import { stretchOfGap, stretchOfInterval, type CommunityStretch } from "./stretch.js";
import { parseIntervalRef } from "../roads/geo.js";
import { RoadResolveError, resolveIntervalRef } from "../roads/resolve.js";
import { applyVote } from "./service.js";
import { deviceReporterId, isNotInTheFuture, verifySpeedLimitVoteEnvelope, type SpeedLimitVoteEnvelope } from "./vote.js";

/**
 * `invalid_signature` is singled out because it is the one rejection that is
 * evidence about *whoever relayed it* (modules/federation/reputation.ts) — the
 * others are just bad input.
 */
export type VoteRejectionCode = "invalid_signature" | "future_timestamp" | "implausible";

export type VoteIngestOutcome =
  | { status: "recorded"; voteId: string; events: Awaited<ReturnType<typeof appendEvent>>[] }
  | { status: "duplicate"; voteId: string }
  | { status: "rejected"; voteId: string; reason: string; code: VoteRejectionCode };

/**
 * Federated ingestion of a device-signed vote (docs D9): what a peer pushes to
 * us or what the pull worker fetches. Same rules as a locally submitted vote
 * minus everything that is about *this server's own API* (rate limit, bans,
 * the freshness window, the bound-key check — the origin server did those).
 * Deliberately no maximum age: votes are durable state, and a server that
 * joins late or heals a long partition must converge on all of them.
 *
 * Votes for a segment this server doesn't have are stored anyway — the segment
 * may be imported later, and the pull cursor will not come back for the vote.
 */
export async function ingestSpeedLimitVote(
  db: Database["db"],
  env: Env,
  envelope: SpeedLimitVoteEnvelope,
  originNodeId: string | null,
): Promise<VoteIngestOutcome> {
  const voteId = computeFederationEventId(envelope);
  const p = envelope.payload;

  if (!verifySpeedLimitVoteEnvelope(envelope)) {
    return { status: "rejected", voteId, reason: "Signature does not verify against the envelope's own claimed devicePublicKey", code: "invalid_signature" };
  }
  if (!isNotInTheFuture(p.timestamp)) {
    return { status: "rejected", voteId, reason: "Vote timestamp is invalid or too far in the future", code: "future_timestamp" };
  }
  try {
    validateCorrectionValue(p.value, p.unit, env);
  } catch (err) {
    if (err instanceof ApiError) return { status: "rejected", voteId, reason: err.message, code: "implausible" };
    throw err;
  }

  // A place reference is resolved the same way on every node that has the data: a legacy place (docs D13) gives the same cell and
  // axis, the same geometry and key; an interval is resolved against this node's road network (docs/road-network.md).
  let segmentKey = p.segmentKey;
  let gap: CommunityStretch | undefined;
  if (p.segmentKey.startsWith("gap:")) {
    const place = parseGapRef(p.segmentKey);
    if (!place) return { status: "rejected", voteId, reason: "Not a valid place reference", code: "implausible" };
    gap = stretchOfGap(gapGeometry(place));
    segmentKey = gap.segmentKey;
  } else if (p.segmentKey.startsWith("ivl:")) {
    if (!parseIntervalRef(p.segmentKey)) return { status: "rejected", voteId, reason: "Not a valid interval reference", code: "implausible" };
    try {
      gap = stretchOfInterval(await resolveIntervalRef({ db, env }, p.segmentKey));
      segmentKey = gap.segmentKey;
    } catch (error) {
      // This node cannot (yet) say which road it is. The vote is kept under its reference, so that it is not lost: once the
      // roads of that area are here, settlePendingIntervals() moves it onto the stretch.
      if (!(error instanceof RoadResolveError)) throw error;
      segmentKey = p.segmentKey;
    }
  }

  const result = await applyVote(
    db,
    env,
    {
      id: voteId,
      segmentKey,
      ...(gap ? { gap } : {}),
      reporterId: deviceReporterId(p.devicePublicKey),
      submittedBy: null,
      kind: p.vote,
      value: p.value,
      unit: p.unit,
      reason: p.reason ?? null,
      voteTimestamp: new Date(p.timestamp),
      envelope,
      originNodeId,
    },
    { local: false },
  );
  return result.recorded ? { status: "recorded", voteId, events: result.events } : { status: "duplicate", voteId };
}
