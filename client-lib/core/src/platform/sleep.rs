//! `Sleep`: the "wait this long" seam, alongside `Clock`'s "what time is
//! it". Only the realtime reconnect loop (`api::client::run_realtime`)
//! needs to actually wait between attempts — everything else in the core
//! either polls on demand (`tick()`) or is a single request/response, so
//! this is deliberately not part of `Clock` itself. A test supplies a
//! `Sleep` that returns at once (optionally recording what was asked for),
//! so a backoff test runs in milliseconds, not minutes.

#[async_trait::async_trait]
pub trait Sleep: Send + Sync {
    async fn sleep_ms(&self, duration_ms: u64);
}

/// Native default — not available on `wasm32` (no thread to block/no Tokio
/// timer without a JS event-loop bridge); a WASM host binding supplies its
/// own `Sleep` backed by `gloo-timers` or `Window.setTimeout` instead (F-C4).
#[cfg(not(target_arch = "wasm32"))]
pub struct TokioSleeper;

#[cfg(not(target_arch = "wasm32"))]
#[async_trait::async_trait]
impl Sleep for TokioSleeper {
    async fn sleep_ms(&self, duration_ms: u64) {
        tokio::time::sleep(std::time::Duration::from_millis(duration_ms)).await;
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn tokio_sleeper_actually_waits() {
        let start = std::time::Instant::now();
        TokioSleeper.sleep_ms(10).await;
        assert!(start.elapsed().as_millis() >= 10);
    }
}
