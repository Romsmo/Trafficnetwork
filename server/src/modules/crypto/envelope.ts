import { sign as edSign, verify as edVerify } from "node:crypto";
import { toCanonicalBytes } from "./canonical.js";
import { importPrivateKey, importPublicKey, keyId, type Ed25519KeyPair } from "./keys.js";

/**
 * The one envelope shape every signed thing in the federation protocol uses
 * (device reports, heartbeats, join requests, network config, package
 * manifests) — see the F-S0 plan's protocol sketch. `payload` is signed as
 * its RFC 8785 canonical form; `keyId` is a lookup hint (see keys.ts), never
 * itself trusted — verifySignedEnvelope always re-derives trust from the
 * actual public key the caller supplies.
 */
export interface SignedEnvelope<T = unknown> {
  payload: T;
  keyId: string;
  signature: string; // base64url, 64 raw Ed25519 signature bytes
}

export function signEnvelope<T>(payload: T, keyPair: Ed25519KeyPair): SignedEnvelope<T> {
  const privateKey = importPrivateKey(keyPair);
  const signature = edSign(null, toCanonicalBytes(payload), privateKey);
  return { payload, keyId: keyId(keyPair.publicKeyRaw), signature: signature.toString("base64url") };
}

/**
 * `expectedPublicKeyRaw` is the caller's own source of truth for which key
 * ought to have signed this (e.g. the public key stored against a device's
 * clientId, or the configured network root public key) — envelope.keyId is
 * never used to look up trust, only logged/compared for debugging mismatches.
 */
export function verifySignedEnvelope<T>(envelope: SignedEnvelope<T>, expectedPublicKeyRaw: string): boolean {
  let signature: Buffer;
  try {
    signature = Buffer.from(envelope.signature, "base64url");
  } catch {
    return false;
  }
  const publicKey = importPublicKey(expectedPublicKeyRaw);
  try {
    return edVerify(null, toCanonicalBytes(envelope.payload), publicKey, signature);
  } catch {
    // A malformed key/signature throws rather than returning false in some
    // Node versions/paths — treat any such failure as "not verified".
    return false;
  }
}

/**
 * Replay protection for short-lived signed assertions (device-token exchange,
 * key-binding proof-of-possession — see modules/auth/device-jwt.ts): a
 * signature alone never expires on its own, so anything an attacker captures
 * (e.g. from a compromised log) would otherwise be replayable forever.
 * Requiring the signed payload to carry a recent timestamp, checked against
 * server time within a small window, bounds that replay window instead —
 * the same pattern JWT assertion flows (Google service accounts, GitHub App
 * auth) use for exactly this reason.
 */
export function isFreshTimestamp(iso: string, windowSeconds: number): boolean {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return false;
  return Math.abs(Date.now() - timestamp) <= windowSeconds * 1000;
}
