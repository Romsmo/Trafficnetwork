import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SEED_REPORTS_MAX_ROWS, type SeedReportPoster, type SeedReportRow, type SeedReportsResponse } from "../../api/types.js";
import type { Logger } from "../../logging.js";
import type { FeedAdapter } from "./adapters.js";
import type { FeedConfig } from "./feeds.js";
import { mergeAcrossFeeds, selectActive, type FeedSelection } from "./select.js";
import type { ActiveRoadwork, ParseResult } from "./types.js";

/**
 * One poll pass over the enabled roadworks feeds — meant to be started periodically by cron / a systemd timer / the
 * Windows task scheduler (the tool does one pass and exits; when it runs and how often is the operator's scheduler's business,
 * bounded below by each feed's `minIntervalMinutes`).
 *
 * Per feed: read the whole feed → decide what is active now → merge duplicates across feeds → upsert to the server → and ONLY if
 * the feed was read completely and everything was sent, retire what this run did not see. A failure of one feed never
 * affects another, and a feed that could not be read completely never ends anything on the server.
 */

export interface RoadworksRunOptions {
  feeds: FeedConfig[];
  adapters: Record<FeedConfig["kind"], FeedAdapter>;
  apiClient: SeedReportPoster;
  stateDir: string;
  logger: Logger;
  dryRun: boolean;
  lookaheadMinutes: number;
  mergeRadiusMeters: number;
  batchSize: number;
  /** For tests. */
  now?: () => Date;
}

export interface FeedReport {
  feedId: string;
  status: "ok" | "dry-run" | "skipped-too-soon" | "failed" | "incomplete";
  startedAt: string;
  finishedAt: string;
  error?: string;
  /** Records/entries in the document. */
  fetched: number;
  /** Reasons a record did not become a candidate or was not active now, with counts. */
  notImported: Record<string, number>;
  /** Left out because a higher-priority feed already describes the same roadwork. */
  mergedIntoOtherFeed: number;
  /** Sent, but with a timing detail the reader could not evaluate (counted, never hidden). */
  sentWithCaveat: Record<string, number>;
  sent: number;
  server?: SeedReportsResponse;
  retired?: number;
  retireSkippedBecause?: string;
  publishedAt?: string;
}

function bump(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

async function readLastSuccess(stateDir: string, feedId: string): Promise<Date | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(stateDir, "roadworks", `${feedId}.json`), "utf8")) as { lastSuccessAt?: string };
    return parsed.lastSuccessAt ? new Date(parsed.lastSuccessAt) : undefined;
  } catch {
    return undefined;
  }
}

