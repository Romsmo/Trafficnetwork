import type { Queryable } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { appendEvent } from "../../db/append-event.js";
import {
  countSeedReportsOfRun,
  findSeedReportsForUpdate,
  insertSeedReportRow,
  retireUnseenSeedReports,
  touchSeedReports,
  updateSeedReportRow,
  type ExistingSeedRow,
} from "../../db/queries/hazard-reports.js";
import { positionToRegionTile } from "../../lib/h3.js";
import { conflict } from "../../lib/errors.js";

/**
 * Seed reports: authoritative, time-limited reports (today: roadworks from national access points)
 * that a periodic import keeps in step with its source — docs/concept.md section 3.2 already provides
 * the pieces (hazard type "construction", source "seed", the expiry band "Enddatum falls bekannt");
 * what was missing was a bulk way to write and refresh them.
 *
 * Lifecycle, driven entirely by the importer's runs:
 *  1. every run upserts what its feed currently lists (identity: feedId + externalId) and stamps the rows with its runId;
 *  2. a run that fetched the COMPLETE feed then retires every active row of that feed it did not stamp — the roadwork
 *     is no longer listed, so it is over. Retiring uses the same status/event the expiry worker uses (expired +
 *     ReportExpired), so clients need nothing new to handle it;
 *  3. if the importer stops for good, rows still age out by their own expiry (the source's end date, or the TTL below),
 *     which is the dead-man's switch.
 *
 * Events: a row that is new, re-activated, moved, or whose source-given end date changed emits one event
 * (ReportCreated / ReportConfirmed with the full current row — the same "state, not diff" payload every
 * hazard event carries). A plain re-sighting emits nothing, so an hourly import of thousands of unchanged
 * roadworks does not flood the event log or the WebSocket subscribers.
 *
 * Unlike POST /v1/hazard-reports these writes are not community submissions: no moderation gate, no per-device
 * rate limit, no confirm/deny bookkeeping — the caller is a `bulk-import`-scoped client, the same trust level as
 * the static-data bulk import. They are never federated (there is no device signature to replicate); like static
 * data, each node imports its own.
 */

/** A moved position below this distance is treated as the same place (source coordinate jitter must not cause events). */
const MOVED_METERS = 100;
/** A source-given end date that changed by less than this is treated as unchanged. */
const END_CHANGED_MS = 60_000;

export interface SeedReportInput {
  externalId: string;
  type: "construction";
  lat: number;
  lng: number;
  /** The source's end of the roadwork; when absent the report lives ttlHours (default: HAZARD_EXPIRY_CONSTRUCTION_DAYS) from this sighting. */
  endsAt?: string;
  ttlHours?: number;
}

export interface UpsertSeedReportsInput {
  feedId: string;
  runId: string;
  sourceLicense: string;
  reporterId: string;
  reports: SeedReportInput[];
}

export interface UpsertSeedReportsResult {
  created: number;
  reactivated: number;
  /** Position or source-given end date changed. */
  updated: number;
  /** Seen again, nothing a client would render changed. */
  refreshed: number;
  /** Ended before it was ever seen (source end date in the past) — not created. */
  skippedEnded: number;
  /** Same externalId more than once in one request — the last occurrence wins. */
  duplicatesInRequest: number;
  events: Awaited<ReturnType<typeof appendEvent>>[];
}

