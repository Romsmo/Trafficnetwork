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
import { DYNAMIC_CAMERA_TYPES, type HazardType } from "../../config/constants.js";
import { checkRequestedExpiry, resolveReportExpiry, type ExpiryType, type ReportExpiryRules } from "../../config/report-expiry.js";
import { positionToRegionTile } from "../../lib/h3.js";
import { isCameraType } from "../cameras/filter.js";
import { markReportExpired } from "../expiry/expire-report.js";
import { runModerationGate } from "../moderation/gate.js";
import { checkRateLimit } from "../moderation/rate-limit.js";
import type { HazardReportInput } from "../moderation/plausibility.js";
import { ApiError, conflict, notFound } from "../../lib/errors.js";

export interface CreateReportInput extends HazardReportInput {
  reporterId: string;
  /**
   * How long the reporter wants the report to live. Optional; without it the type's default applies. Part of the signed
   * device payload when there is one, so every node derives the same `expiresAt` (docs/report-expiry.md).
   */
  expiresInSeconds?: number;
}

/** Throws the 400 `EXPIRY_OUT_OF_RANGE` answer carrying the bounds that apply — never clamps silently. */
function requireExpiryInRange(rules: ReportExpiryRules, type: ExpiryType, expiresInSeconds: number | undefined): number {
  const check = checkRequestedExpiry(rules, type, expiresInSeconds);
  if (!check.ok) {
    throw new ApiError(400, "EXPIRY_OUT_OF_RANGE", check.message, {
      type,
      requestedSeconds: expiresInSeconds,
      defaultSeconds: check.rule.defaultSeconds,
      minSeconds: check.rule.minSeconds,
      maxSeconds: check.rule.maxSeconds,
    });
  }
  return check.seconds;
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
  /** The expiry rules in force (config/report-expiry.ts, with the signed network configuration applied). Default: this node's own. */
  expiry?: ReportExpiryRules;
  /**
   * The moment the report was made: the device's signed timestamp when there is one (so a late-arriving federated report
   * ends when its reporter meant it to, on every node), otherwise this server's clock.
   */
  occurredAt?: Date;
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
  // The duration is checked first: a request outside the bounds costs no rate-limit slot and never reaches the database.
  const rules = opts?.expiry ?? resolveReportExpiry(env);
  const durationSeconds = requireExpiryInRange(rules, input.type, input.expiresInSeconds);
  const anchor = opts?.occurredAt ?? new Date();
  const candidateExpiresAt = new Date(anchor.getTime() + durationSeconds * 1000);

  await runModerationGate(db, input.reporterId, input, env, { skipRateLimit: opts?.skipRateLimit });

  return db.transaction(async (tx) => {
    const existing = await findDuplicateCandidate(tx, input.type, input.lat, input.lng, env.DUPLICATE_MERGE_RADIUS_METERS);

    if (existing) {
      const isNewConfirmation = await insertConfirmationIfAbsent(tx, existing.item.id, input.reporterId, "stillThere");
      // Later of what it already had and what this submission asks for: a merge never shortens a report, and taking the
      // maximum of per-report anchors is order-independent, so nodes that see the same reports in another order agree.
      const newExpiresAt = new Date(Math.max(Date.parse(existing.item.expiresAt), candidateExpiresAt.getTime()));
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
    const expiresAt = candidateExpiresAt;
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
  /** Set when this vote ended the report early (publish it after `event`). */
  endedEvent?: Awaited<ReturnType<typeof appendEvent>>;
}

/**
 * Whether the "gone" votes on a temporary camera report reach the early-end threshold and at least match the people who
 * said it is there. `confirmCount` does not include whoever made the report (their implicit "still there" is recorded as
 * a confirmation row, not counted), so the reporter is counted here: denials >= confirmations + 1.
 */
function isGoneEnough(item: HazardReportRecord["item"], env: Env): boolean {
  return (
    item.source === "community" &&
    item.status === "active" &&
    (DYNAMIC_CAMERA_TYPES as readonly HazardType[]).includes(item.type) &&
    item.denyCount >= env.HAZARD_GONE_THRESHOLD_CAMERA &&
    item.denyCount >= item.confirmCount + 1
  );
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
export async function confirmReport(
  db: Queryable,
  env: Env,
  input: ConfirmReportInput,
  rules: ReportExpiryRules = resolveReportExpiry(env),
): Promise<ConfirmReportResult> {
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
    // "Still there" renews to now + the type's default, but never shortens a report that was made to live longer.
    const renewedUntil = Date.now() + rules[report.item.type as ExpiryType].defaultSeconds * 1000;
    const updated = await applyConfirmationEffect(tx, {
      id: report.item.id,
      incrementConfirm: isStillThere,
      incrementDeny: !isStillThere,
      newExpiresAt: isStillThere ? new Date(Math.max(Date.parse(report.item.expiresAt), renewedUntil)) : undefined,
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

    // A temporary camera that enough distinct devices call gone ends now, not at its (hours or days away) expiry.
    // The same status and event the sweep uses; votes are node-local, so other nodes keep it until their own end.
    if (!isStillThere && isGoneEnough(updated.item, env)) {
      const endedEvent = await markReportExpired(tx, {
        id: updated.item.id,
        type: updated.item.type,
        regionTile: updated.item.regionTile,
        source: updated.item.source,
        countries: updated.countries,
        position: updated.item.position,
      });
      return { report: { ...updated, item: { ...updated.item, status: "expired" } }, recorded: true, event, endedEvent };
    }

    return { report: updated, recorded: true, event };
  });
}
