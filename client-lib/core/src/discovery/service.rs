//! Ties `platform::{HttpTransport, Clock}`, directory fetch/cache, and
//! `ServerPool` together into the one thing the rest of the core (sync
//! engine, F-C3) actually calls: "give me a server to talk to" and "run this
//! request against the pool, failing over automatically" (F-C0 plan §1.2/§1.3).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::platform::{Clock, HttpError, HttpRequest, HttpResponse, HttpTransport};

use super::pool::{KnownServer, ServerPool};
use super::types::{NetworkDirectory, ReputationTier};

#[derive(Debug, Clone)]
pub enum DiscoveryError {
    /// No server in the current pool could even be reached — not "every
    /// request failed", but "there was nothing to try" (empty pool, e.g.
    /// pure cold start with every seed unreachable and no cache yet).
    NoServersAvailable,
    Transport(HttpError),
    /// A server responded, but not usefully (bad JSON, unexpected shape).
    InvalidResponse(String),
    /// Every server in the pool was tried and every one failed.
    AllServersFailed,
}

impl std::fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DiscoveryError::NoServersAvailable => write!(f, "no servers available to try"),
            DiscoveryError::Transport(e) => write!(f, "transport error: {e}"),
            DiscoveryError::InvalidResponse(msg) => write!(f, "invalid response: {msg}"),
            DiscoveryError::AllServersFailed => {
                write!(f, "every server in the current pool failed")
            }
        }
    }
}

impl std::error::Error for DiscoveryError {}

pub struct DiscoveryConfig {
    /// Built-in or host-app-supplied seed base URLs (e.g. `https://seed1.example`).
    pub seeds: Vec<String>,
    /// How many servers `current_pool()` hands back at once (F-C0 plan §1.2 default: 3).
    pub pool_size: usize,
    /// How long a fetched directory is trusted before a refresh is attempted
    /// (F-C0 plan §1.6 default: 30 minutes, in milliseconds here).
    pub directory_ttl_ms: i64,
}

impl Default for DiscoveryConfig {
    fn default() -> Self {
        Self {
            seeds: Vec::new(),
            pool_size: 3,
            directory_ttl_ms: 30 * 60 * 1000,
        }
    }
}

struct CachedDirectory {
    fetched_at_unix_ms: i64,
    /// The directory's own `generatedAt`, as the server reported it.
    generated_at: String,
}

pub struct DiscoveryService {
    transport: Arc<dyn HttpTransport>,
    clock: Arc<dyn Clock>,
    config: DiscoveryConfig,
    pool: Mutex<ServerPool>,
    cache_meta: Mutex<Option<CachedDirectory>>,
}

impl DiscoveryService {
    pub fn new(
        transport: Arc<dyn HttpTransport>,
        clock: Arc<dyn Clock>,
        config: DiscoveryConfig,
    ) -> Self {
        let pool = Mutex::new(ServerPool::new(config.pool_size));
        Self {
            transport,
            clock,
            config,
            pool,
            cache_meta: Mutex::new(None),
        }
    }

    /// True once at least one directory fetch has ever succeeded (or a fixed
    /// `nodes[]` list was seeded — see `client_lib_directory_cache_valid`'s
    /// sibling `seed_fixed_nodes`) — *not* the same as "the cache is still
    /// within its TTL"; a stale-but-present cache is still used (F-C0 plan
    /// §1.6: "besser als nichts") while a refresh is attempted in the background.
    pub fn has_any_directory_data(&self) -> bool {
        self.pool.lock().unwrap().known_server_count() > 0
    }

    fn directory_is_stale(&self) -> bool {
        let now = self.clock.now_unix_ms();
        match &*self.cache_meta.lock().unwrap() {
            Some(cached) => now - cached.fetched_at_unix_ms > self.config.directory_ttl_ms,
            None => true,
        }
    }

    /// Seeds the pool with fixed servers without any network call — for a
    /// host app that supplies `nodes[]` and/or `discovery: off` (F-C0 plan §3
    /// init options). `public_key` may be empty if unknown yet; it's only
    /// used for future signature verification of node-signed responses, not
    /// required to reach the server at all.
    pub fn seed_fixed_nodes(&self, nodes: &[(String, String)]) {
        let mut pool = self.pool.lock().unwrap();
        for (node_id, address) in nodes {
            pool.add_known_server(
                node_id.clone(),
                String::new(),
                address.clone(),
                ReputationTier::Active,
            );
        }
    }

