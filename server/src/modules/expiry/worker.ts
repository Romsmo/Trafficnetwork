import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import type { appendEvent } from "../../db/append-event.js";
import type { SubscriptionRegistry } from "../realtime/registry.js";
import { publishEvent } from "../realtime/publisher.js";
import type { FastifyBaseLogger } from "fastify";
import { markReportExpired } from "./expire-report.js";

interface ExpiredRow extends Record<string, unknown> {
  id: string;
  type: string;
  region_tile: string;
  source: string;
  /** Country set of a camera report (null for every other type) - travels with the event, see db/queries/camera-record.ts. */
  countries: string[] | null;
  position_geojson: unknown;
}

/**
 * One sweep: finds every hazard_reports row whose expiresAt has passed while still
 * `active`, flips it to `expired`, and appends a ReportExpired event for each — all
 * in one transaction, per work order "phase1-server" (kept outside the repo) section 7 ("Hintergrund-Job
 * für Verfall/Expiry"). FOR UPDATE SKIP LOCKED is cheap insurance against a second
 * worker instance double-processing the same row; Phase 1 only ever runs one, but
 * this makes the query safe to run concurrently without extra coordination if that
 * ever changes.
 *
 * Returns the appended events (not just a count) so the caller can publish them to
 * WebSocket subscribers after the transaction commits.
 */
export async function runExpirySweep(db: Database["db"]) {
  return db.transaction(async (tx) => {
    const candidates = await tx.execute<ExpiredRow>(sql`
      select id, type, region_tile, source, countries, ST_AsGeoJSON(position)::json as position_geojson
      from hazard_reports
      where status = 'active' and expires_at < now()
      for update skip locked
    `);

    const events: Awaited<ReturnType<typeof appendEvent>>[] = [];
    for (const row of candidates) {
      events.push(
        await markReportExpired(tx, {
          id: row.id,
          type: row.type,
          regionTile: row.region_tile,
          source: row.source,
          countries: row.countries,
          position: row.position_geojson,
        }),
      );
    }

    return events;
  });
}

export interface ExpiryWorkerHandle {
  stop: () => void;
}

/** Starts periodic sweeping; call .stop() on server shutdown to clear the interval. */
export function startExpiryWorker(
  db: Database["db"],
  log: FastifyBaseLogger,
  realtime: SubscriptionRegistry,
  intervalMs = 60_000,
): ExpiryWorkerHandle {
  const timer = setInterval(() => {
    runExpirySweep(db)
      .then((events) => {
        if (events.length > 0) log.info({ count: events.length }, "expiry sweep transitioned reports to expired");
        for (const event of events) publishEvent(realtime, event);
      })
      .catch((err) => log.error(err, "expiry sweep failed"));
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
