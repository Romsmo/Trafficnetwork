//! Ed25519 keys, mirroring `server/src/modules/crypto/keys.ts`: raw 32-byte
//! keys, base64url-encoded (no padding), not PEM/DER. `private_key_raw` is
//! the raw seed byte string Node's JWK export calls `d` and
//! `ed25519_dalek::SigningKey::from_bytes` expects — the same 32 bytes,
//! not a re-encoding, which is what makes a device's signature verify
//! identically whether checked in Node or here.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use super::canonical::CanonicalError;

#[derive(Debug, Clone)]
pub struct Ed25519KeyPair {
    pub public_key_raw: String,
    pub private_key_raw: String,
}

pub fn generate_ed25519_keypair() -> Result<Ed25519KeyPair, CanonicalError> {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|e| CanonicalError::from(e.to_string()))?;
    let signing_key = SigningKey::from_bytes(&seed);
    let public_bytes = signing_key.verifying_key().to_bytes();
    Ok(Ed25519KeyPair {
        public_key_raw: URL_SAFE_NO_PAD.encode(public_bytes),
        private_key_raw: URL_SAFE_NO_PAD.encode(seed),
    })
}

pub fn import_private_key(pair: &Ed25519KeyPair) -> Result<SigningKey, CanonicalError> {
    let seed_bytes = URL_SAFE_NO_PAD
        .decode(&pair.private_key_raw)
        .map_err(|e| CanonicalError::from(e.to_string()))?;
    let seed: [u8; 32] = seed_bytes
        .try_into()
        .map_err(|_| CanonicalError::from("private key must decode to exactly 32 bytes"))?;
    Ok(SigningKey::from_bytes(&seed))
}

pub fn import_public_key(public_key_raw: &str) -> Result<VerifyingKey, CanonicalError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(public_key_raw)
        .map_err(|e| CanonicalError::from(e.to_string()))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| CanonicalError::from("public key must decode to exactly 32 bytes"))?;
    VerifyingKey::from_bytes(&arr).map_err(|e| CanonicalError::from(e.to_string()))
}

/// Short (16 hex char) fingerprint used as a lookup hint in signed payloads
/// — not a security boundary; a signature is only ever trusted after
/// verifying against the actual stored/configured public key a keyId points
/// at, never against the keyId string itself. Hashes the base64url *string*
/// form of the public key (UTF-8 bytes of that string), matching
/// `server/src/modules/crypto/keys.ts`'s `keyId()` exactly — not the raw
/// 32 key bytes.
pub fn key_id(public_key_raw: &str) -> String {
    let digest = Sha256::digest(public_key_raw.as_bytes());
    hex::encode(digest)[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_keypair_round_trips_through_import() {
        let pair = generate_ed25519_keypair().unwrap();
        assert!(import_private_key(&pair).is_ok());
        assert!(import_public_key(&pair.public_key_raw).is_ok());
    }

    #[test]
    fn key_id_is_16_lowercase_hex_chars() {
        let pair = generate_ed25519_keypair().unwrap();
        let id = key_id(&pair.public_key_raw);
        assert_eq!(id.len(), 16);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }
}
