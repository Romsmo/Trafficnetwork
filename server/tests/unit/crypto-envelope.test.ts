import { describe, expect, it } from "vitest";
import { generateEd25519KeyPair, keyId } from "../../src/modules/crypto/keys.js";
import { isFreshTimestamp, signEnvelope, verifySignedEnvelope } from "../../src/modules/crypto/envelope.js";

describe("Ed25519 key generation", () => {
  it("generates distinct keypairs each time", () => {
    const a = generateEd25519KeyPair();
    const b = generateEd25519KeyPair();
    expect(a.publicKeyRaw).not.toBe(b.publicKeyRaw);
    expect(a.privateKeyRaw).not.toBe(b.privateKeyRaw);
  });

  it("produces a stable, deterministic keyId for the same public key", () => {
    const pair = generateEd25519KeyPair();
    expect(keyId(pair.publicKeyRaw)).toBe(keyId(pair.publicKeyRaw));
  });

  it("produces different keyIds for different keys", () => {
    const a = generateEd25519KeyPair();
    const b = generateEd25519KeyPair();
    expect(keyId(a.publicKeyRaw)).not.toBe(keyId(b.publicKeyRaw));
  });
});

describe("signEnvelope / verifySignedEnvelope", () => {
  it("verifies a correctly signed envelope against the matching public key", () => {
    const pair = generateEd25519KeyPair();
    const envelope = signEnvelope({ type: "heartbeat", nodeId: "abc", timestamp: 123 }, pair);
    expect(verifySignedEnvelope(envelope, pair.publicKeyRaw)).toBe(true);
  });

  it("rejects a payload tampered with after signing", () => {
    const pair = generateEd25519KeyPair();
    const envelope = signEnvelope({ amount: 10 }, pair);
    const tampered = { ...envelope, payload: { amount: 1000 } };
    expect(verifySignedEnvelope(tampered, pair.publicKeyRaw)).toBe(false);
  });

  it("rejects verification against the wrong public key", () => {
    const signer = generateEd25519KeyPair();
    const attacker = generateEd25519KeyPair();
    const envelope = signEnvelope({ x: 1 }, signer);
    expect(verifySignedEnvelope(envelope, attacker.publicKeyRaw)).toBe(false);
  });

  it("rejects a corrupted signature string rather than throwing", () => {
    const pair = generateEd25519KeyPair();
    const envelope = signEnvelope({ x: 1 }, pair);
    expect(verifySignedEnvelope({ ...envelope, signature: "not-base64url!!" }, pair.publicKeyRaw)).toBe(false);
  });

  it("is insensitive to key ordering in the payload (canonical serialization)", () => {
    const pair = generateEd25519KeyPair();
    const envelope = signEnvelope({ b: 2, a: 1 }, pair);
    // Same logical content, different key order — must still verify, since
    // both the signer and verifier canonicalize before signing/checking.
    const reordered = { ...envelope, payload: { a: 1, b: 2 } };
    expect(verifySignedEnvelope(reordered, pair.publicKeyRaw)).toBe(true);
  });

  it("stamps the envelope's keyId from the signer's own public key", () => {
    const pair = generateEd25519KeyPair();
    const envelope = signEnvelope({ x: 1 }, pair);
    expect(envelope.keyId).toBe(keyId(pair.publicKeyRaw));
  });
});

describe("isFreshTimestamp", () => {
  it("accepts the current time", () => {
    expect(isFreshTimestamp(new Date().toISOString(), 60)).toBe(true);
  });

  it("accepts a timestamp just inside the window", () => {
    expect(isFreshTimestamp(new Date(Date.now() - 59_000).toISOString(), 60)).toBe(true);
  });

  it("rejects a timestamp outside the window", () => {
    expect(isFreshTimestamp(new Date(Date.now() - 120_000).toISOString(), 60)).toBe(false);
  });

  it("rejects a timestamp from the future outside the window", () => {
    expect(isFreshTimestamp(new Date(Date.now() + 120_000).toISOString(), 60)).toBe(false);
  });

  it("rejects an unparseable timestamp", () => {
    expect(isFreshTimestamp("not-a-date", 60)).toBe(false);
  });
});
