import "dotenv/config";
import { ApiClient } from "./api/client.js";
import { loadEnv } from "./config/env.js";
import { loadRegions, resolveRegion } from "./config/regions.js";
import { resolveSources, SOURCE_IDS } from "./config/sources.js";
import { createLogger } from "./logging.js";
import { WORKER_REGISTRY } from "./pipeline/registry.js";
import { runWorker } from "./pipeline/run-worker.js";
import { StateStore } from "./state/store.js";

/**
 * Usage:
 *   npm run ingest -- --region bayern [--dry-run] [--fresh] [--batch-size N]
 *
 * --region      required; an id from config/regions.json (bayern, germany, europe)
 * --dry-run     validates config + server credentials, logs what would run, sends nothing
 * --fresh       wipes local progress state for this region+source first — WILL duplicate
 *               any rows already imported into the server (it has no dedup of its own);
 *               only use this to deliberately start a region completely over.
 * --batch-size  overrides BATCH_SIZE from .env for this run
 */
function parseArgs(argv: string[]): { region: string; dryRun: boolean; fresh: boolean; batchSizeOverride?: number } {
  let region: string | undefined;
  let dryRun = false;
  let fresh = false;
  let batchSizeOverride: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--region") {
      region = argv[++i];
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    } else if (argv[i] === "--fresh") {
      fresh = true;
    } else if (argv[i] === "--batch-size") {
      const value = argv[++i];
      const parsed = value ? Number(value) : NaN;
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--batch-size must be a positive integer");
      batchSizeOverride = parsed;
    }
  }

  if (!region) throw new Error("--region is required (see ingestion/config/regions.json for valid ids)");
  return { region, dryRun, fresh, batchSizeOverride };
}

async function main() {
  const { region: regionId, dryRun, fresh, batchSizeOverride } = parseArgs(process.argv.slice(2));

  const env = loadEnv();
  const logger = createLogger(env);
  const region = resolveRegion(loadRegions(), regionId);
  const sources = resolveSources(env);
  const batchSize = batchSizeOverride ?? env.BATCH_SIZE;

  const apiClient = new ApiClient(env, logger);
  logger.info({ serverUrl: env.SERVER_URL }, "authenticating against server");
  await apiClient.authenticate();
  logger.info("authentication ok");

  const enabledSources = SOURCE_IDS.filter((id) => sources[id].enabled);
  if (enabledSources.length === 0) {
    logger.warn("no sources enabled (check *_ENABLED in .env) — nothing to do");
    return;
  }

  if (dryRun) {
    logger.info({ region: region.name, enabledSources, batchSize }, "[dry-run] resolved configuration — no data will be sent");
    for (const id of enabledSources) {
      if (!WORKER_REGISTRY[id]) logger.info({ source: id }, "[dry-run] no worker implemented for this source yet");
    }
    return;
  }

  for (const id of enabledSources) {
    const worker = WORKER_REGISTRY[id];
    if (!worker) throw new Error(`Source "${id}" is enabled but has no implemented worker yet — see ingestion/docs/sources.md`);

    const stateStore = new StateStore(env.STATE_DIR, regionId, id);
    if (fresh) {
      logger.warn(
        { region: regionId, source: id },
        "--fresh: wiping local progress state — this WILL duplicate any rows this region/source already imported, since the server has no dedup of its own",
      );
      await stateStore.reset();
    }
    await runWorker({ worker, region, apiClient, stateStore, logger, batchSize, dryRun: false });
  }
}

main().catch((err) => {
  console.error("Ingestion run failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
