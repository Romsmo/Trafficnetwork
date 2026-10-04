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
//!
//! This is also what actually found two real cross-language bugs, both in
//! raw-`sql` query paths that bypass Drizzle's schema-typed column
//! conversion (`server/src/db/queries/event-log.ts`): several server-emitted
//! timestamp columns (`reportedAt`/`expiresAt`/`occurredAt`) come back as
//! the database driver's own default `timestamptz` text output
//! (`"2026-09-27 14:45:15.923718+00"`), not the RFC 3339
//! `server/docs/api.md` documents (`sync::server_time` now tolerates both);
//! and `event_log.sequence` (`snapshotSequence`/`sequence`/`nextSince`)
//! comes back as a JSON *string* (`"1"`, a Postgres `bigint`'s default
//! textual form) rather than a number, which was silently failing every
//! sync with `SyncError::InvalidResponse` *before* it ever reached
//! `set_cursor` — a bootstrap that never advances to an incremental
//! `/v1/delta` looks, from the outside, exactly like data that never
//! replicates (`sync::types`'s `deserialize_sequence`/`deserialize_sequence_opt`
//! now tolerate both forms). Both are real server-side inconsistencies worth
//! fixing at the source, but this milestone makes no server changes
//! (`docs/status.md`'s B2 note).

