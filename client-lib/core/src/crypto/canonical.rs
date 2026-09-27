//! RFC 8785 (JSON Canonicalization Scheme) — must produce byte-identical
//! output to the server's `canonicalize` npm package (see
//! `server/src/modules/crypto/canonical.ts`) for the same logical payload,
//! or cross-signed data won't verify across languages. Verified against the
//! server by a cross-language test vector, not just self-consistency here.

use serde::Serialize;
use serde_json_canonicalizer::to_string as canonicalize_to_string;

pub type CanonicalError = Box<dyn std::error::Error + Send + Sync>;

pub fn to_canonical_json<T: Serialize>(payload: &T) -> Result<String, CanonicalError> {
    // Converted to a plain string message rather than boxing the crate's own
    // error type directly — sidesteps needing that type to satisfy
    // Send + Sync + 'static, which isn't part of its documented contract.
    canonicalize_to_string(payload).map_err(|e| CanonicalError::from(e.to_string()))
}

pub fn to_canonical_bytes<T: Serialize>(payload: &T) -> Result<Vec<u8>, CanonicalError> {
    to_canonical_json(payload).map(|s| s.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_keys_and_strips_whitespace() {
        let value = json!({ "c": 120, "b": false, "a": "Hello!" });
        assert_eq!(
            to_canonical_json(&value).unwrap(),
            r#"{"a":"Hello!","b":false,"c":120}"#
        );
    }
}
