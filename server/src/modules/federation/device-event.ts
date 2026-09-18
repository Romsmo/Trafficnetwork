import { createHash } from "node:crypto";
import { toCanonicalBytes } from "../crypto/canonical.js";
import { verifySignedEnvelope, type SignedEnvelope } from "../crypto/envelope.js";
import type { HazardType } from "../../config/constants.js";

/**
 * The "Geräte-Ereignis" from the F-S0 plan's protocol sketch, scoped to
 * report creation for this milestone (F-S3) — see
 * server/docs/threat-model.md's federation section for why confirm/deny
 * replication is deliberately not built yet (it needs devices to be able to
 * reference a report by a cross-server-stable id, which requires exposing
 * federationEventId back through sync/snapshot first — a client-lib-facing
 * API change that belongs with F-C, not guessed at here). Signed by the
 * reporting *device's* own key, independent of whichever server relays it —
 * this is what actually makes "Vertraue Signaturen, nicht Servern" true for
 * federated data, as opposed to just trusting whichever server forwarded it.
 */
export interface DeviceCreateEventPayload {
  kind: "create";
  // Not Exclude<HazardType, "fixedSpeedCamera"> — the wire schema (see
  // modules/federation/routes.ts and modules/hazard-reports/routes.ts)
  // accepts any HazardType, same as HAZARD_TYPES; rejecting fixedSpeedCamera
  // specifically (rather than a generic invalid-enum error) is business
  // logic enforced at ingest time (modules/federation/ingest.ts), so callers
  // get a clear reason instead of a schema mismatch.
  type: HazardType;
  lat: number;
  lng: number;
  speedKmh?: number;
  /** The signing device's own Ed25519 public key — self-certifying, so any receiving server can verify without prior knowledge of this device. */
  devicePublicKey: string;
  timestamp: string;
}

/**
 * A cross-server-stable identity for a device event: sha256 over the
 * envelope's own (payload, signature) pair, hex-encoded. Deliberately *not*
 * part of the signed payload itself (per the plan's protocol sketch, "id =
 * Hash aus payload+signature") — it's derived after signing, purely a local
 * dedup/lookup key, so it can't itself be forged independent of a real
 * signature the way a payload-embedded id could.
 */
export function computeFederationEventId(envelope: SignedEnvelope<DeviceCreateEventPayload>): string {
  return createHash("sha256")
    .update(toCanonicalBytes({ payload: envelope.payload, signature: envelope.signature }))
    .digest("hex");
}

/**
 * Verifies a device-create envelope is self-consistent: the signature
 * actually verifies against the public key the payload itself claims signed
 * it. Does not check freshness or plausibility — callers (modules/federation
 * /ingest.ts, the hazard-reports route's optional deviceAssertion capture)
 * layer those on separately, since they differ by context (a locally
 * captured report vs. one relayed from a peer allow different clock-skew
 * windows).
 */
export function verifyDeviceCreateEnvelope(envelope: SignedEnvelope<DeviceCreateEventPayload>): boolean {
  if (envelope.payload.kind !== "create") return false;
  return verifySignedEnvelope(envelope, envelope.payload.devicePublicKey);
}

/**
 * Federation ingestion (modules/federation/ingest.ts) allows a much wider
 * past-dated window than the 60s auth-assertion freshness check
 * (modules/crypto/envelope.ts's isFreshTimestamp) — a replicated event may
 * legitimately be hours old by the time anti-entropy catches a server back
 * up after a partition. Still bounded, both directions: `maxAgeHours` in the
 * past (aligned with the dynamic retention window by default — an event
 * older than that would be purged again immediately anyway), and a small
 * fixed allowance into the future to absorb ordinary clock skew between
 * independently operated servers/devices.
 */
const FUTURE_SKEW_ALLOWANCE_MS = 5 * 60_000;

export function isWithinFederationEventWindow(iso: string, maxAgeHours: number): boolean {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return false;
  const now = Date.now();
  if (timestamp > now + FUTURE_SKEW_ALLOWANCE_MS) return false;
  if (timestamp < now - maxAgeHours * 60 * 60_000) return false;
  return true;
}
