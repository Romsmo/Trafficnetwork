//! Prints a fresh Ed25519 keypair + signed test payload as JSON to stdout.
//! Consumed by `client-lib/fixtures/verify-vector.mjs`, which re-canonicalizes
//! and re-verifies it in Node against the server's own `canonicalize` +
//! `node:crypto` — the cross-language check that this crate's canonical
//! JSON and signatures actually agree with `server/src/modules/crypto/*`,
//! not just with themselves. See F-C0 plan's verification section.

use serde_json::json;
use trafficnetwork_core::crypto::{generate_ed25519_keypair, sign_envelope};

fn main() {
    let pair = generate_ed25519_keypair().expect("key generation failed");

    // Deliberately out-of-order keys, a negative float, a zero, nested
    // null/bool, and non-ASCII text — enough surface to catch a
    // canonicalization mismatch (key sort order, number formatting, escaping)
    // that a trivially simple payload wouldn't exercise.
    let payload = json!({
        "zeta": "unicode: äöü 🚗",
        "alpha": -12.5,
        "kind": "create",
        "count": 0,
        "nested": { "b": true, "a": null }
    });

    let envelope = sign_envelope(payload.clone(), &pair).expect("signing failed");

    let vector = json!({
        "publicKey": pair.public_key_raw,
        "payload": payload,
        "keyId": envelope.key_id,
        "signature": envelope.signature,
    });
    println!("{}", serde_json::to_string(&vector).expect("vector serialization failed"));
}
