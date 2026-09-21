#!/usr/bin/env node
// Reads a JSON vector (from `cargo run --example gen_vector` in core/) on
// stdin and independently re-canonicalizes + re-verifies it using the
// server's own crypto stack (canonicalize npm package + node:crypto) — see
// core/examples/gen_vector.rs for what produces the input and why this
// exists (cross-language compatibility, not just Rust self-consistency).
import { createHash, createPublicKey, verify } from "node:crypto";
import canonicalize from "canonicalize";

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const raw = await new Promise((resolve, reject) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", reject);
});

const { publicKey, payload, keyId, signature } = JSON.parse(raw);

const canonical = canonicalize(payload);
if (canonical === undefined) fail("payload has no canonical JSON representation");

const expectedKeyId = createHash("sha256").update(publicKey, "utf8").digest("hex").slice(0, 16);
if (expectedKeyId !== keyId) fail(`keyId mismatch — rust=${keyId} node=${expectedKeyId}`);

const publicKeyObj = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
const signatureBytes = Buffer.from(signature, "base64url");
const canonicalBytes = Buffer.from(canonical, "utf8");
const verified = verify(null, canonicalBytes, publicKeyObj, signatureBytes);

if (!verified) fail("signature produced by the Rust core does not verify under Node's crypto");

console.log("OK: canonical JSON, keyId, and Ed25519 signature all verified cross-language (Rust -> Node)");
