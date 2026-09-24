import { z } from "zod";
import {
  CORRECTION_REASONS,
  CORRECTION_VOTE_KINDS,
  SPEED_LIMIT_UNITS,
  type CorrectionReason,
  type CorrectionVoteKind,
  type SpeedLimitUnit,
} from "../../config/constants.js";
import { verifySignedEnvelope, type SignedEnvelope } from "../crypto/envelope.js";
import { keyId } from "../crypto/keys.js";

/**
 * The device-signed vote (docs/speed-limit-corrections.md D9) — the federation
 * counterpart of DeviceCreateEventPayload for hazard reports. It references the
 * segment by its content-derived `segmentKey`, never by a server-local id, so
 * any server that holds that geometry resolves it the same way.
 */
export interface SpeedLimitVotePayload {
  kind: "speedLimitVote";
  vote: CorrectionVoteKind;
  segmentKey: string;
  value: number;
  unit: SpeedLimitUnit;
  reason?: CorrectionReason;
  /** The signing device's own Ed25519 public key — self-certifying. */
  devicePublicKey: string;
  timestamp: string;
}

export const SEGMENT_KEY_PATTERN = /^[0-9a-f]{32}$/;

// .passthrough(): same rationale as every signed-payload schema since F-S2
// (see modules/auth/routes.ts's deviceTokenBodySchema comment) — the payload
// must reach verification exactly as its signer canonicalized it.
export const speedLimitVotePayloadSchema = z
  .object({
    kind: z.literal("speedLimitVote"),
    vote: z.enum(CORRECTION_VOTE_KINDS),
    segmentKey: z.string().regex(SEGMENT_KEY_PATTERN),
    value: z.number().int(),
    unit: z.enum(SPEED_LIMIT_UNITS),
    reason: z.enum(CORRECTION_REASONS).optional(),
    devicePublicKey: z.string().min(1),
    timestamp: z.string(),
  })
  .passthrough();

export const speedLimitVoteEnvelopeSchema = z.object({
  payload: speedLimitVotePayloadSchema,
  keyId: z.string(),
  signature: z.string(),
});

export type SpeedLimitVoteEnvelope = SignedEnvelope<SpeedLimitVotePayload>;

/** Signature verifies against the key the payload itself names. Freshness/plausibility are layered on by the callers, which differ by context. */
export function verifySpeedLimitVoteEnvelope(envelope: SpeedLimitVoteEnvelope): boolean {
  if (envelope.payload.kind !== "speedLimitVote") return false;
  return verifySignedEnvelope(envelope, envelope.payload.devicePublicKey);
}

/**
 * Reporter identity of a device on *every* server: derived from the key alone,
 * so all servers agree who "the same device" is and the merged tally converges.
 */
export function deviceReporterId(devicePublicKey: string): string {
  return `device:${keyId(devicePublicKey)}`;
}

/** Same 5-minute clock-skew allowance as report events; unlike them there is no maximum age (votes are durable state — D9). */
const FUTURE_SKEW_ALLOWANCE_MS = 5 * 60_000;

export function isNotInTheFuture(iso: string): boolean {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return false;
  return timestamp <= Date.now() + FUTURE_SKEW_ALLOWANCE_MS;
}
