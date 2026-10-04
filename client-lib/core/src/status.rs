//! Network-status snapshot for host apps. Currently carries the "how many
//! are online" figures from `GET /v1/stats/online` (add-on O,
//! `docs/prompt-addon-online-counter.md`) — a public, unauthenticated
//! endpoint that reports the answering node's own count plus an *estimated*
//! network-wide sum.
//!
//! `getNetworkStatus()` (F-C0 plan §3) doesn't exist as a public facade yet
//! — that lands with the API layer in F-C4/F-C5. [`NetworkStatus`] is its
//! first home; the remaining plan fields (known/active nodes, directory and
//! config versions) join it when the facade is assembled. Everything here is
//! additive and every field is optional, so an older server without the
//! endpoint simply leaves them empty.
//!
//! "Never blocking" follows the library's own rule that nothing self-
//! schedules (`platform` module doc): [`OnlineStatusService::network_status`]
//! only reads the cache and never touches the network, while
//! [`OnlineStatusService::refresh`] is what a host app's tick calls — cheap
//! to call every cycle, since it does nothing inside the cache window.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::discovery::DiscoveryService;
use crate::platform::{Clock, HttpRequest};

/// How long a fetched answer is reused (add-on O, part C: "30 seconds").
pub const ONLINE_CACHE_TTL_MS: i64 = 30_000;

/// How long "this server has no such endpoint / has it switched off" is
/// remembered — much longer than [`ONLINE_CACHE_TTL_MS`], since an older
/// server doesn't grow the endpoint mid-session and re-asking every 30
/// seconds would just be wasted requests.
const UNAVAILABLE_TTL_MS: i64 = 5 * 60 * 1000;

