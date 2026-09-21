//! The one signed-payload shape everything in the federation protocol uses
//! (device reports, and — mirrored here for future join/heartbeat use —
//! node/network messages). Matches `server/src/modules/crypto/envelope.ts`'s
//! `SignedEnvelope<T>` exactly: `{ payload, keyId, signature }`, signature
//! over the RFC 8785 canonical form of `payload`.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Signer, Verifier};
use serde::{Deserialize, Serialize};

use super::canonical::{to_canonical_bytes, CanonicalError};
use super::keys::{import_private_key, import_public_key, key_id, Ed25519KeyPair};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedEnvelope<T> {
    pub payload: T,
    #[serde(rename = "keyId")]
    pub key_id: String,
    pub signature: String,
}

pub fn sign_envelope<T: Serialize + Clone>(
    payload: T,
    key_pair: &Ed25519KeyPair,
) -> Result<SignedEnvelope<T>, CanonicalError> {
    let bytes = to_canonical_bytes(&payload)?;
    let signing_key = import_private_key(key_pair)?;
    let signature: Signature = signing_key.sign(&bytes);
    Ok(SignedEnvelope {
        payload,
        key_id: key_id(&key_pair.public_key_raw),
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    })
}

/// `expected_public_key_raw` is the caller's own source of truth for which
/// key ought to have signed this — `envelope.key_id` is only ever a lookup
/// hint, never itself the basis for trust (mirrors the server's identical
/// caveat in `verifySignedEnvelope`). Returns `false` (never propagates an
/// error) for any malformed input — a verification failure and a malformed
/// envelope are the same outcome to a caller: don't trust this.
pub fn verify_signed_envelope<T: Serialize>(
    envelope: &SignedEnvelope<T>,
    expected_public_key_raw: &str,
) -> bool {
    let attempt = || -> Result<bool, CanonicalError> {
        let bytes = to_canonical_bytes(&envelope.payload)?;
        let verifying_key = import_public_key(expected_public_key_raw)?;
        let sig_bytes = URL_SAFE_NO_PAD
            .decode(&envelope.signature)
            .map_err(|e| CanonicalError::from(e.to_string()))?;
        let sig_arr: [u8; 64] = sig_bytes
            .try_into()
            .map_err(|_| CanonicalError::from("signature must decode to exactly 64 bytes"))?;
        let signature = Signature::from_bytes(&sig_arr);
        Ok(verifying_key.verify(&bytes, &signature).is_ok())
    };
    attempt().unwrap_or(false)
}

/// Replay protection for short-lived signed assertions (device-token
/// exchange, key-binding proof-of-possession — see
/// `server/src/modules/crypto/envelope.ts`'s identical `isFreshTimestamp`).
/// Takes "now" as an explicit parameter rather than reading a system clock
/// internally — freestanding/WASM targets don't all have one, and the core
/// already has a `platform::Clock` seam for this (see architecture plan);
/// this function stays a pure, portable, unit-testable comparison.
pub fn is_fresh_timestamp(iso: &str, window_seconds: i64, now_unix_ms: i64) -> bool {
    match chrono::DateTime::parse_from_rfc3339(iso) {
        Ok(dt) => (now_unix_ms - dt.timestamp_millis()).abs() <= window_seconds * 1000,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::keys::generate_ed25519_keypair;
    use serde_json::json;

    #[test]
    fn signs_and_verifies_round_trip() {
        let pair = generate_ed25519_keypair().unwrap();
        let envelope = sign_envelope(json!({ "kind": "test", "n": 1 }), &pair).unwrap();
        assert!(verify_signed_envelope(&envelope, &pair.public_key_raw));
    }

    #[test]
    fn rejects_wrong_key() {
        let pair = generate_ed25519_keypair().unwrap();
        let other = generate_ed25519_keypair().unwrap();
        let envelope = sign_envelope(json!({ "kind": "test" }), &pair).unwrap();
        assert!(!verify_signed_envelope(&envelope, &other.public_key_raw));
    }

    #[test]
    fn rejects_tampered_payload() {
        let pair = generate_ed25519_keypair().unwrap();
        let mut envelope = sign_envelope(json!({ "kind": "test", "n": 1 }), &pair).unwrap();
        envelope.payload = json!({ "kind": "test", "n": 2 });
        assert!(!verify_signed_envelope(&envelope, &pair.public_key_raw));
    }

    #[test]
    fn timestamp_freshness_window() {
        let now = 1_000_000_000_i64;
        let iso = chrono::DateTime::from_timestamp_millis(now - 30_000)
            .unwrap()
            .to_rfc3339();
        assert!(is_fresh_timestamp(&iso, 60, now));
        assert!(!is_fresh_timestamp(&iso, 10, now));
        assert!(!is_fresh_timestamp("not-a-timestamp", 60, now));
    }
}