async function writeState(stateDir: string, feedId: string, report: FeedReport, markSuccess: boolean, previous: Date | undefined): Promise<void> {
  const dir = path.join(stateDir, "roadworks");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${feedId}.json`), JSON.stringify({ lastSuccessAt: markSuccess ? report.finishedAt : previous?.toISOString() }, null, 2));
  await fs.writeFile(path.join(dir, `${feedId}.report.json`), JSON.stringify(report, null, 2));
}

function toRow(roadwork: ActiveRoadwork, feed: FeedConfig): SeedReportRow | { invalid: string } {
  if (roadwork.externalId.length === 0 || roadwork.externalId.length > 200) return { invalid: "external id empty or longer than 200 characters" };
  return {
    externalId: roadwork.externalId,
    type: "construction",
    lat: roadwork.lat,
    lng: roadwork.lng,
    ...(roadwork.endsAt ? { endsAt: roadwork.endsAt.toISOString() } : feed.ttlHours ? { ttlHours: feed.ttlHours } : {}),
  };
}

export async function runRoadworks(options: RoadworksRunOptions): Promise<FeedReport[]> {
  const { feeds, adapters, apiClient, stateDir, logger, dryRun } = options;
  const now = options.now ?? (() => new Date());
  const lookaheadMs = options.lookaheadMinutes * 60_000;
  const batchSize = Math.min(options.batchSize, SEED_REPORTS_MAX_ROWS);

  const reports = new Map<string, FeedReport>();
  const parsed = new Map<string, { result: ParseResult; notImported: Record<string, number>; previous: Date | undefined; startedAt: string }>();
  const selections: FeedSelection[] = [];

  // --- phase 1: read every feed and decide what is active (no server contact yet, so cross-feed merging sees everything) ---
  for (const feed of feeds) {
    const startedAt = now().toISOString();
    const previous = await readLastSuccess(stateDir, feed.id);
    if (previous && now().getTime() - previous.getTime() < feed.minIntervalMinutes * 60_000) {
      const report: FeedReport = { feedId: feed.id, status: "skipped-too-soon", startedAt, finishedAt: startedAt, fetched: 0, notImported: {}, mergedIntoOtherFeed: 0, sentWithCaveat: {}, sent: 0 };
      reports.set(feed.id, report);
      logger.info({ feed: feed.id, lastSuccessAt: previous.toISOString(), minIntervalMinutes: feed.minIntervalMinutes }, "roadworks feed polled too recently — skipped (minIntervalMinutes)");
      continue;
    }
    try {
      const result = await adapters[feed.kind](feed);
      const notImported: Record<string, number> = {};
      for (const skipped of result.skipped) bump(notImported, skipped.reason);
      const active: ActiveRoadwork[] = [];
      for (const candidate of result.candidates) {
        const selection = selectActive(candidate, now(), lookaheadMs);
        if ("active" in selection) active.push(selection.active);
        else bump(notImported, selection.skip);
      }
      parsed.set(feed.id, { result, notImported, previous, startedAt });
      selections.push({ feedId: feed.id, active });
      logger.info({ feed: feed.id, fetched: result.totalSeen, candidates: result.candidates.length, active: active.length, complete: result.complete }, "roadworks feed read");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ feed: feed.id, error: message }, "roadworks feed could not be read — nothing sent, nothing retired for it");
      reports.set(feed.id, { feedId: feed.id, status: "failed", startedAt, finishedAt: now().toISOString(), error: message, fetched: 0, notImported: {}, mergedIntoOtherFeed: 0, sentWithCaveat: {}, sent: 0 });
    }
  }

  // --- phase 2: the same roadwork in two feeds is created once ---
  const merged = mergeAcrossFeeds(selections, options.mergeRadiusMeters);

  // --- phase 3: send, then retire (only after a complete read and a fully successful send) ---
  for (const feed of feeds) {
    const read = parsed.get(feed.id);
    if (!read) continue;
    const { result, notImported, previous, startedAt } = read;
    const active = merged.kept.get(feed.id) ?? [];
    const report: FeedReport = {
      feedId: feed.id,
      status: dryRun ? "dry-run" : "ok",
      startedAt,
      finishedAt: startedAt,
      fetched: result.totalSeen,
      notImported,
      mergedIntoOtherFeed: merged.mergedAway.get(feed.id) ?? 0,
      sentWithCaveat: {},
      sent: 0,
      publishedAt: result.publishedAt?.toISOString(),
    };

    const rows: SeedReportRow[] = [];
    for (const roadwork of active) {
      const row = toRow(roadwork, feed);
      if ("invalid" in row) bump(report.notImported, row.invalid);
      else {
        rows.push(row);
        if (roadwork.caveat) bump(report.sentWithCaveat, roadwork.caveat);
      }
    }

    let incompleteReason = result.complete ? undefined : (result.incompleteReason ?? "the feed was not read completely");
    const maxAgeMs = (feed.maxFeedAgeHours ?? 24) * 3_600_000;
    if (!incompleteReason && result.publishedAt && now().getTime() - result.publishedAt.getTime() > maxAgeMs) {
      incompleteReason = `the feed's own publication time (${result.publishedAt.toISOString()}) is older than ${feed.maxFeedAgeHours ?? 24} h — it may have stopped updating`;
    }

    if (dryRun) {
      report.sent = rows.length;
      report.finishedAt = now().toISOString();
      reports.set(feed.id, report);
      logger.info({ feed: feed.id, wouldSend: rows.length }, "[dry-run] roadworks would be sent (nothing was sent)");
      await writeState(stateDir, feed.id, report, false, previous);
      continue;
    }

    try {
      const runId = randomUUID();
      const totals: SeedReportsResponse = { created: 0, reactivated: 0, updated: 0, refreshed: 0, skippedEnded: 0, duplicatesInRequest: 0 };
      for (let i = 0; i < rows.length; i += batchSize) {
        const response = await apiClient.postSeedReports({ feedId: feed.id, runId, sourceLicense: feed.sourceLicense, reports: rows.slice(i, i + batchSize) });
        for (const key of Object.keys(totals) as (keyof SeedReportsResponse)[]) totals[key] += response[key];
        report.sent += Math.min(batchSize, rows.length - i);
      }
      report.server = totals;

      if (incompleteReason) {
        report.status = "incomplete";
        report.retireSkippedBecause = incompleteReason;
        logger.warn({ feed: feed.id, reason: incompleteReason }, "roadworks sent, but nothing retired: the feed was not read completely");
      } else if (rows.length === 0) {
        report.retireSkippedBecause = "no roadwork is active in this feed right now (the server refuses to retire on an empty run; rows end by their own expiry)";
      } else {
        report.retired = (await apiClient.retireSeedReports(feed.id, runId)).retired;
      }
      report.finishedAt = now().toISOString();
      reports.set(feed.id, report);
      await writeState(stateDir, feed.id, report, report.status === "ok", previous);
      logger.info({ feed: feed.id, ...report }, "roadworks feed imported");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ feed: feed.id, error: message }, "sending roadworks to the server failed — nothing retired for this feed");
      reports.set(feed.id, { ...report, status: "failed", error: message, finishedAt: now().toISOString() });
    }
  }

  return feeds.map((f) => reports.get(f.id)).filter((r): r is FeedReport => r !== undefined);
}
