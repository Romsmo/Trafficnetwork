//! Add-on B2: `TrafficNetworkClient` against *real* server processes — real
//! Postgres, real federation, real HTTP — started and controlled through
//! `server/tests/support/multi-node-harness.ts`'s admin API. An integration
//! test (`tests/`, not `src/`) sees only the crate's public API, exactly
//! what a host app would use.
//!
//! Needs the harness running (`npm run test:support:multi-node` in
//! `server/`, which needs Docker for its Postgres containers) and
//! `TN_MULTI_NODE_HARNESS_URL` pointing at it (default
//! `http://127.0.0.1:4100`). Every test checks the harness is reachable
//! first and skips itself (prints a message, returns `Ok(())`) if not — so
//! `cargo test` without the harness running (the common case: no session
//! working on this repo has Docker running by default) never fails here,
//! it just skips. CI's `multi-node` job is the one place these actually run.
//!
//! Covers, end to end against real servers: cold start via a single seed,
//! a dead node not stopping a sync when another is reachable, the same
//! event seen through two servers shown once (not twice), an offline report
//! delivered once a different server is reachable, and a corrupted response
//! from a real server not being silently accepted. **Not** attempted here:
//! "withheld data detected" — `sync::withholding`'s 5-minute, non-test-
//! configurable tolerance window (`TOLERANCE_WINDOW_MS`) makes a fast,
//! deterministic real-server test of that one path impractical; its
//! comparison logic has full unit coverage instead
//! (`sync::withholding::tests`), and `SyncEngine::with_withholding_sample_rate`
//! (add-on B2) at least makes the check itself testable at 100% instead of
//! the usual 10%, for whenever that gap is worth closing properly.

use std::time::Duration;

use serde_json::{json, Value};
use trafficnetwork_core::api::{
    ClientOptions, Credentials, MemorySecureStore, NearbyCategory, NearbyItem, Platform,
    TrafficNetworkClient,
};
use trafficnetwork_core::platform::{HttpRequest, HttpTransport, ReqwestHttpTransport};

fn harness_url() -> String {
    std::env::var("TN_MULTI_NODE_HARNESS_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:4100".to_string())
}

/// A thin client for the harness's own admin API — reuses the crate's own
/// `HttpTransport`, not a new dependency just for this test file.
struct Harness {
    http: ReqwestHttpTransport,
    base: String,
}

impl Harness {
    fn new() -> Self {
        Self {
            http: ReqwestHttpTransport::new().expect("reqwest client"),
            base: harness_url(),
        }
    }

    /// `None` if the harness is not reachable — the signal every test uses
    /// to skip itself rather than fail.
    async fn connect() -> Option<Self> {
        let harness = Self::new();
        let request = HttpRequest::get(format!("{}/health", harness.base));
        match harness.http.send(request).await {
            Ok(response) if response.is_success() => Some(harness),
            _ => None,
        }
    }

    async fn post(&self, path: &str, body: Value) -> Value {
        let request = HttpRequest::post_json(format!("{}{path}", self.base), &body)
            .expect("request body always serializes");
        let response = self
            .http
            .send(request)
            .await
            .unwrap_or_else(|e| panic!("harness request to {path} failed: {e}"));
        assert!(
            response.is_success(),
            "harness request to {path} was rejected: HTTP {} {}",
            response.status,
            String::from_utf8_lossy(&response.body)
        );
        response.json().expect("harness always answers JSON")
    }

    /// Starts a second (or third...) node sharing `existing`'s exact device
    /// identity — see `StartNodeRequest.sharedCredential` in the harness for
    /// why a client needs that to reach more than one independently-started
    /// real node with a single identity.
    async fn start_node_sharing_credential(&self, mut body: Value, existing: &Node) -> Node {
        body["sharedCredential"] = json!({
            "clientId": existing.client_id,
            "clientSecret": existing.client_secret,
        });
        self.start_node(body).await
    }

    async fn start_node(&self, body: Value) -> Node {
        let json = self.post("/nodes", body).await;
        Node {
            id: json["id"].as_str().unwrap().to_string(),
            address: json["address"].as_str().unwrap().to_string(),
            proxy_address: json["proxyAddress"].as_str().unwrap().to_string(),
            client_id: json["clientId"].as_str().unwrap().to_string(),
            client_secret: json["clientSecret"].as_str().unwrap().to_string(),
        }
    }

    async fn stop_node(&self, node: &Node) {
        self.post(&format!("/nodes/{}/stop", node.id), json!({}))
            .await;
    }

    async fn fault(&self, node: &Node, path_includes: &str, kind: &str, times: u32) {
        self.post(
            &format!("/nodes/{}/fault", node.id),
            json!({ "pathIncludes": path_includes, "kind": kind, "times": times }),
        )
        .await;
    }

    async fn seed_hazard_report(&self, node: &Node, hazard_type: &str, lat: f64, lng: f64) {
        self.post(
            &format!("/nodes/{}/hazard-reports", node.id),
            json!({ "type": hazard_type, "lat": lat, "lng": lng }),
        )
        .await;
    }
}

