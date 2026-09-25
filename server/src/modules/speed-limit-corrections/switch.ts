import { sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { bumpStaticDataVersion } from "../../db/queries/sync-state.js";
import { listAppliedKeys } from "../../db/queries/speed-limit-corrections.js";
import { announceChanges } from "./service.js";

/**
 * COMMUNITY_CORRECTIONS_ENABLED changes what every static read returns
 * (docs/speed-limit-corrections.md D11), but flipping an environment variable
 * writes nothing — so nothing would tell a client holding the old packages
 * that they are stale. The last-seen switch state therefore lives in
 * static_data_state; when this boot disagrees with it, bump the package
 * version and announce every segment that has an applied correction (as
 * corrected, or as back-to-imported), so delta clients and package clients
 * converge on the new state. No-op when the switch hasn't changed.
 *
 * Returns true if a flip was recorded.
 */
export async function syncCorrectionsOverlaySwitch(db: Database["db"], env: Env, log?: FastifyBaseLogger): Promise<boolean> {
  const rows = await db.execute<{ enabled: boolean } & Record<string, unknown>>(sql`
    select corrections_overlay_enabled as enabled from static_data_state where id = 1
  `);
  const stored = rows[0]?.enabled;
  if (stored === undefined || stored === env.COMMUNITY_CORRECTIONS_ENABLED) return false;

  await db.transaction(async (tx) => {
    await tx.execute(sql`update static_data_state set corrections_overlay_enabled = ${env.COMMUNITY_CORRECTIONS_ENABLED} where id = 1`);
    const applied = await listAppliedKeys(tx);
    await announceChanges(tx, applied, env.COMMUNITY_CORRECTIONS_ENABLED, env.STATIC_DATA_PARTITION_H3_RESOLUTION);
    await bumpStaticDataVersion(tx);
  });
  log?.info(
    { enabled: env.COMMUNITY_CORRECTIONS_ENABLED },
    "community speed-limit corrections switch changed since the last boot — static-data version bumped",
  );
  return true;
}
