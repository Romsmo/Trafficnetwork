import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { hazardReports } from "../../db/schema/index.js";
import { appendEvent } from "../../db/append-event.js";
import type { FastifyBaseLogger } from "fastify";

interface ExpiredRow extends Record<string, unknown> {
  id: string;
  type: string;
  region_tile: string;
  source: string;
}

/**
 * One sweep: finds every hazard_reports row whose expiresAt has passed while still
 * `active`, flips it to `expired`, and appends a ReportExpired event for each — all
 * in one transaction, per docs/prompt-phase1-server.md section 7 ("Hintergrund-Job
 * für Verfall/Expiry"). FOR UPDATE SKIP LOCKED is cheap insurance against a second
 * worker instance double-processing the same row; Phase 1 only ever runs one, but
 * this makes the query safe to run concurrently without extra coordination if that
 * ever changes.
 *
 * Returns the number of reports transitioned, mainly so tests/logs can assert
 * something happened without polling the database directly.
 */
export async function runExpirySweep(db: Database["db"]): Promise<number> {
  return db.transaction(async (tx) => {
    const candidates = await tx.execute<ExpiredRow>(sql`
      select id, type, region_tile, source
      from hazard_reports
      where status = 'active' and expires_at < now()
      for update skip locked
    `);

    for (const row of candidates) {
      await tx
        .update(hazardReports)
        .set({ status: "expired", updatedAt: sql`now()` })
        .where(sql`id = ${row.id}`);

      await appendEvent(tx, {
        type: "ReportExpired",
        entityType: "hazardReport",
        entityId: row.id,
        payload: { id: row.id, type: row.type, status: "expired" },
        regionTile: row.region_tile,
        source: row.source,
      });
    }

    return candidates.length;
  });
}

export interface ExpiryWorkerHandle {
  stop: () => void;
}

/** Starts periodic sweeping; call .stop() on server shutdown to clear the interval. */
export function startExpiryWorker(
  db: Database["db"],
  log: FastifyBaseLogger,
  intervalMs = 60_000,
): ExpiryWorkerHandle {
  const timer = setInterval(() => {
    runExpirySweep(db)
      .then((count) => {
        if (count > 0) log.info({ count }, "expiry sweep transitioned reports to expired");
      })
      .catch((err) => log.error(err, "expiry sweep failed"));
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
