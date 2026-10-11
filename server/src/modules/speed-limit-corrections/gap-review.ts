import type { Queryable } from "../../db/client.js";
import { findImportedRoadsNear, flagGapNeedsReview, listUnflaggedLiveGaps } from "../../db/queries/speed-limit-gaps.js";
import { GAP_AXES } from "./gap.js";

/** An imported road this close to a community segment, running the same way, is "the import now has its own value here". */
const REVIEW_RADIUS_M = 20;
const REVIEW_MAX_ANGLE_DEGREES = 25;

/**
 * After an import batch: a community segment (a road the import had no limit for, docs D13) next to which the import now
 * has a road of its own is marked "needs review". Never overwritten, never removed — the community's number stays, and
 * what it shows next to it is that somebody should look. Cheap when there are no such segments (one empty query).
 */
export async function flagGapsNeedingReview(tx: Queryable): Promise<number> {
  let flagged = 0;
  for (const gap of await listUnflaggedLiveGaps(tx)) {
    const axisDegrees = gap.axis * (180 / GAP_AXES);
    const roads = await findImportedRoadsNear(tx, gap.lat, gap.lng, REVIEW_RADIUS_M);
    const sameRoad = roads.some((road) => {
      const diff = Math.abs(road.axisDegrees - axisDegrees) % 180;
      return Math.min(diff, 180 - diff) <= REVIEW_MAX_ANGLE_DEGREES;
    });
    if (sameRoad) {
      await flagGapNeedsReview(tx, gap.segmentKey);
      flagged++;
    }
  }
  return flagged;
}