function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function upsertSeedReports(db: Queryable, env: Env, input: UpsertSeedReportsInput): Promise<UpsertSeedReportsResult> {
  const now = Date.now();
  // The last occurrence of an externalId in one request wins (same row cannot be written twice in one transaction).
  const byId = new Map<string, SeedReportInput>();
  for (const report of input.reports) byId.set(report.externalId, report);
  const duplicatesInRequest = input.reports.length - byId.size;

  return db.transaction(async (tx) => {
    const existing = new Map<string, ExistingSeedRow>();
    for (const row of await findSeedReportsForUpdate(tx, input.feedId, [...byId.keys()])) existing.set(row.externalId, row);

    const result: UpsertSeedReportsResult = { created: 0, reactivated: 0, updated: 0, refreshed: 0, skippedEnded: 0, duplicatesInRequest, events: [] };
    /** Re-sighted rows that need only the run stamp (source-given end date) vs. also a renewed TTL, grouped by ttl. */
    const refreshedFixed: string[] = [];
    const refreshedByTtl = new Map<number, string[]>();

    for (const report of byId.values()) {
      const explicitEnd = report.endsAt ? new Date(report.endsAt) : undefined;
      const ttlHours = report.ttlHours ?? env.HAZARD_EXPIRY_CONSTRUCTION_DAYS * 24;
      const expiresAt = explicitEnd ?? new Date(now + ttlHours * 3_600_000);
      const regionTile = positionToRegionTile(report.lat, report.lng, env);
      const prior = existing.get(report.externalId);

      if (!prior) {
        if (explicitEnd && explicitEnd.getTime() <= now) {
          result.skippedEnded++;
          continue;
        }
        const created = await insertSeedReportRow(tx, {
          type: report.type,
          lat: report.lat,
          lng: report.lng,
          reporterId: input.reporterId,
          regionTile,
          expiresAt,
          sourceLicense: input.sourceLicense,
          feedId: input.feedId,
          externalId: report.externalId,
          runId: input.runId,
        });
        if (created) {
          result.created++;
          result.events.push(
            await appendEvent(tx, { type: "ReportCreated", entityType: "hazardReport", entityId: created.id, payload: created, regionTile, source: "seed" }),
          );
          continue;
        }
        // Lost a race with a concurrent import of the same feed: re-read and fall through as an existing row next time round.
        const [raced] = await findSeedReportsForUpdate(tx, input.feedId, [report.externalId]);
        if (!raced) continue;
        existing.set(report.externalId, raced);
        await touchSeedReports(tx, [raced.id], input.runId);
        result.refreshed++;
        continue;
      }

      const reactivated = prior.status !== "active";
      const moved = metersBetween(prior.lat, prior.lng, report.lat, report.lng) > MOVED_METERS;
      const endChanged = explicitEnd !== undefined && Math.abs(explicitEnd.getTime() - prior.expiresAt.getTime()) > END_CHANGED_MS;

      if (reactivated && explicitEnd && explicitEnd.getTime() <= now) {
        // Listed by the source but already over: leave it ended (the row is not active), just mark it seen.
        await touchSeedReports(tx, [prior.id], input.runId);
        result.skippedEnded++;
        continue;
      }

      if (reactivated || moved || endChanged) {
        const updated = await updateSeedReportRow(tx, { id: prior.id, lat: report.lat, lng: report.lng, regionTile, expiresAt, sourceLicense: input.sourceLicense, runId: input.runId });
        if (reactivated) result.reactivated++;
        else result.updated++;
        result.events.push(
          await appendEvent(tx, {
            type: reactivated ? "ReportCreated" : "ReportConfirmed",
            entityType: "hazardReport",
            entityId: updated.id,
            payload: updated,
            regionTile,
            source: "seed",
          }),
        );
        continue;
      }

      result.refreshed++;
      if (explicitEnd) refreshedFixed.push(prior.id);
      else refreshedByTtl.set(ttlHours, [...(refreshedByTtl.get(ttlHours) ?? []), prior.id]);
    }

    await touchSeedReports(tx, refreshedFixed, input.runId);
    // Rows without a source end date get their TTL renewed on every sighting (the dead-man's switch above);
    // one statement per distinct ttl — the common case is a single group.
    for (const [ttlHours, ids] of refreshedByTtl) await touchSeedReports(tx, ids, input.runId, new Date(now + ttlHours * 3_600_000));

    return result;
  });
}

export interface RetireSeedReportsResult {
  retired: number;
  events: Awaited<ReturnType<typeof appendEvent>>[];
}

/**
 * Ends every active report of `feedId` that run `runId` did not see. Refuses when the run saw nothing at all:
 * an importer whose fetch returned an empty or truncated document must not be able to wipe a whole feed by
 * calling retire — the caller has to have written at least one report in this run.
 */
export async function retireSeedReports(db: Queryable, feedId: string, runId: string): Promise<RetireSeedReportsResult> {
  return db.transaction(async (tx) => {
    if ((await countSeedReportsOfRun(tx, feedId, runId)) === 0) {
      throw conflict("SEED_RUN_EMPTY", `Run ${runId} has not written any report of feed ${feedId}; refusing to retire the feed's reports on an empty run`);
    }
    const retired = await retireUnseenSeedReports(tx, feedId, runId);
    const events: RetireSeedReportsResult["events"] = [];
    for (const row of retired) {
      events.push(
        await appendEvent(tx, {
          type: "ReportExpired",
          entityType: "hazardReport",
          entityId: row.id,
          payload: { id: row.id, type: row.type, status: "expired" },
          regionTile: row.regionTile,
          source: "seed",
        }),
      );
    }
    return { retired: retired.length, events };
  });
}