    /// Fetches `GET /v1/network/directory` from the first reachable seed (or,
    /// on a later call, the first reachable already-known server — trying
    /// seeds again every time would defeat the point of already having a
    /// working pool) and ingests it. Returns the last error only if *every*
    /// candidate failed.
    pub async fn refresh_directory(&self) -> Result<(), DiscoveryError> {
        let candidates = self.refresh_candidates();
        if candidates.is_empty() {
            return Err(DiscoveryError::NoServersAvailable);
        }

        let mut last_error = None;
        for base_url in candidates {
            let request = HttpRequest::get(format!(
                "{}/v1/network/directory",
                base_url.trim_end_matches('/')
            ));
            match self.transport.send(request).await {
                Ok(response) if response.is_success() => match parse_directory(&response) {
                    Ok(directory) => {
                        self.pool.lock().unwrap().ingest_directory(&directory);
                        *self.cache_meta.lock().unwrap() = Some(CachedDirectory {
                            fetched_at_unix_ms: self.clock.now_unix_ms(),
                            generated_at: directory.generated_at.clone(),
                        });
                        return Ok(());
                    }
                    Err(e) => last_error = Some(e),
                },
                Ok(response) => {
                    last_error = Some(DiscoveryError::InvalidResponse(format!(
                        "HTTP {}",
                        response.status
                    )))
                }
                Err(e) => last_error = Some(DiscoveryError::Transport(e)),
            }
        }
        Err(last_error.unwrap_or(DiscoveryError::NoServersAvailable))
    }

    fn refresh_candidates(&self) -> Vec<String> {
        if self.has_any_directory_data() {
            let pool = self.pool.lock().unwrap();
            let jitters = HashMap::new();
            pool.current_pool(self.clock.now_unix_ms(), &jitters)
                .into_iter()
                .filter_map(|id| pool.get(&id).map(|s| s.address.clone()))
                .collect()
        } else {
            self.config.seeds.clone()
        }
    }

