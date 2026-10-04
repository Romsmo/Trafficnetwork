import type { Queryable } from "../../db/client.js";
import { getFederationEventCandidatesSince, type FederationEventPage } from "../../db/queries/event-log.js";
import { mayLeaveNode } from "../cameras/policy/events.js";
import type { EffectiveCameraPolicy } from "../cameras/policy/policy.js";

/**
 * One page of `GET /v1/federation/events` (the anti-entropy pull, unauthenticated by design: the events are signed).
 *
 * The device-signed report in the envelope carries its exact coordinates, so a camera report may leave this node only
 * where the individual camera may be delivered (level `full` of every country it is in) - before the country policy this
 * endpoint returned every camera report whatever the camera flag said. The cursor moves over withheld events, so a peer is
 * never stuck on a page it is not allowed to read.
 */
export async function getFederationEventPage(
  db: Queryable,
  policy: EffectiveCameraPolicy,
  after: number,
  limit: number,
): Promise<FederationEventPage> {
  const candidates = await getFederationEventCandidatesSince(db, after, limit);
  const events = candidates
    .filter((candidate) => mayLeaveNode(policy, candidate))
    .map(({ sequence, federationEventId, envelope, occurredAt }) => ({ sequence, federationEventId, envelope, occurredAt }));
  return { events, nextAfter: candidates.at(-1)?.sequence ?? null };
}
