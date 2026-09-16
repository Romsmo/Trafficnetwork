import type { Queryable } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { validatePlausibility, type HazardReportInput } from "./plausibility.js";
import { checkRateLimit } from "./rate-limit.js";

/**
 * The two synchronous, pre-write checks from docs/concept.md section 5.4 that can
 * run before opening the write transaction (cheap, fail fast): plausibility needs
 * no DB access at all, and the rate limit is a single read query. Duplicate-merge
 * is the third check but runs *inside* the transaction instead (see
 * db/queries/hazard-reports.ts's findDuplicateCandidate, called from
 * modules/hazard-reports/service.ts) because it must lock the candidate row to
 * avoid a race between two concurrent submissions at the same spot.
 */
export async function runModerationGate(db: Queryable, reporterId: string, input: HazardReportInput, env: Env): Promise<void> {
  validatePlausibility(input, env);
  await checkRateLimit(db, reporterId, env);
}
