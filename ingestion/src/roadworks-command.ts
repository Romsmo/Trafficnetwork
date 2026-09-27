import { ApiClient } from "./api/client.js";
import type { Env } from "./config/env.js";
import type { Logger } from "./logging.js";
import { defaultAdapters } from "./pipeline/roadworks/adapters.js";
import { loadFeeds, resolveEnabledFeeds } from "./pipeline/roadworks/feeds.js";
import { runRoadworks, type FeedReport } from "./pipeline/roadworks/run-roadworks.js";

/**
 * `npm run ingest -- --roadworks [--feed id[,id…]] [--dry-run]`: ONE poll pass over the enabled roadworks feeds, then exit.
 * Schedule it with cron / a systemd timer / the Windows task scheduler (docs/roadworks.md); each feed's `minIntervalMinutes`
 * makes an over-eager schedule harmless.
 */
export async function runRoadworksCommand(env: Env, logger: Logger, options: { dryRun: boolean; onlyFeeds?: string[] }): Promise<FeedReport[]> {
  if (!env.ROADWORKS_ENABLED) {
    logger.warn("ROADWORKS_ENABLED=false — the roadworks kill switch is on, nothing to do");
    return [];
  }
  const all = loadFeeds(env.ROADWORKS_FEEDS_CONFIG_PATH);
  const feeds = resolveEnabledFeeds(all, { roadworksEnabled: env.ROADWORKS_ENABLED, feedsOn: env.ROADWORKS_FEEDS_ON, feedsOff: env.ROADWORKS_FEEDS_OFF, env: process.env }, options.onlyFeeds);
  if (feeds.length === 0) {
    logger.warn({ known: all.map((f) => ({ id: f.id, enabledInConfig: f.enabled })) }, "no roadworks feed is enabled (see ROADWORKS_FEEDS_ON and config/roadworks-feeds.json)");
    return [];
  }

  const apiClient = new ApiClient(env, logger);
  if (!options.dryRun) {
    logger.info({ serverUrl: env.SERVER_URL }, "authenticating against server");
    await apiClient.authenticate();
  }

  const http = { timeoutMs: 300_000, backoff: { baseMs: env.HTTP_BACKOFF_BASE_MS, maxMs: env.HTTP_BACKOFF_MAX_MS, maxRetries: env.HTTP_MAX_RETRIES } };
  const reports = await runRoadworks({
    feeds,
    adapters: defaultAdapters(http, logger),
    apiClient,
    stateDir: env.STATE_DIR,
    logger,
    dryRun: options.dryRun,
    lookaheadMinutes: env.ROADWORKS_LOOKAHEAD_MINUTES,
    mergeRadiusMeters: env.ROADWORKS_MERGE_RADIUS_METERS,
    batchSize: Math.min(env.BATCH_SIZE, 2000),
  });

  for (const r of reports) {
    logger.info(
      { feed: r.feedId, status: r.status, fetched: r.fetched, sent: r.sent, server: r.server, retired: r.retired, mergedIntoOtherFeed: r.mergedIntoOtherFeed, notImported: r.notImported, sentWithCaveat: r.sentWithCaveat, retireSkippedBecause: r.retireSkippedBecause, error: r.error },
      "roadworks quality report",
    );
  }
  return reports;
}
