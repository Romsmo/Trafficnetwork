//! The JSON result format every binding returns, in one place: a call gives
//! back `{"ok": <result>}` or `{"error": {"code": "...", "message": "..."}}`,
//! as one string, whatever the language on the other side. A binding that
//! ships its own copy of this would be a binding that can drift, so the C
//! ABI, the browser, Kotlin and Swift all call [`TrafficNetworkClient::call_json`]
//! and only add what is theirs: how a string crosses their boundary, and
//! catching a panic before it reaches the host.

use serde_json::{json, Value};

use super::{code, ApiError, TrafficNetworkClient};

/// `{"error": {"code": …, "message": …}}`.
pub fn error_envelope(error: &ApiError) -> String {
    json!({ "error": { "code": error.code, "message": error.message } }).to_string()
}

/// `{"ok": …}` for a result, [`error_envelope`] for a failure.
pub fn result_envelope(result: Result<Value, ApiError>) -> String {
    match result {
        Ok(value) => json!({ "ok": value }).to_string(),
        Err(error) => error_envelope(&error),
    }
}

/// What a host sees when the library panicked inside a call: an `internal`
/// error, never an unwound panic (which, across an FFI boundary, is
/// undefined behavior). Used by the bindings' `catch_unwind`.
pub fn panic_envelope() -> String {
    error_envelope(&ApiError::new(
        code::INTERNAL,
        "the library hit an internal error (a panic)",
    ))
}

/// Parses a call's arguments: empty (or blank) means "none", otherwise JSON.
pub fn parse_args(args_json: &str) -> Result<Value, ApiError> {
    if args_json.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(args_json).map_err(|e| {
        ApiError::new(
            code::INVALID_ARGUMENT,
            format!("arguments are not JSON: {e}"),
        )
    })
}

impl TrafficNetworkClient {
    /// [`call`](TrafficNetworkClient::call) with JSON in and the result
    /// envelope out — the whole of what a non-Rust binding needs. Never
    /// fails: a bad argument string or a failed call is an error envelope.
    /// Does not catch panics; the binding does, in whatever way its own
    /// boundary needs.
    pub async fn call_json(&self, method: &str, args_json: &str) -> String {
        match parse_args(args_json) {
            Ok(args) => result_envelope(self.call(method, args).await),
            Err(error) => error_envelope(&error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn a_result_is_wrapped_as_ok() {
        let text = result_envelope(Ok(json!({"a": 1})));
        assert_eq!(parsed(&text), json!({"ok": {"a": 1}}));
    }

    #[test]
    fn an_error_is_wrapped_with_code_and_message() {
        let text = result_envelope(Err(ApiError::new(code::NETWORK, "no server")));
        let expected = json!({"error": {"code": "network", "message": "no server"}});
        assert_eq!(parsed(&text), expected);
    }

    #[test]
    fn a_panic_is_an_internal_error() {
        let value = parsed(&panic_envelope());
        assert_eq!(value["error"]["code"], "internal");
    }

    #[test]
    fn blank_arguments_mean_none_and_bad_ones_are_invalid() {
        assert_eq!(parse_args("").unwrap(), Value::Null);
        assert_eq!(parse_args("   ").unwrap(), Value::Null);
        assert_eq!(parse_args(r#"{"lat": 1}"#).unwrap(), json!({"lat": 1}));
        let error = parse_args("{nope").unwrap_err();
        assert_eq!(error.code, code::INVALID_ARGUMENT);
    }
}
