import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import type { FastifyBaseLogger } from "fastify";

const DYNAMIC_EVENT_TYPES = ["ReportCreated", "ReportConfirmed", "ReportDenied", "ReportExpired"] as const;
const STATIC_EVENT_TYPES = ["StaticDataUpdated", "StaticDataRemoved"] as const;

export interface RetentionCleanupResult {
  dynamicEventsDeleted: number;
  staticEventsDeleted: number;
  staleHazardReportsDeleted: number;
}

/**
 * Enforces EVENT_LOG_RETENTION_DAYS_DYNAMIC/_STATIC (docs/concept.md section 5.1)
 * — without this job those env vars only ever affected getDeltaPage's
 * SNAPSHOT_REQUIRED check (whether *anything* has actually been purged), never
 * anything actually purging. Also hard-deletes expired/removed hazard_reports
 * once they're older than the dynamic window — they're kept briefly after
 * expiry for moderation/dedup context (findDuplicateCandidate only looks at
 * status='active' rows so this doesn't affect matching), not forever.
 */
export async function runRetentionCleanup(db: Database["db"], env: Env): Promise<RetentionCleanupResult> {
  const dynamicCutoff = sql`now() - make_interval(days => ${env.EVENT_LOG_RETENTION_DAYS_DYNAMIC})`;
  const staticCutoff = sql`now() - make_interval(days => ${env.EVENT_LOG_RETENTION_DAYS_STATIC})`;

  const dynamicDeleted = await db.execute<{ id: number } & Record<string, unknown>>(sql`
    delete from event_log
    where type = any(${DYNAMIC_EVENT_TYPES}::event_type[]) and occurred_at < ${dynamicCutoff}
    returning sequence as id
  `);
  const staticDeleted = await db.execute<{ id: number } & Record<string, unknown>>(sql`
    delete from event_log
    where type = any(${STATIC_EVENT_TYPES}::event_type[]) and occurred_at < ${staticCutoff}
    returning sequence as id
  `);
  const staleReports = await db.execute<{ id: string } & Record<string, unknown>>(sql`
    delete from hazard_reports
    where status in ('expired', 'removed') and updated_at < ${dynamicCutoff}
    returning id
  `);

  return {
    dynamicEventsDeleted: dynamicDeleted.length,
    staticEventsDeleted: staticDeleted.length,
    staleHazardReportsDeleted: staleReports.length,
  };
}

export interface RetentionWorkerHandle {
  stop: () => void;
}

/** Runs far less often than the expiry sweep — retention is a housekeeping concern, not latency-sensitive. */
export function startRetentionWorker(
  db: Database["db"],
  env: Env,
  log: FastifyBaseLogger,
  intervalMs = 60 * 60_000,
): RetentionWorkerHandle {
  const timer = setInterval(() => {
    runRetentionCleanup(db, env)
      .then((result) => {
        const total = result.dynamicEventsDeleted + result.staticEventsDeleted + result.staleHazardReportsDeleted;
        if (total > 0) log.info(result, "retention cleanup purged old rows");
      })
      .catch((err) => log.error(err, "retention cleanup failed"));
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
