//! Thin C-ABI surface over `trafficnetwork-core`.
//!
//! * [`client`]: the client API — `tn_client_new`, `tn_client_call`, ... — the
//!   one every language binding wraps (see there).
//! * this file: the crypto helpers (F-C1) — key generation, signing and
//!   verifying a signed envelope — kept for tools that need them on their own.
//!
//! Every function that hands a string back to the caller allocates it with
//! `CString::into_raw`; the caller must free it with `tn_free_string` — never
//! with the host language's own `free()`, since Rust's global allocator
//! isn't guaranteed to be the same one. JSON-in/JSON-out at the boundary
//! (rather than hand-marshaled structs) keeps the surface small and lets
//! every binding reuse the same `serde`-derived shapes `core` already
//! defines.
//!
//! Header generation: `cbindgen --config cbindgen.toml --output trafficnetwork.h`
//! (see `cbindgen.toml` in this directory), wired into CI.

mod client;

use std::ffi::{c_char, CStr, CString};

use serde_json::{json, Value};
use trafficnetwork_core::crypto::{
    generate_ed25519_keypair, sign_envelope, verify_signed_envelope, Ed25519KeyPair, SignedEnvelope,
};

fn cstr_to_string(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    // Safety: caller must pass a valid null-terminated C string it still
    // owns for the duration of this call — the standard extern "C" contract
    // for every function in this module that takes a `*const c_char`.
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .ok()
        .map(str::to_owned)
}

fn string_to_cstring(s: String) -> *mut c_char {
    CString::new(s)
        .unwrap_or_else(|_| {
            CString::new("{\"error\":\"internal: string contained a NUL byte\"}").unwrap()
        })
        .into_raw()
}

fn error_json(message: &str) -> *mut c_char {
    string_to_cstring(json!({ "error": message }).to_string())
}

/// Frees a string previously returned by any `tn_*` function in this crate.
/// Safe to call with NULL (no-op).
///
/// # Safety
/// `s` must be NULL or a pointer this crate itself returned via
/// `CString::into_raw`, and must not be passed to this function more than
/// once.
#[no_mangle]
pub unsafe extern "C" fn tn_free_string(s: *mut c_char) {
    if s.is_null() {
        return;
    }
    // Safety: reclaims a CString this crate itself allocated via
    // `into_raw()` — the caller's obligation is only to pass back exactly
    // such a pointer, exactly once.
    unsafe {
        drop(CString::from_raw(s));
    }
}

/// Returns `{"publicKey": "...", "privateKey": "..."}` (base64url, see
/// `core::crypto::keys`), or `{"error": "..."}` on failure (e.g. no secure
/// RNG available on this platform). Caller frees the result.
#[no_mangle]
pub extern "C" fn tn_generate_keypair() -> *mut c_char {
    match generate_ed25519_keypair() {
        Ok(pair) => string_to_cstring(
            json!({ "publicKey": pair.public_key_raw, "privateKey": pair.private_key_raw })
                .to_string(),
        ),
        Err(e) => error_json(&e.to_string()),
    }
}

/// Signs `payload_json` (any JSON value) with the given keypair, returning a
/// serialized `SignedEnvelope` JSON string, or `{"error": "..."}`. Caller
/// frees the result.
///
/// # Safety
/// Every argument must be NULL or a valid null-terminated C string owned by
/// the caller for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn tn_sign_envelope(
    public_key: *const c_char,
    private_key: *const c_char,
    payload_json: *const c_char,
) -> *mut c_char {
    let (Some(public_key_raw), Some(private_key_raw), Some(payload_str)) = (
        cstr_to_string(public_key),
        cstr_to_string(private_key),
        cstr_to_string(payload_json),
    ) else {
        return error_json("invalid UTF-8 or NULL argument");
    };
    let payload: Value = match serde_json::from_str(&payload_str) {
        Ok(v) => v,
        Err(e) => return error_json(&format!("invalid payload JSON: {e}")),
    };
    let pair = Ed25519KeyPair {
        public_key_raw,
        private_key_raw,
    };
    match sign_envelope(payload, &pair) {
        Ok(envelope) => match serde_json::to_string(&envelope) {
            Ok(s) => string_to_cstring(s),
            Err(e) => error_json(&e.to_string()),
        },
        Err(e) => error_json(&e.to_string()),
    }
}

/// Verifies a `SignedEnvelope` JSON string against a public key. Returns 1
/// (verified), 0 (not verified — including any malformed input, which is
/// treated identically to "don't trust this", matching
/// `core::crypto::verify_signed_envelope`'s own contract).
///
/// # Safety
/// Every argument must be NULL or a valid null-terminated C string owned by
/// the caller for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn tn_verify_envelope(
    public_key: *const c_char,
    envelope_json: *const c_char,
) -> i32 {
    let (Some(public_key_raw), Some(envelope_str)) =
        (cstr_to_string(public_key), cstr_to_string(envelope_json))
    else {
        return 0;
    };
    let envelope: SignedEnvelope<Value> = match serde_json::from_str(&envelope_str) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    i32::from(verify_signed_envelope(&envelope, &public_key_raw))
}