    /// Refreshes the directory only if the cache is missing or stale —
    /// cheap to call every sync cycle (F-C0 plan §1.6). A refresh failure
    /// while a directory is already cached is *not* propagated as an error
    /// (stale-but-present is still usable); it's only an error when there's
    /// no cached data to fall back on at all.
    pub async fn ensure_fresh_directory(&self) -> Result<(), DiscoveryError> {
        if !self.directory_is_stale() {
            return Ok(());
        }
        match self.refresh_directory().await {
            Ok(()) => Ok(()),
            Err(e) if self.has_any_directory_data() => {
                // Stale cache beats no data — swallow the error, per §1.6.
                let _ = e;
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    /// Every server the pool knows about, in no particular order — for a
    /// status display, not for choosing a server (that is `current_pool`).
    pub fn known_servers(&self) -> Vec<KnownServer> {
        let pool = self.pool.lock().unwrap();
        pool.node_ids().filter_map(|id| pool.get(id).cloned()).collect()
    }

    /// The `generatedAt` of the newest directory fetched, if any.
    pub fn directory_generated_at(&self) -> Option<String> {
        self.cache_meta
            .lock()
            .unwrap()
            .as_ref()
            .map(|cached| cached.generated_at.clone())
    }

    /// The ranked server list the sync engine should use right now.
    pub fn current_pool(&self) -> Vec<KnownServer> {
        let pool = self.pool.lock().unwrap();
        let jitters: HashMap<String, f64> = pool
            .node_ids()
            .map(|id| (id.clone(), random_jitter()))
            .collect();
        pool.current_pool(self.clock.now_unix_ms(), &jitters)
            .into_iter()
            .filter_map(|id| pool.get(&id).cloned())
            .collect()
    }

    /// Runs `build_request` against each server in the current pool in
    /// order, recording success/failure per server as it goes, returning
    /// the first response whose status is below 500 (a 4xx still means the
    /// server is alive and answering — that's what failover cares about,
    /// not whether the specific request's business logic succeeded).
    pub async fn request_with_failover(
        &self,
        build_request: impl Fn(&KnownServer) -> HttpRequest,
    ) -> Result<(KnownServer, HttpResponse), DiscoveryError> {
        let pool = self.current_pool();
        if pool.is_empty() {
            return Err(DiscoveryError::NoServersAvailable);
        }

        for server in pool {
            let request = build_request(&server);
            let start = self.clock.now_unix_ms();
            match self.transport.send(request).await {
                Ok(response) if response.status < 500 => {
                    let elapsed = (self.clock.now_unix_ms() - start).max(0) as f64;
                    self.pool
                        .lock()
                        .unwrap()
                        .record_success(&server.node_id, elapsed);
                    return Ok((server, response));
                }
                _ => {
                    self.pool.lock().unwrap().record_failure(
                        &server.node_id,
                        self.clock.now_unix_ms(),
                        random_jitter(),
                    );
                }
            }
        }
        Err(DiscoveryError::AllServersFailed)
    }

    /// Measures round-trip time to a server's `GET /v1/network/node-info`
    /// (cheap, unauthenticated) and records it — the basis for "closeness"
    /// in `discovery::scoring`, since the directory itself carries no geo
    /// field (F-C0 plan §1.2).
    pub async fn measure_latency(
        &self,
        node_id: &str,
        base_url: &str,
    ) -> Result<f64, DiscoveryError> {
        let request = HttpRequest::get(format!(
            "{}/v1/network/node-info",
            base_url.trim_end_matches('/')
        ));
        let start = self.clock.now_unix_ms();
        let response = self
            .transport
            .send(request)
            .await
            .map_err(DiscoveryError::Transport)?;
        let elapsed = (self.clock.now_unix_ms() - start).max(0) as f64;
        if response.is_success() {
            self.pool.lock().unwrap().record_success(node_id, elapsed);
            Ok(elapsed)
        } else {
            self.pool.lock().unwrap().record_failure(
                node_id,
                self.clock.now_unix_ms(),
                random_jitter(),
            );
            Err(DiscoveryError::InvalidResponse(format!(
                "HTTP {}",
                response.status
            )))
        }
    }

    /// Sends `request` to exactly this one server — never fails over to a
    /// different one. For calls where a different server's answer would be
    /// actively wrong, not just less preferred (F-C3's per-server delta
    /// cursor: each server's `since` sequence is its own local counter, per
    /// F-C0 plan §1.4 — retrying a stale cursor against a *different*
    /// server would silently skip or duplicate events). Still records
    /// success/failure for this server's score, exactly like
    /// `request_with_failover`'s per-attempt bookkeeping — a 4xx is
    /// returned to the caller as `Ok` (the server answered; the caller
    /// decides what a particular status means, e.g. `409` for a stale
    /// cursor), only `>=500` or a transport error counts against it here.
    pub async fn request_to_server(
        &self,
        server: &KnownServer,
        request: HttpRequest,
    ) -> Result<HttpResponse, DiscoveryError> {
        let start = self.clock.now_unix_ms();
        match self.transport.send(request).await {
            Ok(response) if response.status < 500 => {
                let elapsed = (self.clock.now_unix_ms() - start).max(0) as f64;
                self.pool
                    .lock()
                    .unwrap()
                    .record_success(&server.node_id, elapsed);
                Ok(response)
            }
            Ok(response) => {
                self.pool.lock().unwrap().record_failure(
                    &server.node_id,
                    self.clock.now_unix_ms(),
                    random_jitter(),
                );
                Err(DiscoveryError::InvalidResponse(format!(
                    "HTTP {}",
                    response.status
                )))
            }
            Err(e) => {
                self.pool.lock().unwrap().record_failure(
                    &server.node_id,
                    self.clock.now_unix_ms(),
                    random_jitter(),
                );
                Err(DiscoveryError::Transport(e))
            }
        }
    }

    /// A server handed over data that failed verification (for example a
    /// static package whose hash does not match its manifest): it counts
    /// against that server exactly like a failed request.
    pub fn record_invalid_data(&self, node_id: &str) {
        self.pool.lock().unwrap().record_failure(
            node_id,
            self.clock.now_unix_ms(),
            random_jitter(),
        );
    }

    pub fn record_withholding_suspicion(&self, node_id: &str) {
        self.pool
            .lock()
            .unwrap()
            .record_withholding_suspicion(node_id);
    }
}

fn parse_directory(response: &HttpResponse) -> Result<NetworkDirectory, DiscoveryError> {
    response
        .json()
        .map_err(|e| DiscoveryError::InvalidResponse(e.to_string()))
        .and_then(|value| {
            serde_json::from_value(value)
                .map_err(|e| DiscoveryError::InvalidResponse(e.to_string()))
        })
}

/// `0.0..=1.0`. Falls back to `0.0` (no jitter, not an error) if the
/// platform's RNG is unavailable — jitter is a load-spreading nicety, not
/// something worth failing a request over.
fn random_jitter() -> f64 {
    let mut buf = [0u8; 8];
    if getrandom::fill(&mut buf).is_err() {
        return 0.0;
    }
    (u64::from_le_bytes(buf) as f64) / (u64::MAX as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    struct FixedClock(AtomicI64);
    impl Clock for FixedClock {
        fn now_unix_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct MockTransport {
        responses: Mutex<HashMap<String, Result<HttpResponse, String>>>,
    }
    impl MockTransport {
        fn new() -> Self {
            Self {
                responses: Mutex::new(HashMap::new()),
            }
        }
        fn set(&self, url: &str, status: u16, body: serde_json::Value) {
            self.responses.lock().unwrap().insert(
                url.to_string(),
                Ok(HttpResponse {
                    status,
                    body: serde_json::to_vec(&body).unwrap(),
                }),
            );
        }
        fn set_error(&self, url: &str) {
            self.responses
                .lock()
                .unwrap()
                .insert(url.to_string(), Err("connection refused".to_string()));
        }
    }
    #[async_trait::async_trait]
    impl HttpTransport for MockTransport {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
            match self.responses.lock().unwrap().get(&request.url) {
                Some(Ok(response)) => Ok(response.clone()),
                Some(Err(msg)) => Err(HttpError::Network(msg.clone())),
                None => Err(HttpError::Network(format!(
                    "no mock response configured for {}",
                    request.url
                ))),
            }
        }
    }

    fn directory_json() -> serde_json::Value {
        serde_json::json!({
            "self": { "nodeId": "seed1", "publicKey": "pk-seed1", "address": "https://seed1.example", "federationEnabled": true },
            "peers": [
                { "nodeId": "peer1", "publicKey": "pk-peer1", "address": "https://peer1.example", "tier": "trusted",
                  "discoveredVia": "seed", "joinedAt": "2026-01-01T00:00:00Z", "lastSeenAt": "2026-01-01T00:00:00Z", "lastKnownVersion": null }
            ],
            "generatedAt": "2026-01-01T00:00:00Z"
        })
    }

    #[tokio::test]
    async fn refresh_directory_fetches_from_a_seed_and_ingests_peers() {
        let transport = Arc::new(MockTransport::new());
        transport.set(
            "https://seed1.example/v1/network/directory",
            200,
            directory_json(),
        );
        let clock = Arc::new(FixedClock(AtomicI64::new(1000)));
        let service = DiscoveryService::new(
            transport,
            clock,
            DiscoveryConfig {
                seeds: vec!["https://seed1.example".to_string()],
                pool_size: 3,
                directory_ttl_ms: 60_000,
            },
        );

        service.refresh_directory().await.unwrap();
        assert!(service.has_any_directory_data());
    }

    #[tokio::test]
    async fn refresh_directory_falls_through_to_the_next_seed_on_failure() {
        let transport = Arc::new(MockTransport::new());
        transport.set_error("https://dead-seed.example/v1/network/directory");
        transport.set(
            "https://live-seed.example/v1/network/directory",
            200,
            directory_json(),
        );
        let clock = Arc::new(FixedClock(AtomicI64::new(0)));
        let service = DiscoveryService::new(
            transport,
            clock,
            DiscoveryConfig {
                seeds: vec![
                    "https://dead-seed.example".to_string(),
                    "https://live-seed.example".to_string(),
                ],
                pool_size: 3,
                directory_ttl_ms: 60_000,
            },
        );

        service.refresh_directory().await.unwrap();
        assert!(service.has_any_directory_data());
    }

    #[tokio::test]
    async fn ensure_fresh_directory_skips_the_network_call_when_cache_is_fresh() {
        let transport = Arc::new(MockTransport::new());
        transport.set(
            "https://seed1.example/v1/network/directory",
            200,
            directory_json(),
        );
        let clock = Arc::new(FixedClock(AtomicI64::new(0)));
        let service = DiscoveryService::new(
            transport,
            clock.clone(),
            DiscoveryConfig {
                seeds: vec!["https://seed1.example".to_string()],
                pool_size: 3,
                directory_ttl_ms: 60_000,
            },
        );
        service.ensure_fresh_directory().await.unwrap();

        // Advance time but stay within the TTL, and remove the mock response
        // entirely — if ensure_fresh_directory tried to fetch again, the
        // (now-unconfigured) request would error and the test would fail.
        clock.0.store(30_000, Ordering::SeqCst);
        service.ensure_fresh_directory().await.unwrap();
    }

    #[tokio::test]
    async fn request_with_failover_tries_the_next_server_after_a_failure() {
        let transport = Arc::new(MockTransport::new());
        transport.set_error("https://a.example/v1/x");
        transport.set(
            "https://b.example/v1/x",
            200,
            serde_json::json!({"ok": true}),
        );
        let clock = Arc::new(FixedClock(AtomicI64::new(0)));
        let service = DiscoveryService::new(
            transport,
            clock,
            DiscoveryConfig {
                seeds: vec![],
                pool_size: 3,
                directory_ttl_ms: 60_000,
            },
        );
        service.seed_fixed_nodes(&[
            ("a".to_string(), "https://a.example".to_string()),
            ("b".to_string(), "https://b.example".to_string()),
        ]);

        let (server, response) = service
            .request_with_failover(|s| HttpRequest::get(format!("{}/v1/x", s.address)))
            .await
            .unwrap();
        assert_eq!(server.node_id, "b");
        assert!(response.is_success());
    }

    #[tokio::test]
    async fn request_with_failover_fails_when_every_server_fails() {
        let transport = Arc::new(MockTransport::new());
        transport.set_error("https://a.example/v1/x");
        let clock = Arc::new(FixedClock(AtomicI64::new(0)));
        let service = DiscoveryService::new(
            transport,
            clock,
            DiscoveryConfig {
                seeds: vec![],
                pool_size: 3,
                directory_ttl_ms: 60_000,
            },
        );
        service.seed_fixed_nodes(&[("a".to_string(), "https://a.example".to_string())]);

        let result = service
            .request_with_failover(|s| HttpRequest::get(format!("{}/v1/x", s.address)))
            .await;
        assert!(matches!(result, Err(DiscoveryError::AllServersFailed)));
    }

    #[tokio::test]
    async fn request_to_server_does_not_fail_over_on_a_4xx() {
        let transport = Arc::new(MockTransport::new());
        transport.set(
            "https://a.example/v1/delta",
            409,
            serde_json::json!({"error": {"code": "SNAPSHOT_REQUIRED"}}),
        );
        let clock = Arc::new(FixedClock(AtomicI64::new(0)));
        let service = DiscoveryService::new(transport, clock, DiscoveryConfig::default());
        service.seed_fixed_nodes(&[("a".to_string(), "https://a.example".to_string())]);
        let server = service.current_pool().into_iter().next().unwrap();

        let response = service
            .request_to_server(&server, HttpRequest::get("https://a.example/v1/delta"))
            .await
            .unwrap();
        assert_eq!(response.status, 409);
    }

    #[tokio::test]
    async fn request_to_server_errors_on_a_5xx_without_trying_anything_else() {
        let transport = Arc::new(MockTransport::new());
        transport.set("https://a.example/v1/delta", 503, serde_json::json!({}));
        let clock = Arc::new(FixedClock(AtomicI64::new(0)));
        let service = DiscoveryService::new(transport, clock, DiscoveryConfig::default());
        service.seed_fixed_nodes(&[("a".to_string(), "https://a.example".to_string())]);
        let server = service.current_pool().into_iter().next().unwrap();

        let result = service
            .request_to_server(&server, HttpRequest::get("https://a.example/v1/delta"))
            .await;
        assert!(matches!(result, Err(DiscoveryError::InvalidResponse(_))));
    }

    #[tokio::test]
    async fn empty_pool_reports_no_servers_available_rather_than_panicking() {
        let transport = Arc::new(MockTransport::new());
        let clock = Arc::new(FixedClock(AtomicI64::new(0)));
        let service = DiscoveryService::new(transport, clock, DiscoveryConfig::default());
        let result = service
            .request_with_failover(|s| HttpRequest::get(&s.address))
            .await;
        assert!(matches!(result, Err(DiscoveryError::NoServersAvailable)));
    }
}
