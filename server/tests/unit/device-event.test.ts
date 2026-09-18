import { describe, expect, it } from "vitest";
import { generateEd25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import {
  computeFederationEventId,
  isWithinFederationEventWindow,
  verifyDeviceCreateEnvelope,
  type DeviceCreateEventPayload,
} from "../../src/modules/federation/device-event.js";

function makePayload(overrides: Partial<DeviceCreateEventPayload> = {}): DeviceCreateEventPayload {
  return {
    kind: "create",
    type: "ice",
    lat: 52.5,
    lng: 13.4,
    devicePublicKey: "",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("verifyDeviceCreateEnvelope", () => {
  it("verifies a correctly self-signed create event", () => {
    const device = generateEd25519KeyPair();
    const envelope = signEnvelope(makePayload({ devicePublicKey: device.publicKeyRaw }), device);
    expect(verifyDeviceCreateEnvelope(envelope)).toBe(true);
  });

  it("rejects an envelope signed by a different key than it claims", () => {
    const device = generateEd25519KeyPair();
    const impostor = generateEd25519KeyPair();
    const envelope = signEnvelope(makePayload({ devicePublicKey: device.publicKeyRaw }), impostor);
    expect(verifyDeviceCreateEnvelope(envelope)).toBe(false);
  });

  it("rejects a tampered payload (e.g. moved position after signing)", () => {
    const device = generateEd25519KeyPair();
    const envelope = signEnvelope(makePayload({ devicePublicKey: device.publicKeyRaw, lat: 52.5 }), device);
    const tampered = { ...envelope, payload: { ...envelope.payload, lat: 10 } };
    expect(verifyDeviceCreateEnvelope(tampered)).toBe(false);
  });

  it("rejects a payload whose kind isn't \"create\"", () => {
    const device = generateEd25519KeyPair();
    const envelope = signEnvelope(
      { ...makePayload({ devicePublicKey: device.publicKeyRaw }), kind: "confirm" as "create" },
      device,
    );
    expect(verifyDeviceCreateEnvelope(envelope)).toBe(false);
  });
});

describe("computeFederationEventId", () => {
  it("is deterministic for the same envelope", () => {
    const device = generateEd25519KeyPair();
    const envelope = signEnvelope(makePayload({ devicePublicKey: device.publicKeyRaw }), device);
    expect(computeFederationEventId(envelope)).toBe(computeFederationEventId(envelope));
  });

  it("differs for envelopes with different payloads", () => {
    const device = generateEd25519KeyPair();
    const a = signEnvelope(makePayload({ devicePublicKey: device.publicKeyRaw, lat: 1 }), device);
    const b = signEnvelope(makePayload({ devicePublicKey: device.publicKeyRaw, lat: 2 }), device);
    expect(computeFederationEventId(a)).not.toBe(computeFederationEventId(b));
  });

  it("produces a 64-character hex sha256 digest", () => {
    const device = generateEd25519KeyPair();
    const envelope = signEnvelope(makePayload({ devicePublicKey: device.publicKeyRaw }), device);
    expect(computeFederationEventId(envelope)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isWithinFederationEventWindow", () => {
  it("accepts the current time", () => {
    expect(isWithinFederationEventWindow(new Date().toISOString(), 72)).toBe(true);
  });

  it("accepts a timestamp within the past window (e.g. anti-entropy catch-up)", () => {
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
    expect(isWithinFederationEventWindow(fortyEightHoursAgo, 72)).toBe(true);
  });

  it("rejects a timestamp older than the configured max age", () => {
    const hundredHoursAgo = new Date(Date.now() - 100 * 60 * 60_000).toISOString();
    expect(isWithinFederationEventWindow(hundredHoursAgo, 72)).toBe(false);
  });

  it("accepts small clock skew into the future", () => {
    const twoMinutesFromNow = new Date(Date.now() + 2 * 60_000).toISOString();
    expect(isWithinFederationEventWindow(twoMinutesFromNow, 72)).toBe(true);
  });

  it("rejects a timestamp far in the future", () => {
    const oneHourFromNow = new Date(Date.now() + 60 * 60_000).toISOString();
    expect(isWithinFederationEventWindow(oneHourFromNow, 72)).toBe(false);
  });

  it("rejects an unparseable timestamp", () => {
    expect(isWithinFederationEventWindow("not-a-date", 72)).toBe(false);
  });
});
