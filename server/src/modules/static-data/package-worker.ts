import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { countDirtyTiles, getPackageState } from "../../db/queries/static-packages.js";
import { packageFingerprint, runBuild } from "./package-builder.js";
import { getPackageService } from "./package-service.js";

export interface PackageWorkerHandle {
  stop: () => void;
}

export type WorkerDecision = "idle" | "wait" | "build";

/**
 * Should a build start now? Pure, so the debounce rules are testable.
 *
 * A bulk import marks tiles dirty continuously for hours; rebuilding after every
 * batch would only redo the same tiles. So the worker waits until static data
 * has been quiet for `debounceSeconds` — but never longer than
 * `maxWaitSeconds` since the oldest still-unbuilt mark, so packages cannot be
 * starved by a steady trickle of writes. With nothing marked (a fresh start, or
 * a changed configuration) there is nothing to wait for.
 */
export function decideBuild(input: {
  needsInitialBuild: boolean;
  dirty: number;
  ageOfNewestMarkSeconds: number | null;
  ageOfOldestMarkSeconds: number | null;
  debounceSeconds: number;
  maxWaitSeconds: number;
}): WorkerDecision {
  if (input.dirty === 0) return input.needsInitialBuild ? "build" : "idle";
  if ((input.ageOfNewestMarkSeconds ?? Infinity) >= input.debounceSeconds) return "build";
  if ((input.ageOfOldestMarkSeconds ?? 0) >= input.maxWaitSeconds) return "build";
  return "wait";
}

/**
 * Background package builder (add-on E-B) — plain setInterval like the expiry
 * and retention workers: `.unref()`ed, every failure logged and swallowed, only
 * ever constructed when STATIC_PACKAGES_WORKER_ENABLED (see src/server.ts).
 * The builder lease (static_package_state) keeps this from colliding with a
 * `npm run static-packages -- build` run or a second server process.
 */
export function startStaticPackageWorker(db: Database["db"], env: Env, log: FastifyBaseLogger, intervalMs = 10_000): PackageWorkerHandle {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const state = await getPackageState(db);
      const dirty = await countDirtyTiles(db);
      const now = Date.now();
      const decision = decideBuild({
        needsInitialBuild: !state.ready || state.fingerprint !== packageFingerprint(env),
        dirty: dirty.dirty,
        ageOfNewestMarkSeconds: dirty.newestMarkedAt ? (now - new Date(dirty.newestMarkedAt).getTime()) / 1000 : null,
        ageOfOldestMarkSeconds: dirty.oldestMarkedAt ? (now - new Date(dirty.oldestMarkedAt).getTime()) / 1000 : null,
        debounceSeconds: env.STATIC_PACKAGES_DEBOUNCE_SECONDS,
        maxWaitSeconds: env.STATIC_PACKAGES_MAX_WAIT_SECONDS,
      });
      if (decision !== "build") return;
      const service = getPackageService(db, env, log);
      const result = await runBuild({ ...service.builderDeps, log }, {});
      if (result.status === "built" && result.tilesBuilt + result.tilesFailed > 0) {
        log.info(
          { tiles: result.tilesBuilt, failed: result.tilesFailed, empty: result.tilesEmpty, seconds: Math.round(result.seconds), ready: result.ready },
          "static packages: build finished",
        );
      }
    } catch (err) {
      log.error(err, "static packages: worker cycle failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  // Do not wait a whole interval after boot for the first look (an initial build may be pending).
  setTimeout(() => void tick(), 1000).unref();
  return { stop: () => clearInterval(timer) };
}
