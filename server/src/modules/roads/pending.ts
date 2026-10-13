import { sql } from "drizzle-orm";
import { lockSegmentKey } from "../../db/queries/speed-limit-corrections.js";
import { upsertGap } from "../../db/queries/speed-limit-gaps.js";
import { announceChanges, recomputeSegment } from "../speed-limit-corrections/service.js";
import { stretchOfInterval } from "../speed-limit-corrections/stretch.js";
import { RoadResolveError, resolveIntervalRef, type ResolveDeps } from "./resolve.js";
import type { Database } from "../../db/client.js";
import type { Env } from "../../config/env.js";

/**
 * Votes for an interval (a federated vote, signed by a device on another node) can reach a node before it knows the road they
 * name: they are kept under their reference. Once the roads of that area are here, this puts them onto the stretch: the
 * vote's key becomes the geometry key, the place is remembered, the tally is recomputed and what changed is announced.
 * Returns how many references were placed. A few per call.
 */
export async function settlePendingIntervals(deps: ResolveDeps & { db: Database["db"]; env: Env }, max = 5): Promise<number> {
  const { db, env } = deps;
  const refs = await db.execute<{ segment_key: string } & Record<string, unknown>>(sql`
    select distinct segment_key from speed_limit_correction_votes where segment_key like 'ivl:%' limit ${max}
  `);
  let placed = 0;
  for (const row of refs) {
    let stretch;
    try {
      stretch = stretchOfInterval(await resolveIntervalRef(deps, row.segment_key));
    } catch (error) {
      if (error instanceof RoadResolveError) continue;
      throw error;
    }
    await db.transaction(async (tx) => {
      await lockSegmentKey(tx, stretch.segmentKey);
      await lockSegmentKey(tx, row.segment_key);
      await upsertGap(tx, stretch);
      await tx.execute(sql`update speed_limit_correction_votes set segment_key = ${stretch.segmentKey} where segment_key = ${row.segment_key}`);
      const changes = await recomputeSegment(tx, env, stretch.segmentKey);
      await announceChanges(tx, changes, env.COMMUNITY_CORRECTIONS_ENABLED, env.STATIC_DATA_PARTITION_H3_RESOLUTION);
    });
    placed += 1;
  }
  return placed;
}
