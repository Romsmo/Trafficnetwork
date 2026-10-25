import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { expireEntries, retileEntries } from "./service.js";

export interface ContextSignWorkerHandle {
  stop: () => void;
}

const INTERVAL_MS = 10 * 60_000;

/**
 * The housekeeping of context signs (docs/context-signs.md D5): every ten minutes the entries past their end are marked
 * expired - which moves the version clients compare - and, once at start, the stored tiles are brought in line with
 * STATIC_DATA_PARTITION_H3_RESOLUTION if an operator changed it. A node with no entries does nothing.
 */
export function startContextSignWorker(db: Database["db"], env: Env, log: FastifyBaseLogger): ContextSignWorkerHandle | null {
  if (!env.CONTEXT_SIGNS_ENABLED) return null;
  let running = false;
  const run = async (first: boolean) => {
    if (running) return;
    running = true;
    try {
      if (first) {
        const retiled = await retileEntries(db, env);
        if (retiled > 0) log.info({ retiled }, "context signs: tiles written again for the new partition resolution");
      }
      const expired = await expireEntries(db);
      if (expired > 0) log.info({ expired }, "context signs: entries past their end are no longer delivered");
    } catch (error) {
      log.error({ err: error }, "context signs housekeeping failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(false), INTERVAL_MS);
  timer.unref();
  const first = setTimeout(() => void run(true), 20_000);
  first.unref();
  return {
    stop: () => {
      clearInterval(timer);
      clearTimeout(first);
    },
  };
}