/// A count that never reveals a number below the server's display threshold
/// (`minDisplayThreshold`): "fewer than 5 online" says nothing about a
/// single person, "1 online" in a small network would.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OnlineCount {
    Exact(u64),
    /// "Fewer than N" — `N` is the server's `minDisplayThreshold`.
    Below(u32),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct NetworkStatus {
    /// The answering node's own count.
    #[serde(rename = "onlineNode")]
    pub online_node: Option<OnlineCount>,
    /// The network-wide sum. Each node reports only its own figure, so this
    /// is a claim about other nodes, not something this client can verify.
    #[serde(rename = "onlineNetwork")]
    pub online_network: Option<OnlineCount>,
    /// `Some(true)` whenever `online_network` is set — always, regardless of
    /// what the server says: a network sum can only ever be an estimate
    /// (see `online_network`), so a node claiming otherwise isn't believed.
    #[serde(rename = "onlineEstimated")]
    pub online_estimated: Option<bool>,
    /// When the network figure was computed, as the server reports it.
    #[serde(rename = "onlineAsOf")]
    pub online_as_of: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WireCounter {
    online: Option<u64>,
    below: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct WireNetwork {
    online: Option<u64>,
    below: Option<u32>,
    #[serde(rename = "asOf")]
    as_of: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WireOnlineStats {
    enabled: Option<bool>,
    node: Option<WireCounter>,
    network: Option<WireNetwork>,
    #[serde(rename = "minDisplayThreshold")]
    min_display_threshold: Option<u32>,
}

/// Even an exact number the server sends is folded into `Below` when it's
/// under the threshold — the privacy guarantee shouldn't hinge on every
/// server implementation getting that right.
fn to_count(
    online: Option<u64>,
    below: Option<u32>,
    threshold: Option<u32>,
) -> Option<OnlineCount> {
    match online {
        Some(n) => match threshold {
            Some(t) if n < u64::from(t) => Some(OnlineCount::Below(t)),
            _ => Some(OnlineCount::Exact(n)),
        },
        None => below.or(threshold).map(OnlineCount::Below),
    }
}

/// `None` for anything that isn't a usable answer: `{"enabled": false}`, a
/// body of an unexpected shape, or one carrying no figure at all.
pub(crate) fn parse_online_stats(value: &serde_json::Value) -> Option<NetworkStatus> {
    let wire = WireOnlineStats::deserialize(value).ok()?;
    if wire.enabled == Some(false) {
        return None;
    }
    let threshold = wire.min_display_threshold;
    let online_node = wire
        .node
        .and_then(|n| to_count(n.online, n.below, threshold));
    let (online_network, online_as_of) = match wire.network {
        Some(n) => (to_count(n.online, n.below, threshold), n.as_of),
        None => (None, None),
    };
    if online_node.is_none() && online_network.is_none() {
        return None;
    }
    Some(NetworkStatus {
        online_node,
        online_network,
        online_estimated: online_network.map(|_| true),
        online_as_of,
    })
}

struct State {
    status: NetworkStatus,
    next_attempt_unix_ms: i64,
}

enum Fetch {
    Available(NetworkStatus),
    /// The server has no such endpoint, has the feature switched off, or
    /// answered with something unusable — not an error, just "no figures".
    Unavailable,
    /// Transport failure or a transient status (`429`, `5xx`): keep the last
    /// known figures and try again after the normal cache window.
    Failed,
}

pub struct OnlineStatusService {
    discovery: Arc<DiscoveryService>,
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
}

impl OnlineStatusService {
    pub fn new(discovery: Arc<DiscoveryService>, clock: Arc<dyn Clock>) -> Self {
        Self {
            discovery,
            clock,
            state: Mutex::new(State {
                status: NetworkStatus::default(),
                next_attempt_unix_ms: 0,
            }),
        }
    }

    /// The last fetched figures, or an all-empty status if there are none
    /// (yet, or because the server doesn't offer them). Never touches the
    /// network.
    pub fn network_status(&self) -> NetworkStatus {
        self.state.lock().unwrap().status.clone()
    }

    /// Fetches `GET /v1/stats/online` if the cache window has passed — a
    /// no-op otherwise, so it's safe to call on every host-app tick. Never
    /// fails: whatever goes wrong is reflected only in what
    /// [`network_status`](Self::network_status) returns next.
    pub async fn refresh(&self) {
        let now = self.clock.now_unix_ms();
        {
            let mut state = self.state.lock().unwrap();
            if now < state.next_attempt_unix_ms {
                return;
            }
            // Claimed up front: doubles as the retry delay after a failure,
            // and makes a concurrent second `refresh` a no-op.
            state.next_attempt_unix_ms = now + ONLINE_CACHE_TTL_MS;
        }

        let outcome = self.fetch().await;
        let mut state = self.state.lock().unwrap();
        match outcome {
            Fetch::Available(status) => state.status = status,
            Fetch::Unavailable => {
                state.status = NetworkStatus::default();
                state.next_attempt_unix_ms = now + UNAVAILABLE_TTL_MS;
            }
            Fetch::Failed => {}
        }
    }

    async fn fetch(&self) -> Fetch {
        let result = self
            .discovery
            .request_with_failover(|server| {
                let url = format!("{}/v1/stats/online", server.address.trim_end_matches('/'));
                HttpRequest::get(url)
            })
            .await;
        let response = match result {
            Ok((_, response)) => response,
            Err(_) => return Fetch::Failed,
        };
        if !response.is_success() {
            return match response.status {
                401 | 403 | 404 | 405 | 410 => Fetch::Unavailable,
                _ => Fetch::Failed,
            };
        }
        match response.json().ok().as_ref().and_then(parse_online_stats) {
            Some(status) => Fetch::Available(status),
            None => Fetch::Unavailable,
        }
    }
}

// Native-only: uses `#[tokio::test]`, which needs a real tokio runtime.
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::discovery::DiscoveryConfig;
    use crate::platform::{HttpError, HttpResponse, HttpTransport};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    struct FixedClock(AtomicI64);
    impl Clock for FixedClock {
        fn now_unix_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct MockTransport {
        responses: Mutex<HashMap<String, Result<HttpResponse, String>>>,
        requests: AtomicUsize,
    }
    impl MockTransport {
        fn new() -> Self {
            Self {
                responses: Mutex::new(HashMap::new()),
                requests: AtomicUsize::new(0),
            }
        }
        fn set(&self, status: u16, body: serde_json::Value) {
            self.set_raw(status, serde_json::to_vec(&body).unwrap());
        }
        fn set_raw(&self, status: u16, body: Vec<u8>) {
            self.responses
                .lock()
                .unwrap()
                .insert(URL.to_string(), Ok(HttpResponse { status, body }));
        }
        fn set_error(&self) {
            self.responses
                .lock()
                .unwrap()
                .insert(URL.to_string(), Err("connection refused".to_string()));
        }
        fn request_count(&self) -> usize {
            self.requests.load(Ordering::SeqCst)
        }
    }
    #[async_trait::async_trait]
    impl HttpTransport for MockTransport {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            match self.responses.lock().unwrap().get(&request.url) {
                Some(Ok(response)) => Ok(response.clone()),
                Some(Err(msg)) => Err(HttpError::Network(msg.clone())),
                None => Err(HttpError::Network(format!(
                    "no mock response for {}",
                    request.url
                ))),
            }
        }
    }

    const URL: &str = "https://a.example/v1/stats/online";

    struct Fixture {
        service: OnlineStatusService,
        transport: Arc<MockTransport>,
        clock: Arc<FixedClock>,
    }

    fn fixture() -> Fixture {
        let transport = Arc::new(MockTransport::new());
        let clock = Arc::new(FixedClock(AtomicI64::new(1_000)));
        let discovery = Arc::new(DiscoveryService::new(
            transport.clone(),
            clock.clone(),
            DiscoveryConfig::default(),
        ));
        discovery.seed_fixed_nodes(&[("node1".to_string(), "https://a.example".to_string())]);
        let service = OnlineStatusService::new(discovery, clock.clone());
        Fixture {
            service,
            transport,
            clock,
        }
    }

    fn advance(fixture: &Fixture, ms: i64) {
        fixture.clock.0.fetch_add(ms, Ordering::SeqCst);
    }

    fn full_response(node: u64, network: u64) -> serde_json::Value {
        serde_json::json!({
            "node": { "online": node, "windowSeconds": 300 },
            "network": {
                "online": network,
                "nodes": 4,
                "estimated": true,
                "asOf": "2026-09-24T10:00:00Z"
            },
            "minDisplayThreshold": 5
        })
    }

    #[test]
    fn network_status_never_touches_the_network() {
        let f = fixture();
        assert_eq!(f.service.network_status(), NetworkStatus::default());
        assert_eq!(f.transport.request_count(), 0);
    }

    #[tokio::test]
    async fn refresh_fills_all_fields_from_a_full_response() {
        let f = fixture();
        f.transport.set(200, full_response(12, 87));

        f.service.refresh().await;

        assert_eq!(
            f.service.network_status(),
            NetworkStatus {
                online_node: Some(OnlineCount::Exact(12)),
                online_network: Some(OnlineCount::Exact(87)),
                online_estimated: Some(true),
                online_as_of: Some("2026-09-24T10:00:00Z".to_string()),
            }
        );
    }

    #[tokio::test]
    async fn a_server_reported_below_threshold_stays_below() {
        let f = fixture();
        f.transport.set(
            200,
            serde_json::json!({
                "node": { "online": null, "below": 5 },
                "network": { "online": null, "below": 5, "asOf": "2026-09-24T10:00:00Z" },
                "minDisplayThreshold": 5
            }),
        );

        f.service.refresh().await;

        let status = f.service.network_status();
        assert_eq!(status.online_node, Some(OnlineCount::Below(5)));
        assert_eq!(status.online_network, Some(OnlineCount::Below(5)));
    }

    #[tokio::test]
    async fn an_exact_number_under_the_threshold_is_never_passed_on() {
        let f = fixture();
        f.transport.set(200, full_response(3, 4));

        f.service.refresh().await;

        let status = f.service.network_status();
        assert_eq!(status.online_node, Some(OnlineCount::Below(5)));
        assert_eq!(status.online_network, Some(OnlineCount::Below(5)));
    }

    #[tokio::test]
    async fn the_network_figure_is_always_estimated_whatever_the_node_claims() {
        let f = fixture();
        f.transport.set(
            200,
            serde_json::json!({
                "node": { "online": 10 },
                "network": { "online": 90, "estimated": false },
                "minDisplayThreshold": 5
            }),
        );

        f.service.refresh().await;

        assert_eq!(f.service.network_status().online_estimated, Some(true));
    }

    #[tokio::test]
    async fn a_node_without_federation_reports_no_network_figure() {
        let f = fixture();
        f.transport.set(
            200,
            serde_json::json!({
                "node": { "online": 10, "windowSeconds": 300 },
                "minDisplayThreshold": 5
            }),
        );

        f.service.refresh().await;

        let status = f.service.network_status();
        assert_eq!(status.online_node, Some(OnlineCount::Exact(10)));
        assert_eq!(status.online_network, None);
        assert_eq!(status.online_estimated, None);
        assert_eq!(status.online_as_of, None);
    }

    #[tokio::test]
    async fn a_missing_endpoint_leaves_the_fields_empty_and_is_not_asked_again_soon() {
        let f = fixture();
        f.transport.set(404, serde_json::json!({}));

        f.service.refresh().await;
        assert_eq!(f.service.network_status(), NetworkStatus::default());
        assert_eq!(f.transport.request_count(), 1);

        advance(&f, 60_000);
        f.service.refresh().await;
        assert_eq!(f.transport.request_count(), 1);

        advance(&f, 5 * 60 * 1000);
        f.service.refresh().await;
        assert_eq!(f.transport.request_count(), 2);
    }

    #[tokio::test]
    async fn a_disabled_feature_leaves_the_fields_empty() {
        let f = fixture();
        f.transport
            .set(200, serde_json::json!({ "enabled": false }));

        f.service.refresh().await;

        assert_eq!(f.service.network_status(), NetworkStatus::default());
    }

    #[tokio::test]
    async fn an_unparseable_answer_is_treated_as_unavailable_not_as_an_error() {
        let f = fixture();
        f.transport.set_raw(200, b"<html>not json</html>".to_vec());

        f.service.refresh().await;

        assert_eq!(f.service.network_status(), NetworkStatus::default());
    }

    #[tokio::test]
    async fn the_cache_is_respected_and_expires_after_the_ttl() {
        let f = fixture();
        f.transport.set(200, full_response(10, 50));

        f.service.refresh().await;
        f.service.refresh().await;
        assert_eq!(f.transport.request_count(), 1);

        advance(&f, 29_000);
        f.service.refresh().await;
        assert_eq!(f.transport.request_count(), 1);

        f.transport.set(200, full_response(20, 60));
        advance(&f, 2_000);
        f.service.refresh().await;
        assert_eq!(f.transport.request_count(), 2);
        assert_eq!(
            f.service.network_status().online_node,
            Some(OnlineCount::Exact(20))
        );
    }

    #[tokio::test]
    async fn a_transient_failure_keeps_the_last_known_figures() {
        let f = fixture();
        f.transport.set(200, full_response(10, 50));
        f.service.refresh().await;

        advance(&f, 31_000);
        f.transport.set_error();
        f.service.refresh().await;
        assert_eq!(f.transport.request_count(), 2);
        assert_eq!(
            f.service.network_status().online_node,
            Some(OnlineCount::Exact(10))
        );

        // Retried only after the normal cache window, not on every tick.
        f.service.refresh().await;
        assert_eq!(f.transport.request_count(), 2);
    }
}
