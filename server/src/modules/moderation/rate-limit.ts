import { sql } from "drizzle-orm";
import type { Queryable } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { tooManyRequests } from "../../lib/errors.js";

/**
 * Counts both new reports and confirmations by this reporter in the trailing
 * window — a DB-backed count query, not Redis, consistent with the single-instance
 * MVP scope (see the plan's moderation-gate section). Both write endpoints
 * (create and confirm) share the same budget: docs/concept.md section 5.4 calls
 * for a rate limit "pro Gerät/Reporter" without distinguishing submission kind.
 */
export async function checkRateLimit(db: Queryable, reporterId: string, env: Env): Promise<void> {
  const rows = await db.execute<{ total: number } & Record<string, unknown>>(sql`
    select
      (select count(*)::int from hazard_reports
        where reporter_id = ${reporterId}
          and reported_at > now() - make_interval(mins => ${env.REPORT_RATE_LIMIT_WINDOW_MINUTES}))
      +
      (select count(*)::int from hazard_confirmations
        where reporter_id = ${reporterId}
          and confirmed_at > now() - make_interval(mins => ${env.REPORT_RATE_LIMIT_WINDOW_MINUTES}))
      as total
  `);
  const total = rows[0]?.total ?? 0;
  if (total >= env.REPORT_RATE_LIMIT_MAX) {
    throw tooManyRequests(
      `Rate limit exceeded: max ${env.REPORT_RATE_LIMIT_MAX} submissions per ${env.REPORT_RATE_LIMIT_WINDOW_MINUTES} minutes`,
    );
  }
}
