import type { Queryable } from "../../db/client.js";
import { getDeltaCandidates, type DeltaPage } from "../../db/queries/event-log.js";
import { projectDeltaEvents } from "../cameras/policy/events.js";
import type { EffectiveCameraPolicy } from "../cameras/policy/policy.js";

/**
 * One page of `GET /v1/delta`: the candidate events of the range, with the camera policy applied by the delivery layer
 * (modules/cameras/policy/events.ts). Camera events the client may not see are dropped *and the cursor moves over them*,
 * so a page that held nothing deliverable still advances instead of being asked for again forever.
 */
export async function getDelta(
  db: Queryable,
  policy: EffectiveCameraPolicy,
  since: number,
  opts: { tiles: string[]; types: string[]; limit: number },
): Promise<DeltaPage> {
  const candidates = await getDeltaCandidates(db, since, opts);
  const events = await projectDeltaEvents(db, policy, candidates.rows, { tiles: opts.tiles, types: opts.types });
  const lastDelivered = events.at(-1)?.sequence ?? null;
  return {
    events,
    nextSince: candidates.hasMore ? candidates.scannedThrough : lastDelivered,
    hasMore: candidates.hasMore,
  };
}
