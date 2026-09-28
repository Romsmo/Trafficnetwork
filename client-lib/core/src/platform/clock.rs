//! Time as a seam, not a direct `SystemTime::now()`/`chrono::Utc::now()` call
//! — `wasm32-unknown-unknown` has no system clock without a JS shim, and
//! deterministic tests (backoff timers, directory TTL, signature freshness)
//! need to control "now" directly rather than racing real time.

pub trait Clock: Send + Sync {
    fn now_unix_ms(&self) -> i64;
}

/// Native default — not available on wasm32 (`std::time::SystemTime` isn't
/// meaningful there without a JS shim); a WASM host binding supplies its own
/// `Clock` backed by `Date.now()` instead (see the binding milestone, F-C4).
#[cfg(not(target_arch = "wasm32"))]
pub struct SystemClock;

#[cfg(not(target_arch = "wasm32"))]
impl Clock for SystemClock {
    fn now_unix_ms(&self) -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

/// `wasm32` default (add-on B3) — backed by JS's own `Date.now()`, the one
/// JS shim this crate is allowed to reach for directly rather than through a
/// host-supplied `Clock` (every other platform's default reaches for its own
/// system clock the same way).
#[cfg(target_arch = "wasm32")]
pub struct WasmClock;

#[cfg(target_arch = "wasm32")]
impl Clock for WasmClock {
    fn now_unix_ms(&self) -> i64 {
        js_sys::Date::now() as i64
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    #[test]
    fn system_clock_returns_a_plausible_unix_timestamp() {
        // Sanity bound, not a precise check — catches "returns 0" or
        // "returns seconds instead of milliseconds" class mistakes without
        // hardcoding a specific date.
        let now = SystemClock.now_unix_ms();
        assert!(now > 1_700_000_000_000); // 2023-11-14, far enough in the past
    }
}
