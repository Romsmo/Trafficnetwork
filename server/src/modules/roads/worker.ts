import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { attachAll, attachStep, countPending } from "./attach.js";

/** One run of the worker goes on this long while rows are still waiting. */
const PASS_BUDGET_MS = 60_000;
import { settlePendingIntervals } from "./pending.js";

export interface RoadWorkerHandle {
  stop: () => void;
}

/**
 * The background step of the road network (docs/road-network.md): every ROAD_ATTACH_INTERVAL_SECONDS it asks the lookup service
 * for a few areas that hold items waiting to be attached (be polite: ROAD_ATTACH_TILES_PER_RUN), attaches what it can, and gives
 * federated interval votes that arrived before their road was known their place. Does nothing when nothing waits.
 */
export function startRoadWorker(db: Database["db"], env: Env, log: FastifyBaseLogger): RoadWorkerHandle {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      if ((await countPending(db)) > 0 || env.ROAD_ATTACH_TILES_PER_RUN > 0) {
        const deps = { db, env, warn: (m: string, d?: unknown) => log.warn({ detail: d }, m) };
        const report = await attachStep(deps);
        if (report.signs.looked + report.cameras.looked + report.stretchesHidden > 0) log.info(report, "road attach step");
        // After a large import thousands of rows are pending: go on within a budget instead of one slice per interval.
        const deadline = Date.now() + PASS_BUDGET_MS;
        while (Date.now() < deadline && (await countPending(db)) > 0) {
          const more = await attachAll(db, env);
          if (more.signs.looked + more.cameras.looked === 0) break;
        }
      }
      const settled = await settlePendingIntervals({ db, env, warn: (m, d) => log.warn({ detail: d }, m) });
      if (settled > 0) log.info({ settled }, "interval votes placed on their roads");
    } catch (error) {
      log.error({ err: error }, "road attach step failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), env.ROAD_ATTACH_INTERVAL_SECONDS * 1000);
  timer.unref();
  // first look shortly after start, not in the middle of the boot
  const first = setTimeout(() => void run(), 15_000);
  first.unref();
  return {
    stop: () => {
      clearInterval(timer);
      clearTimeout(first);
    },
  };
}