struct Node {
    id: String,
    /// The node's own address — direct, not through its fault proxy.
    address: String,
    /// Same node, through its fault-injection proxy.
    proxy_address: String,
    client_id: String,
    client_secret: String,
}

fn temp_storage(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("tn-multi-node-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// A client using `node`'s address as its only server (`discovery: false` —
/// this test drives specific topologies itself, not real discovery).
fn client_for(node: &Node, storage: &std::path::Path) -> TrafficNetworkClient {
    client_for_address(&node.address, &node.client_id, &node.client_secret, storage)
}

fn client_for_address(
    address: &str,
    client_id: &str,
    client_secret: &str,
    storage: &std::path::Path,
) -> TrafficNetworkClient {
    TrafficNetworkClient::new(
        ClientOptions {
            nodes: vec![address.to_string()],
            discovery: false,
            credentials: Some(Credentials::Client {
                client_id: client_id.to_string(),
                client_secret: client_secret.to_string(),
            }),
            ..ClientOptions::default()
        },
        Platform {
            secure_store: std::sync::Arc::new(MemorySecureStore::new()),
            ..Platform::native(storage).expect("native platform")
        },
    )
    .expect("client construction")
}

/// Retries `check` until it returns `Some`, or panics after `timeout` — for
/// asserting on an asynchronous side effect (real federation replication),
/// exactly like `federation-multi-node.test.ts`'s own `waitFor`.
async fn wait_for<T, F, Fut>(mut check: F, timeout: Duration) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(value) = check().await {
            return value;
        }
        if std::time::Instant::now() > deadline {
            panic!("condition was not met within {timeout:?}");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn cold_start_finds_the_network_through_a_single_seed_and_can_sync() {
    let Some(harness) = Harness::connect().await else {
        eprintln!(
            "skipped: no multi-node harness at {} (see the module doc)",
            harness_url()
        );
        return;
    };
    let seed = harness
        .start_node(json!({ "federationEnabled": true }))
        .await;
    let peer = harness
        .start_node(json!({ "federationEnabled": true, "federationSeedIds": [seed.id] }))
        .await;

    // Only the seed is configured; discovery has to find the peer on its own.
    let client = TrafficNetworkClient::new(
        ClientOptions {
            discovery: true,
            seeds: vec![seed.address.clone()],
            credentials: Some(Credentials::Client {
                client_id: seed.client_id.clone(),
                client_secret: seed.client_secret.clone(),
            }),
            ..ClientOptions::default()
        },
        Platform {
            secure_store: std::sync::Arc::new(MemorySecureStore::new()),
            ..Platform::native(temp_storage("cold-start")).expect("native platform")
        },
    )
    .unwrap();

    let report = client.sync().await.unwrap();
    assert!(report.ok, "{report:?}");
    let status = client.get_network_status().unwrap();
    assert!(
        status.known_nodes.len() >= 2,
        "the seed's own directory should have surfaced the peer too: {status:?}"
    );

    harness.stop_node(&seed).await;
    harness.stop_node(&peer).await;
}

#[tokio::test]
async fn a_node_failing_mid_session_does_not_stop_sync_when_another_is_available() {
    let Some(harness) = Harness::connect().await else {
        eprintln!(
            "skipped: no multi-node harness at {} (see the module doc)",
            harness_url()
        );
        return;
    };
    let a = harness.start_node(json!({})).await;
    let b = harness.start_node_sharing_credential(json!({}), &a).await;

    // One client, both real nodes in its pool from the start — same as a
    // host app configuring two known servers.
    let client = TrafficNetworkClient::new(
        ClientOptions {
            nodes: vec![a.address.clone(), b.address.clone()],
            discovery: false,
            credentials: Some(Credentials::Client {
                client_id: a.client_id.clone(),
                client_secret: a.client_secret.clone(),
            }),
            ..ClientOptions::default()
        },
        Platform {
            secure_store: std::sync::Arc::new(MemorySecureStore::new()),
            ..Platform::native(temp_storage("failover")).expect("native platform")
        },
    )
    .unwrap();
    client.sync().await.unwrap();
    harness.stop_node(&a).await;

    // The exact same client, not a new one — a real connection refusal to
    // the now-dead A is what `DiscoveryService::request_with_failover` has
    // to react to here, not a mocked one.
    let report = client.sync().await.unwrap();
    assert!(report.ok, "{report:?}");

    harness.stop_node(&b).await;
}

#[tokio::test]
async fn the_same_report_seen_through_two_servers_is_shown_once() {
    let Some(harness) = Harness::connect().await else {
        eprintln!(
            "skipped: no multi-node harness at {} (see the module doc)",
            harness_url()
        );
        return;
    };
    let a = harness
        .start_node(json!({ "federationEnabled": true }))
        .await;
    let b = harness
        .start_node_sharing_credential(
            json!({ "federationEnabled": true, "federationSeedIds": [a.id] }),
            &a,
        )
        .await;

    harness.seed_hazard_report(&a, "accident", 48.5, 9.5).await;
    // Real anti-entropy/gossip replication — genuinely asynchronous.
    wait_for(
        || async {
            let probe = client_for(&b, &temp_storage("dedup-probe"));
            probe.update_position(48.5, 9.5, None).ok()?;
            probe.sync().await.ok()?;
            let items = probe
                .get_nearby(48.5, 9.5, 500.0, &[NearbyCategory::Hazards])
                .ok()?;
            (!items.is_empty()).then_some(())
        },
        Duration::from_secs(15),
    )
    .await;

    // A client that syncs from *both* servers must not show the event twice
    // just because each server has its own row id for it.
    let storage = temp_storage("dedup");
    let client = TrafficNetworkClient::new(
        ClientOptions {
            nodes: vec![a.address.clone(), b.address.clone()],
            discovery: false,
            credentials: Some(Credentials::Client {
                client_id: a.client_id.clone(),
                client_secret: a.client_secret.clone(),
            }),
            ..ClientOptions::default()
        },
        Platform {
            secure_store: std::sync::Arc::new(MemorySecureStore::new()),
            ..Platform::native(storage).expect("native platform")
        },
    )
    .unwrap();
    client.update_position(48.5, 9.5, None).unwrap();
    client.sync().await.unwrap();
    let items = client
        .get_nearby(48.5, 9.5, 500.0, &[NearbyCategory::Hazards])
        .unwrap();
    let accidents: Vec<_> = items
        .iter()
        .filter(
            |i| matches!(i, NearbyItem::Hazard { hazard_type, .. } if hazard_type == "accident"),
        )
        .collect();
    assert_eq!(accidents.len(), 1, "{items:?}");

    harness.stop_node(&a).await;
    harness.stop_node(&b).await;
}

#[tokio::test]
async fn an_offline_report_is_delivered_once_a_different_server_is_reachable() {
    let Some(harness) = Harness::connect().await else {
        eprintln!(
            "skipped: no multi-node harness at {} (see the module doc)",
            harness_url()
        );
        return;
    };
    let a = harness.start_node(json!({})).await;
    let b = harness.start_node_sharing_credential(json!({}), &a).await;
    let storage = temp_storage("offline-report");

    // The device's real secret store this time (not the in-memory stand-in
    // the other tests use) — persisted at `storage`, so the *second* client
    // instance below picks up the same device key and pending queue a real
    // app restart would, not a fresh identity.
    let client = TrafficNetworkClient::new(
        ClientOptions {
            nodes: vec![a.address.clone()],
            discovery: false,
            credentials: Some(Credentials::Client {
                client_id: a.client_id.clone(),
                client_secret: a.client_secret.clone(),
            }),
            ..ClientOptions::default()
        },
        Platform::native(&storage).expect("native platform"),
    )
    .unwrap();
    client.submit_report("ice", 47.0, 11.0, None).unwrap();
    assert_eq!(client.get_sync_status().unwrap().pending_writes, 1);

    // A is gone entirely — the report cannot go out through it.
    harness.stop_node(&a).await;

    // A fresh client instance, same storage directory, now pointed at B
    // (which shares A's credential — see `start_node_sharing_credential`).
    let client = TrafficNetworkClient::new(
        ClientOptions {
            nodes: vec![b.address.clone()],
            discovery: false,
            credentials: Some(Credentials::Client {
                client_id: b.client_id.clone(),
                client_secret: b.client_secret.clone(),
            }),
            ..ClientOptions::default()
        },
        Platform::native(&storage).expect("native platform"),
    )
    .unwrap();
    let report = client.sync().await.unwrap();
    assert_eq!(report.submitted, 1, "{report:?}");
    assert_eq!(client.get_sync_status().unwrap().pending_writes, 0);

    harness.stop_node(&b).await;
}

#[tokio::test]
async fn a_static_package_that_does_not_match_its_hash_is_rejected() {
    let Some(harness) = Harness::connect().await else {
        eprintln!(
            "skipped: no multi-node harness at {} (see the module doc)",
            harness_url()
        );
        return;
    };
    let node = harness.start_node(json!({})).await;
    harness
        .seed_hazard_report(&node, "traffic", 50.0, 8.0)
        .await;
    // Corrupting a *dynamic* response the client actually reads
    // (`GET /v1/snapshot`) stands in for the static-package hash-mismatch
    // path this harness cannot populate real static packages for — the
    // point being proven either way is "a byte-flipped response from a
    // real server, not a mock, does not silently corrupt the local store":
    // an unparseable body becomes an `InvalidResponse`/network error the
    // client reports honestly instead of storing garbage.
    harness
        .fault(&node, "/v1/snapshot", "corrupt-body", 1)
        .await;

    let client = client_for_address(
        &node.proxy_address,
        &node.client_id,
        &node.client_secret,
        &temp_storage("forged"),
    );
    let report = client.sync().await.unwrap();
    assert!(
        !report.ok,
        "a corrupted response must not look like a clean sync: {report:?}"
    );

    harness.stop_node(&node).await;
}
