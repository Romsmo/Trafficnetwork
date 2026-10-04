import type { Queryable } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { appendEvent } from "../../db/append-event.js";
import {
  applyConfirmationEffect,
  findDuplicateCandidate,
  findHazardReportByIdForUpdate,
  insertConfirmationIfAbsent,
  insertHazardReportRow,
  type HazardReportRecord,
} from "../../db/queries/hazard-reports.js";
import { hazardExpiryMs, type HazardType } from "../../config/constants.js";
import { positionToRegionTile } from "../../lib/h3.js";
import { isCameraType } from "../cameras/filter.js";
import { runModerationGate } from "../moderation/gate.js";
import { checkRateLimit } from "../moderation/rate-limit.js";
import type { HazardReportInput } from "../moderation/plausibility.js";
import { conflict, notFound } from "../../lib/errors.js";

export interface CreateReportInput extends HazardReportInput {
  reporterId: string;
}

export interface CreateReportResult {
  /** The report with the country set of a camera report (camera-record.ts) — the route decides what of it a client may see. */
  report: HazardReportRecord;
  merged: boolean;
  /** For modules/hazard-reports/routes.ts to publish via WebSocket after commit. */
  event: Awaited<ReturnType<typeof appendEvent>>;
}

export interface CreateReportOptions {
  /** See modules/moderation/gate.ts's ModerationGateOptions — same rationale. */
  skipRateLimit?: boolean;
  /** Federation ingestion only (modules/federation/ingest.ts) — attaches the device-signed envelope to the resulting event_log row, whichever event type (Created or Confirmed) the merge-or-create decision produces. */
  federation?: { federationEventId: string; federationEnvelope: unknown; originNodeId: string | null };
}

/**
 * docs/concept.md section 5.4: creates a new report, or — if an active report of
 * the same type already exists within DUPLICATE_MERGE_RADIUS_METERS — records this
 * submission as a confirmation of the existing one instead. Always extends the
 * existing report's expiry on a merge (a fresh "I see this too" is real signal
 * worth propagating to other clients via the emitted event), but only increments
 * confirmCount when this reporter hadn't already confirmed it.
 *
 * This same merge-or-create decision is also what makes federation ingestion
 * (modules/federation/ingest.ts) converge: two servers independently applying
 * this function to the same set of device events reach the same materialized
 * state regardless of arrival order, per the F-S0 plan's CRDT-merge decision.
 */
export async function createOrMergeReport(
  db: Queryable,
  env: Env,
  input: CreateReportInput,
  opts?: CreateReportOptions,
): Promise<CreateReportResult> {
  await runModerationGate(db, input.reporterId, input, env, { skipRateLimit: opts?.skipRateLimit });

  return db.transaction(async (tx) => {
    const existing = await findDuplicateCandidate(tx, input.type, input.lat, input.lng, env.DUPLICATE_MERGE_RADIUS_METERS);

    if (existing) {
      const isNewConfirmation = await insertConfirmationIfAbsent(tx, existing.item.id, input.reporterId, "stillThere");
      const newExpiresAt = new Date(Date.now() + hazardExpiryMs(existing.item.type as Exclude<HazardType, "fixedSpeedCamera">, env));
      const updated = await applyConfirmationEffect(tx, {
        id: existing.item.id,
        incrementConfirm: isNewConfirmation,
        newExpiresAt,
      });
      const event = await appendEvent(tx, {
        type: "ReportConfirmed",
        entityType: "hazardReport",
        entityId: updated.item.id,
        payload: updated.item,
        regionTile: updated.item.regionTile,
        cameraCountries: updated.countries,
        source: "community",
        ...opts?.federation,
      });
      return { report: updated, merged: true, event };
    }

    const regionTile = positionToRegionTile(input.lat, input.lng, env);
    const expiresAt = new Date(Date.now() + hazardExpiryMs(input.type, env));
    const created = await insertHazardReportRow(tx, {
      type: input.type,
      lat: input.lat,
      lng: input.lng,
      reporterId: input.reporterId,
      speedKmh: input.speedKmh,
      regionTile,
      expiresAt,
      // Camera reports get their country set computed once, here (camera-record.ts); every other type has none.
      ...(isCameraType(input.type) ? { countryMarginM: env.CAMERA_POLICY_BORDER_MARGIN_M } : {}),
    });
    // Records the creator's own implicit "stillThere" so a later nearby
    // resubmission from this same reporter is recognized as already-confirmed
    // by insertConfirmationIfAbsent above, instead of double-counting it.
    await insertConfirmationIfAbsent(tx, created.item.id, input.reporterId, "stillThere");
    const event = await appendEvent(tx, {
      type: "ReportCreated",
      entityType: "hazardReport",
      entityId: created.item.id,
      payload: created.item,
      regionTile,
      cameraCountries: created.countries,
      source: "community",
      ...opts?.federation,
    });
    return { report: created, merged: false, event };
  });
}

export interface ConfirmReportInput {
  reportId: string;
  reporterId: string;
  kind: "stillThere" | "gone";
}

export interface ConfirmReportResult {
  report: HazardReportRecord;
  recorded: boolean;
  /** Undefined when recorded is false (idempotent no-op — nothing to publish). */
  event?: Awaited<ReturnType<typeof appendEvent>>;
}

/**
 * Explicit confirm/deny against a known report id (as opposed to createOrMergeReport's
 * implicit merge-by-proximity). One vote per reporter per report in Phase 1 — a
 * reporter who already left either kind of vote can't change it (unique constraint
 * on (hazard_report_id, reporter_id) regardless of kind); calling again is a no-op
 * that still returns the current report state, not an error. There is no
 * automatic active -> removed transition from accumulated "gone" votes for
 * ordinary hazard reports in Phase 1 — docs/concept.md's fixed EVENT_TYPES list has
 * no event for it, unlike the fixed-camera namespace's explicit removal-report
 * mechanic (milestone P1.4). Reports here only ever leave "active" via the expiry
 * worker.
 */
export async function confirmReport(db: Queryable, env: Env, input: ConfirmReportInput): Promise<ConfirmReportResult> {
  await checkRateLimit(db, input.reporterId, env);

  return db.transaction(async (tx) => {
    const report = await findHazardReportByIdForUpdate(tx, input.reportId);
    if (!report) throw notFound(`No active hazard report with id ${input.reportId}`);
    if (report.item.status !== "active") {
      throw conflict("REPORT_NOT_ACTIVE", `Report ${input.reportId} is ${report.item.status}, not active`);
    }

    const recorded = await insertConfirmationIfAbsent(tx, report.item.id, input.reporterId, input.kind);
    if (!recorded) {
      return { report, recorded: false };
    }

    const isStillThere = input.kind === "stillThere";
    const updated = await applyConfirmationEffect(tx, {
      id: report.item.id,
      incrementConfirm: isStillThere,
      incrementDeny: !isStillThere,
      newExpiresAt: isStillThere
        ? new Date(Date.now() + hazardExpiryMs(report.item.type as Exclude<HazardType, "fixedSpeedCamera">, env))
        : undefined,
    });

    const event = await appendEvent(tx, {
      type: isStillThere ? "ReportConfirmed" : "ReportDenied",
      entityType: "hazardReport",
      entityId: updated.item.id,
      payload: updated.item,
      regionTile: updated.item.regionTile,
      cameraCountries: updated.countries,
      source: "community",
    });

    return { report: updated, recorded: true, event };
  });
}
