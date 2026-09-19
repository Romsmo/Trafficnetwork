import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";

/**
 * Ed25519 via Node's native `crypto` (OpenSSL-backed) — no third-party crypto
 * primitive, per the F-S0 plan's signature decision. Keys are handled as raw
 * 32-byte values, base64url-encoded, rather than PEM/DER — compact enough to
 * embed directly in signed JSON payloads. The bridge to Node's KeyObject API
 * is JWK (RFC 8037's OKP key type), whose `x`/`d` fields *are* exactly those
 * raw bytes, base64url-encoded — not a re-encoding of a re-encoding.
 */

export interface Ed25519KeyPair {
  publicKeyRaw: string;
  privateKeyRaw: string;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });
  if (!pubJwk.x || !privJwk.d) {
    throw new Error("generateEd25519KeyPair: unexpected JWK export shape");
  }
  return { publicKeyRaw: pubJwk.x, privateKeyRaw: privJwk.d };
}

export function importPublicKey(publicKeyRaw: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyRaw }, format: "jwk" });
}

export function importPrivateKey(pair: Ed25519KeyPair): KeyObject {
  return createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: pair.publicKeyRaw, d: pair.privateKeyRaw },
    format: "jwk",
  });
}

/**
 * Short (16 hex char / 64-bit) fingerprint used as a lookup hint in signed
 * payloads — not a security boundary itself. A signature is only ever
 * trusted after verifying it against the actual stored/configured public key
 * that a keyId points at, never based on the keyId string matching alone.
 */
export function keyId(publicKeyRaw: string): string {
  return createHash("sha256").update(publicKeyRaw, "utf8").digest("hex").slice(0, 16);
}
