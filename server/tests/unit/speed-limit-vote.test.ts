import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { ApiError } from "../../src/lib/errors.js";
import { correctionBounds, validateCorrectionValue } from "../../src/modules/speed-limit-corrections/plausibility.js";
import {
  deviceReporterId,
  isNotInTheFuture,
  speedLimitVoteEnvelopeSchema,
  verifySpeedLimitVoteEnvelope,
  type SpeedLimitVotePayload,
} from "../../src/modules/speed-limit-corrections/vote.js";
import { generateEd25519KeyPair, keyId } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import { computeFederationEventId } from "../../src/modules/federation/device-event.js";

const env = (over: Record<string, string> = {}) => {
  resetEnvCache();
  return loadEnv({ DATABASE_URL: "postgres://user:pass@localhost:5432/db", JWT_SECRET: "a".repeat(32), ...over });
};

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof ApiError ? err.code : "other";
  }
  return undefined;
}

describe("validateCorrectionValue", () => {
  it("accepts common posted limits in both units", () => {
    const e = env();
    for (const v of [5, 10, 30, 50, 100, 130, 150]) expect(codeOf(() => validateCorrectionValue(v, "kmh", e))).toBeUndefined();
    for (const v of [5, 20, 30, 70, 85]) expect(codeOf(() => validateCorrectionValue(v, "mph", e))).toBeUndefined();
  });

  it("rejects values outside the range of the unit — 100 mph is not a posted limit, 100 km/h is", () => {
    const e = env();
    expect(codeOf(() => validateCorrectionValue(100, "kmh", e))).toBeUndefined();
    expect(codeOf(() => validateCorrectionValue(100, "mph", e))).toBe("CORRECTION_VALUE_OUT_OF_RANGE");
    expect(codeOf(() => validateCorrectionValue(0, "kmh", e))).toBe("CORRECTION_VALUE_OUT_OF_RANGE");
    expect(codeOf(() => validateCorrectionValue(155, "kmh", e))).toBe("CORRECTION_VALUE_OUT_OF_RANGE");
    expect(codeOf(() => validateCorrectionValue(-30, "kmh", e))).toBe("CORRECTION_VALUE_OUT_OF_RANGE");
  });

  it("rejects non-integers", () => {
    expect(codeOf(() => validateCorrectionValue(50.5, "kmh", env()))).toBe("CORRECTION_VALUE_OUT_OF_RANGE");
    expect(codeOf(() => validateCorrectionValue(Number.NaN, "kmh", env()))).toBe("CORRECTION_VALUE_OUT_OF_RANGE");
  });

  it("enforces the step (catches fat-finger values) and lets the operator relax it", () => {
    expect(codeOf(() => validateCorrectionValue(33, "kmh", env()))).toBe("CORRECTION_VALUE_NOT_ON_STEP");
    expect(codeOf(() => validateCorrectionValue(55, "kmh", env()))).toBeUndefined();
    expect(codeOf(() => validateCorrectionValue(33, "kmh", env({ COMMUNITY_CORRECTIONS_VALUE_STEP: "1" })))).toBeUndefined();
  });

  it("follows configured bounds", () => {
    const e = env({ COMMUNITY_CORRECTIONS_KMH_MAX: "130" });
    expect(correctionBounds(e, "kmh")).toEqual({ min: 5, max: 130, step: 5 });
    expect(codeOf(() => validateCorrectionValue(140, "kmh", e))).toBe("CORRECTION_VALUE_OUT_OF_RANGE");
  });

  it("answers with the numbers a client needs to explain the rejection", () => {
    try {
      validateCorrectionValue(500, "kmh", env());
    } catch (err) {
      expect((err as ApiError).statusCode).toBe(422);
      expect((err as ApiError).details).toEqual({ unit: "kmh", min: 5, max: 150, step: 5 });
    }
  });
});

describe("speed-limit vote envelope", () => {
  const device = generateEd25519KeyPair();
  const payload = (over: Partial<SpeedLimitVotePayload> = {}): SpeedLimitVotePayload => ({
    kind: "speedLimitVote",
    vote: "support",
    segmentKey: "a".repeat(32),
    value: 50,
    unit: "kmh",
    devicePublicKey: device.publicKeyRaw,
    timestamp: new Date().toISOString(),
    ...over,
  });

  it("verifies against the key the payload names", () => {
    expect(verifySpeedLimitVoteEnvelope(signEnvelope(payload(), device))).toBe(true);
  });

  it("does not verify once any signed field is changed", () => {
    const signed = signEnvelope(payload(), device);
    for (const change of [{ value: 60 }, { vote: "deny" as const }, { unit: "mph" as const }, { segmentKey: "b".repeat(32) }, { reason: "other" as const }]) {
      expect(verifySpeedLimitVoteEnvelope({ ...signed, payload: { ...signed.payload, ...change } })).toBe(false);
    }
  });

  it("does not verify a vote signed by someone else claiming this device's key", () => {
    const impostor = generateEd25519KeyPair();
    expect(verifySpeedLimitVoteEnvelope(signEnvelope(payload(), impostor))).toBe(false);
  });

  it("gives a stable id that changes with any signed content", () => {
    const signed = signEnvelope(payload({ timestamp: "2026-01-01T00:00:00.000Z" }), device);
    expect(computeFederationEventId(signed)).toBe(computeFederationEventId(signed));
    expect(computeFederationEventId(signEnvelope(payload({ timestamp: "2026-01-01T00:00:01.000Z" }), device))).not.toBe(computeFederationEventId(signed));
  });

  it("derives the reporter from the key alone, the same on every server", () => {
    expect(deviceReporterId(device.publicKeyRaw)).toBe(`device:${keyId(device.publicKeyRaw)}`);
  });

  it("the wire schema accepts a well-formed vote and rejects malformed ones", () => {
    const good = signEnvelope(payload(), device);
    expect(speedLimitVoteEnvelopeSchema.safeParse(good).success).toBe(true);
    for (const bad of [
      { ...good, payload: { ...good.payload, kind: "create" } },
      { ...good, payload: { ...good.payload, segmentKey: "not-a-key" } },
      { ...good, payload: { ...good.payload, value: 50.5 } },
      { ...good, payload: { ...good.payload, unit: "knots" } },
      { ...good, payload: { ...good.payload, vote: "maybe" } },
      { ...good, payload: { ...good.payload, reason: "because" } },
    ]) {
      expect(speedLimitVoteEnvelopeSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("keeps unknown payload fields so the signature still verifies (forward compatibility)", () => {
    const extended = signEnvelope({ ...payload(), futureField: 1 }, device);
    const parsed = speedLimitVoteEnvelopeSchema.parse(extended);
    expect(verifySpeedLimitVoteEnvelope(parsed as never)).toBe(true);
  });
});

describe("isNotInTheFuture", () => {
  it("allows clock skew up to five minutes and any past date", () => {
    expect(isNotInTheFuture(new Date().toISOString())).toBe(true);
    expect(isNotInTheFuture(new Date(Date.now() + 4 * 60_000).toISOString())).toBe(true);
    expect(isNotInTheFuture(new Date(Date.now() + 10 * 60_000).toISOString())).toBe(false);
    expect(isNotInTheFuture(new Date(Date.now() - 365 * 24 * 3_600_000).toISOString())).toBe(true);
    expect(isNotInTheFuture("not a date")).toBe(false);
  });
});