// Native-only by nature (real HTTP against a harness on localhost, a tokio
// runtime, `Platform::native`): `wasm-pack test` builds every integration
// test target for wasm32 up front, where none of that exists.
#![cfg(not(target_arch = "wasm32"))]

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
    // One long-lived probe, not a fresh client per poll: a real app
    // authenticates once and re-syncs on the same client, and re-running
    // ensure_token() on every 100ms poll here was hammering
    // POST /v1/auth/token hard enough to trip the server's own real rate
    // limit within a couple of seconds (HTTP 429) -- which then masked
    // whether replication itself was even working. One token, repeated
    // incremental /v1/delta polls, exactly like `an_offline_report...`'s
    // client reuse elsewhere in this file.
    let probe = client_for(&b, &temp_storage("dedup-probe"));
    probe.update_position(48.5, 9.5, None).unwrap();
    // Real anti-entropy/gossip replication — genuinely asynchronous.
    wait_for(
        || async {
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

/// Real-time push against a real server — the one path the other tests here do
/// not touch, and the one whose URL used to be wrong (`http://…/v1/ws`, which no
/// WebSocket implementation accepts): the unit tests drive a scripted
/// transport that was keyed on the same wrong URL, so only a real server could
/// show that no push ever arrived. Nothing here calls `sync()` after the push
/// loop is running: the report must come through the WebSocket.
#[tokio::test]
async fn a_report_made_while_connected_arrives_through_the_websocket_push() {
    let Some(harness) = Harness::connect().await else {
        eprintln!(
            "skipped: no multi-node harness at {} (see the module doc)",
            harness_url()
        );
        return;
    };
    let node = harness.start_node(json!({})).await;
    let client = std::sync::Arc::new(client_for(&node, &temp_storage("push")));
    client.update_position(48.5, 9.5, None).unwrap();
    client.sync().await.unwrap();
    assert!(client
        .get_nearby(48.5, 9.5, 500.0, &[NearbyCategory::Hazards])
        .unwrap()
        .is_empty());

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let runner = {
        let client = client.clone();
        let stop = stop.clone();
        tokio::spawn(async move { client.run_realtime(&stop).await })
    };
    // Another party reports once the connection is up (the loop first closes
    // the gap with a delta sync, then listens).
    tokio::time::sleep(Duration::from_secs(2)).await;
    harness
        .seed_hazard_report(&node, "accident", 48.5, 9.5)
        .await;

    wait_for(
        || async {
            let items = client
                .get_nearby(48.5, 9.5, 500.0, &[NearbyCategory::Hazards])
                .ok()?;
            (!items.is_empty()).then_some(())
        },
        Duration::from_secs(15),
    )
    .await;

    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    runner.abort();
    harness.stop_node(&node).await;
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

// ----------------------------------------------------------- camera policy

/// A client of `node` whose host app switched the camera display on (it is
/// off by default).
fn client_with_cameras_on(node: &Node, storage: &std::path::Path) -> TrafficNetworkClient {
    TrafficNetworkClient::new(
        ClientOptions {
            nodes: vec![node.address.clone()],
            discovery: false,
            camera_namespace_enabled: true,
            // So the client notices a change of the policy within a second
            // instead of within two minutes.
            config_refresh_seconds: 1,
            credentials: Some(Credentials::Client {
                client_id: node.client_id.clone(),
                client_secret: node.client_secret.clone(),
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

/// What a client standing at `(lat, lng)` sees of cameras: whether the report
/// of a camera type is there as an individual report, and the zones.
fn camera_view(client: &TrafficNetworkClient, lat: f64, lng: f64) -> (bool, usize) {
    let items = client
        .get_nearby(
            lat,
            lng,
            3_000.0,
            &[NearbyCategory::Hazards, NearbyCategory::Cameras],
        )
        .expect("a read");
    let individual = items.iter().any(
        |item| matches!(item, NearbyItem::Hazard { hazard_type, .. } if hazard_type == "mobileSpeedCamera"),
    );
    let zones = items
        .iter()
        .filter(|item| matches!(item, NearbyItem::CameraZone { .. }))
        .count();
    (individual, zones)
}

#[tokio::test]
async fn a_country_policy_reaches_the_client_and_a_tightening_removes_what_it_held() {
    use trafficnetwork_core::sync::CameraLevel;

    let Some(harness) = Harness::connect().await else {
        eprintln!(
            "skipped: no multi-node harness at {} (see the module doc)",
            harness_url()
        );
        return;
    };
    // Germany individually, France as zones, Switzerland not at all (the
    // harness gives the node synthetic country boundaries, see
    // `server/tests/integration/camera-policy-helper.ts`).
    let node = harness
        .start_node(json!({ "cameraPolicy": { "DE": "full", "FR": "zones", "CH": "off" } }))
        .await;
    harness
        .seed_hazard_report(&node, "mobileSpeedCamera", 50.0, 10.0)
        .await;
    harness
        .seed_hazard_report(&node, "mobileSpeedCamera", 47.0, 2.0)
        .await;
    harness
        .seed_hazard_report(&node, "mobileSpeedCamera", 46.5, 8.5)
        .await;

    let learn = |name: &str, lat: f64, lng: f64| {
        let client = client_with_cameras_on(&node, &temp_storage(name));
        client.update_position(lat, lng, None).unwrap();
        client
    };
    let germany = learn("camera-policy-de", 50.0, 10.0);
    let france = learn("camera-policy-fr", 47.0, 2.0);
    let switzerland = learn("camera-policy-ch", 46.5, 8.5);
    for client in [&germany, &france, &switzerland] {
        let report = client.sync().await.unwrap();
        assert!(report.ok, "{report:?}");
    }

    // Each gets what its country allows — and the host app can read the rules.
    assert_eq!(
        camera_view(&germany, 50.0, 10.0),
        (true, 0),
        "Germany: the camera itself"
    );
    assert_eq!(
        camera_view(&france, 47.0, 2.0),
        (false, 1),
        "France: only an area"
    );
    assert_eq!(
        camera_view(&switzerland, 46.5, 8.5),
        (false, 0),
        "Switzerland: nothing"
    );
    let policy = germany.get_camera_policy().unwrap();
    assert!(policy.active && policy.enabled);
    assert_eq!(policy.max_level, CameraLevel::Full);
    // A country the node does not list has the default level (a country at
    // the default is simply not listed).
    let level_of = |country: &str| {
        policy
            .by_country
            .get(country)
            .copied()
            .unwrap_or(policy.default_level)
    };
    assert_eq!(level_of("DE"), CameraLevel::Full);
    assert_eq!(level_of("FR"), CameraLevel::Zones);
    assert_eq!(level_of("CH"), CameraLevel::Off);
    assert!(!policy.notice.text.is_empty());

    // The operator cuts Germany to zones. The node reloads its policy without
    // a restart; the client, at its next syncs, notices the packages moved,
    // reads the new rules, drops what it held and learns the live state afresh.
    harness
        .post(
            &format!("/nodes/{}/camera-policy", node.id),
            json!({ "levels": { "DE": "zones", "FR": "zones", "CH": "off" } }),
        )
        .await;
    wait_for(
        || async {
            germany.sync().await.ok()?;
            (camera_view(&germany, 50.0, 10.0) == (false, 1)).then_some(())
        },
        Duration::from_secs(30),
    )
    .await;
    let tightened = germany.get_camera_policy().unwrap();
    assert_eq!(
        tightened
            .by_country
            .get("DE")
            .copied()
            .unwrap_or(tightened.default_level),
        CameraLevel::Zones
    );

    harness.stop_node(&node).await;
}
