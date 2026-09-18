import type { Queryable } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { federationEventExists } from "../../db/queries/event-log.js";
import { createOrMergeReport } from "../hazard-reports/service.js";
import { validatePlausibility } from "../moderation/plausibility.js";
import { keyId } from "../crypto/keys.js";
import type { SignedEnvelope } from "../crypto/envelope.js";
import {
  computeFederationEventId,
  isWithinFederationEventWindow,
  verifyDeviceCreateEnvelope,
  type DeviceCreateEventPayload,
} from "./device-event.js";
import type { appendEvent } from "../../db/append-event.js";

export type IngestOutcome =
  | { status: "created" | "merged"; federationEventId: string; event: Awaited<ReturnType<typeof appendEvent>> }
  | { status: "duplicate"; federationEventId: string }
  | { status: "rejected"; federationEventId: string; reason: string };

/**
 * The one path both the local capture point (POST /v1/hazard-reports'
 * optional deviceAssertion, modules/hazard-reports/routes.ts) and federated
 * ingestion (POST /v1/federation/events and the anti-entropy pull worker,
 * modules/federation/{routes,workers}.ts) funnel through — so a report
 * signed by a device is handled identically regardless of whether it reached
 * this server directly or via replication, per the F-S0 plan's CRDT-merge
 * decision ("jeder Server kommt damit zwangsläufig zum gleichen Ergebnis").
 *
 * `originNodeId`: null for a locally captured event (a device submitted it
 * directly to this server); the sending peer's nodeId for anything arriving
 * via /v1/federation/events or the anti-entropy pull.
 */
export async function ingestDeviceCreateEvent(
  db: Queryable,
  env: Env,
  envelope: SignedEnvelope<DeviceCreateEventPayload>,
  originNodeId: string | null,
): Promise<IngestOutcome> {
  const federationEventId = computeFederationEventId(envelope);

  if (!verifyDeviceCreateEnvelope(envelope)) {
    return { status: "rejected", federationEventId, reason: "Signature does not verify against the envelope's own claimed devicePublicKey" };
  }
  if (!isWithinFederationEventWindow(envelope.payload.timestamp, env.FEDERATION_EVENT_MAX_AGE_HOURS)) {
    return { status: "rejected", federationEventId, reason: "Event timestamp is outside the accepted window (too old, or too far in the future)" };
  }
  if (envelope.payload.type === "fixedSpeedCamera") {
    // Not a hazard_reports row at all (see config/constants.ts) — fixed-camera
    // federation is out of scope for this milestone (see device-event.ts).
    return { status: "rejected", federationEventId, reason: "fixedSpeedCamera events are not federated in this milestone" };
  }

  try {
    validatePlausibility(
      { type: envelope.payload.type, lat: envelope.payload.lat, lng: envelope.payload.lng, speedKmh: envelope.payload.speedKmh },
      env,
    );
  } catch (err) {
    return { status: "rejected", federationEventId, reason: err instanceof Error ? err.message : "Implausible report" };
  }

  if (await federationEventExists(db, federationEventId)) {
    return { status: "duplicate", federationEventId };
  }

  const reporterId = `device:${keyId(envelope.payload.devicePublicKey)}`;
  try {
    const result = await createOrMergeReport(
      db,
      env,
      {
        type: envelope.payload.type,
        lat: envelope.payload.lat,
        lng: envelope.payload.lng,
        speedKmh: envelope.payload.speedKmh,
        reporterId,
      },
      {
        skipRateLimit: true,
        federation: { federationEventId, federationEnvelope: envelope, originNodeId },
      },
    );
    return { status: result.merged ? "merged" : "created", federationEventId, event: result.event };
  } catch (err) {
    // The federationEventExists() check above is best-effort, not exclusive —
    // this same event can legitimately arrive twice at once (pushed by one
    // peer while anti-entropy is pulling it from another). The event_log
    // UNIQUE constraint on federation_event_id is the real guard; losing that
    // race aborts this transaction (Postgres SQLSTATE 23505), which we treat
    // as "someone else just inserted it" rather than a real failure.
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505") {
      return { status: "duplicate", federationEventId };
    }
    throw err;
  }
}
