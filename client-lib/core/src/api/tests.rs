//! The public API against a scripted server: what a host app sees from
//! `sync`, the reads and the queued writes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::*;
use crate::crypto::{generate_ed25519_keypair, sign_envelope};
use crate::platform::{
    Clock, HttpError, HttpMethod, HttpRequest, HttpResponse, HttpTransport, Sleep, WsConnection,
    WsError, WsTransport,
};
use crate::storage::{InMemoryStore, Store};
use crate::sync::NetworkConfigPayload;

const NOW_MS: i64 = 1_800_000_000_000;
const SERVER: &str = "https://a.example";

struct FixedClock(AtomicI64);
impl Clock for FixedClock {
    fn now_unix_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// None of the tests in this file exercise realtime push — a `Platform`
/// still needs a `ws`/`sleep` to construct, so these two are never-used
/// stand-ins. `run_realtime` has its own test doubles in `realtime_tests.rs`.
struct NeverWs;
#[async_trait::async_trait]
impl WsTransport for NeverWs {
    async fn connect(&self, _url: &str) -> Result<Box<dyn WsConnection>, WsError> {
        Err(WsError::Connect("not used by these tests".to_string()))
    }
}

struct NoopSleep;
#[async_trait::async_trait]
impl Sleep for NoopSleep {
    async fn sleep_ms(&self, _duration_ms: u64) {}
}

/// A server that answers by method and path (the query string is ignored)
/// and remembers what it was asked.
#[derive(Default)]
struct ScriptedServer {
    routes: Mutex<HashMap<String, HttpResponse>>,
    log: Mutex<Vec<(String, Option<Value>)>>,
}

impl ScriptedServer {
    fn route(&self, method: &str, path: &str, status: u16, body: Value) {
        self.routes.lock().unwrap().insert(
            format!("{method} {path}"),
            HttpResponse {
                status,
                body: serde_json::to_vec(&body).unwrap(),
            },
        );
    }

    fn bodies_to(&self, method: &str, path: &str) -> Vec<Value> {
        let key = format!("{method} {path}");
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _)| *k == key)
            .filter_map(|(_, body)| body.clone())
            .collect()
    }

    fn count(&self, method: &str, path: &str) -> usize {
        let key = format!("{method} {path}");
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _)| *k == key)
            .count()
    }
}

#[async_trait::async_trait]
impl HttpTransport for ScriptedServer {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        let path = request
            .url
            .strip_prefix(SERVER)
            .unwrap_or(&request.url)
            .split('?')
            .next()
            .unwrap_or("")
            .to_string();
        let method = match request.method {
            HttpMethod::Get => "GET",
            HttpMethod::Post => "POST",
        };
        let key = format!("{method} {path}");
        let body = request
            .body
            .as_ref()
            .and_then(|b| serde_json::from_slice(b).ok());
        self.log.lock().unwrap().push((key.clone(), body));
        self.routes
            .lock()
            .unwrap()
            .get(&key)
            .cloned()
            .ok_or_else(|| HttpError::Network(format!("no route for {key}")))
    }
}

fn config_json(camera_namespace: bool) -> Value {
    json!({
        "regionTileH3Resolution": 7,
        "staticDataPartitionH3Resolution": 4,
        "speedCameraNamespaceEnabled": camera_namespace,
        "cameraNamespaceHazardTypes": [
            "fixedSpeedCamera", "mobileSpeedCamera", "trailerCamera", "redLightCamera", "distanceControl"
        ],
        "duplicateMergeRadiusMeters": 100,
        "speedLimitLookupMaxDistanceMeters": 50,
        "hazardExpiryMsByType": { "traffic": 900000, "ice": 900000 },
        "reportRateLimitMax": 10,
        "reportRateLimitWindowMinutes": 10,
        "cameraRemovalThreshold": 3,
        "staticDataVersion": 7,
        "federationEnabled": false,
        "networkConfig": null
    })
}

fn hazard_json(id: &str, kind: &str, lat: f64, lng: f64) -> Value {
    json!({
        "id": id, "type": kind,
        "position": { "type": "Point", "coordinates": [lng, lat] },
        "regionTile": "871f1d489ffffff",
        "reportedAt": "2027-01-01T00:00:00.000Z",
        "reporterId": "someone", "speedKmh": null,
        "expiresAt": "2099-01-01T00:00:00.000Z",
        "status": "active", "source": "community", "sourceLicense": null,
        "confirmCount": 0, "denyCount": 0
    })
}

fn segment_json(id: &str) -> Value {
    json!({
        "id": id,
        "geometry": { "type": "LineString", "coordinates": [[13.0, 52.0], [13.01, 52.0]] },
        "speedLimit": 50, "speedLimitUnit": "kmh",
        "source": "osm", "sourceLicense": "ODbL",
        "importedAt": "2027-01-01T00:00:00Z", "lastConfirmedAt": null
    })
}

fn sign_json(id: &str) -> Value {
    json!({
        "id": id,
        "position": { "type": "Point", "coordinates": [13.0, 52.0005] },
        "signType": "DE:274", "source": "osm", "sourceLicense": null,
        "importedAt": "2027-01-01T00:00:00Z"
    })
}

/// A server with everything a first sync needs: a token, a configuration,
/// one static package (a 50 km/h segment and a sign) and an empty snapshot.
fn working_server(camera_namespace: bool) -> Arc<ScriptedServer> {
    let server = Arc::new(ScriptedServer::default());
    server.route(
        "POST",
        "/v1/auth/token",
        200,
        json!({ "accessToken": "tok", "tokenType": "Bearer", "expiresIn": 3600, "scopes": ["client"] }),
    );
    server.route(
        "POST",
        "/v1/devices/bind-key",
        200,
        json!({ "bound": true, "publicKey": "x" }),
    );
    server.route("GET", "/v1/config", 200, config_json(camera_namespace));
    let package = json!({
        "tile": "t1",
        "speedLimitSegments": [segment_json("seg1")],
        "staticSigns": [sign_json("sign1")],
        "fixedSpeedCameras": []
    });
    let hash = hex::encode(Sha256::digest(serde_json::to_vec(&package).unwrap()));
    server.route(
        "GET",
        "/v1/static-data/manifest",
        200,
        json!({
            "staticDataVersion": 7, "generatedAt": "2027-01-01T00:00:00Z",
            "partitions": [{ "tile": "t1", "hash": hash, "sizeBytes": 100 }]
        }),
    );
    server.route("GET", "/v1/static-data/partitions/t1", 200, package);
    server.route(
        "GET",
        "/v1/snapshot",
        200,
        json!({
            "snapshotSequence": 5, "speedLimitSegments": [], "staticSigns": [],
            "hazardReports": [], "fixedSpeedCameras": []
        }),
    );
    server.route(
        "POST",
        "/v1/hazard-reports",
        201,
        json!({ "report": {}, "merged": false }),
    );
    server
}

fn options() -> ClientOptions {
    ClientOptions {
        nodes: vec![SERVER.to_string()],
        discovery: false,
        credentials: Some(Credentials::Client {
            client_id: "device-1".to_string(),
            client_secret: "secret".to_string(),
        }),
        ..ClientOptions::default()
    }
}

fn client_on(
    server: Arc<ScriptedServer>,
    store: Arc<dyn Store>,
    options: ClientOptions,
) -> TrafficNetworkClient {
    // These tests are about other things than the offline area: they keep everything, as before 1.2.
    if store.get_setting("offline").unwrap().is_none() {
        crate::sync::offline::save_settings(
            &*store,
            &crate::sync::offline::OfflineSettings {
                mode: crate::sync::offline::OfflineMode::All,
                ..Default::default()
            },
        )
        .unwrap();
    }
    TrafficNetworkClient::new(
        options,
        Platform {
            store,
            secure_store: Arc::new(MemorySecureStore::new()),
            http: server,
            clock: Arc::new(FixedClock(AtomicI64::new(NOW_MS))),
            ws: Arc::new(NeverWs),
            sleep: Arc::new(NoopSleep),
        },
    )
    .unwrap()
}

fn client(server: Arc<ScriptedServer>) -> TrafficNetworkClient {
    client_on(server, Arc::new(InMemoryStore::new()), options())
}

#[tokio::test]
async fn a_first_sync_fills_the_store_and_the_reads_answer_from_it() {
    let server = working_server(false);
    let client = client(server.clone());
    assert_eq!(client.get_sync_status().unwrap().connection, "never");

    let report = client.sync().await.unwrap();

    assert!(report.ok, "{report:?}");
    let limit = client
        .get_speed_limit_at(52.0, 13.005, None)
        .unwrap()
        .unwrap();
    assert_eq!(limit.value, 50.0);
    assert_eq!(limit.unit, "kmh");
    assert_eq!(limit.origin, OriginView::Imported);
    let nearby = client
        .get_nearby(52.0, 13.0, 200.0, &[NearbyCategory::Signs])
        .unwrap();
    assert!(matches!(nearby.as_slice(), [NearbyItem::Sign { id, .. }] if id == "sign1"));
    let status = client.get_sync_status().unwrap();
    assert_eq!(status.connection, "online");
    assert_eq!(status.static_data_version, Some(7));
    assert_eq!(status.last_synced_at_unix_ms, Some(NOW_MS));
    // The reads above went nowhere near the server.
    assert_eq!(server.count("GET", "/v1/config"), 1);
}

#[tokio::test]
async fn a_second_client_on_the_same_store_needs_no_network_for_the_reads() {
    let store: Arc<dyn Store> = Arc::new(InMemoryStore::new());
    let first = client_on(working_server(false), store.clone(), options());
    first.sync().await.unwrap();

    // A new client, a dead network, the same store: the data is all there.
    let offline = client_on(Arc::new(ScriptedServer::default()), store, options());
    assert!(offline
        .get_speed_limit_at(52.0, 13.005, None)
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn a_report_made_offline_is_visible_at_once_and_sent_on_the_next_sync() {
    let server = working_server(false);
    let client = client(server.clone());

    client.submit_report("ice", 52.0, 13.0, None).unwrap();
    let nearby = client.get_nearby(52.0, 13.0, 500.0, &[]).unwrap();
    assert!(matches!(
        nearby.as_slice(),
        [NearbyItem::Hazard { pending: true, hazard_type, .. }] if hazard_type == "ice"
    ));
    assert_eq!(client.get_sync_status().unwrap().pending_writes, 1);
    assert_eq!(server.count("POST", "/v1/hazard-reports"), 0);

    let report = client.sync().await.unwrap();

    assert_eq!(report.submitted, 1);
    assert_eq!(report.pending_writes, 0);
    let sent = server.bodies_to("POST", "/v1/hazard-reports");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["type"], "ice");
    // The device key was registered on the way, so the report is signed.
    assert!(sent[0].get("deviceAssertion").is_some());
    assert!(client
        .get_nearby(52.0, 13.0, 500.0, &[NearbyCategory::Hazards])
        .unwrap()
        .iter()
        .all(|item| !matches!(item, NearbyItem::Hazard { pending: true, .. })));
}

#[tokio::test]
async fn a_report_survives_a_server_that_is_down_and_goes_out_later() {
    let server = working_server(false);
    let store: Arc<dyn Store> = Arc::new(InMemoryStore::new());
    let client = client_on(server.clone(), store, options());
    client.submit_report("traffic", 52.0, 13.0, None).unwrap();
    server.route("POST", "/v1/hazard-reports", 503, json!({}));

    let report = client.sync().await.unwrap();
    assert_eq!(report.pending_writes, 1);
    assert_eq!(report.submitted, 0);

    server.route(
        "POST",
        "/v1/hazard-reports",
        201,
        json!({ "merged": false }),
    );
    let report = client.sync().await.unwrap();
    assert_eq!(report.submitted, 1);
    assert_eq!(report.pending_writes, 0);
}

#[tokio::test]
async fn cameras_need_the_server_the_host_app_and_a_valid_network_configuration() {
    async fn cameras_visible(server: Arc<ScriptedServer>, options: ClientOptions) -> bool {
        server.route(
            "GET",
            "/v1/snapshot",
            200,
            json!({
                "snapshotSequence": 5, "speedLimitSegments": [], "staticSigns": [],
                "hazardReports": [hazard_json("cam-report", "mobileSpeedCamera", 52.0, 13.0)],
                "fixedSpeedCameras": []
            }),
        );
        let client = client_on(server, Arc::new(InMemoryStore::new()), options);
        client.sync().await.unwrap();
        client
            .get_nearby(52.0, 13.0, 500.0, &[NearbyCategory::Hazards])
            .unwrap()
            .iter()
            .any(|item| matches!(item, NearbyItem::Hazard { id, .. } if id == "cam-report"))
    }

    let mut host_on = options();
    host_on.camera_namespace_enabled = true;

    // Server off: nothing, however the host app asks.
    assert!(!cameras_visible(working_server(false), host_on.clone()).await);
    // Server on, host app off (the default): nothing.
    assert!(!cameras_visible(working_server(true), options()).await);
    // Both on and no network configuration to say otherwise: visible.
    assert!(cameras_visible(working_server(true), host_on.clone()).await);

    // A network configuration signed by the root key can switch it off…
    let root = generate_ed25519_keypair().unwrap();
    let payload = |blitzer_enabled| NetworkConfigPayload {
        version: 3,
        blitzer_enabled,
        event_log_retention_days_dynamic: 7,
        event_log_retention_days_static: 30,
        min_version: "0.1.0".to_string(),
        excluded_node_ids: vec![],
        directory_key_id: None,
        import_key_id: None,
        issued_at: "2027-01-01T00:00:00Z".to_string(),
        camera_policy_by_country: None,
        raw: None,
    };
    let mut config = config_json(true);
    config["networkConfig"] =
        serde_json::to_value(sign_envelope(payload(false), &root).unwrap()).unwrap();
    let server = working_server(true);
    server.route("GET", "/v1/config", 200, config);
    let mut with_root = host_on.clone();
    with_root.network_root_key = Some(root.public_key_raw.clone());
    assert!(!cameras_visible(server, with_root.clone()).await);

    // …and one signed by somebody else is ignored, as if it were not there.
    let impostor = generate_ed25519_keypair().unwrap();
    let mut forged = config_json(true);
    forged["networkConfig"] =
        serde_json::to_value(sign_envelope(payload(false), &impostor).unwrap()).unwrap();
    let server = working_server(true);
    server.route("GET", "/v1/config", 200, forged);
    assert!(cameras_visible(server, with_root).await);
}

#[tokio::test]
async fn the_network_status_reports_the_verified_configuration_version() {
    let root = generate_ed25519_keypair().unwrap();
    let signed = sign_envelope(
        NetworkConfigPayload {
            version: 9,
            blitzer_enabled: false,
            event_log_retention_days_dynamic: 7,
            event_log_retention_days_static: 30,
            min_version: "0.1.0".to_string(),
            excluded_node_ids: vec![],
            directory_key_id: None,
            import_key_id: None,
            issued_at: "2027-01-01T00:00:00Z".to_string(),
            camera_policy_by_country: None,
            raw: None,
        },
        &root,
    )
    .unwrap();
    let server = working_server(false);
    let mut config = config_json(false);
    config["networkConfig"] = serde_json::to_value(signed).unwrap();
    server.route("GET", "/v1/config", 200, config);
    let mut opts = options();
    opts.network_root_key = Some(root.public_key_raw);
    let client = client_on(server, Arc::new(InMemoryStore::new()), opts);

    client.sync().await.unwrap();

    let status = client.get_network_status().unwrap();
    assert_eq!(status.config_version, Some(9));
    assert_eq!(status.current_nodes, vec![SERVER.to_string()]);
    assert_eq!(status.known_nodes.len(), 1);
    assert!(!status.camera_namespace_enabled);
}

#[test]
fn moving_to_other_tiles_makes_the_next_tick_sync() {
    let client = client(working_server(false));

    let first = client.update_position(52.52, 13.405, Some(30.0)).unwrap();
    assert!(first.changed);
    assert_eq!(first.tiles.len(), 7);
    let again = client
        .update_position(52.5201, 13.4051, Some(30.0))
        .unwrap();
    assert!(!again.changed);
    let fast = client.update_position(52.52, 13.405, Some(130.0)).unwrap();
    assert!(fast.changed);
    assert_eq!(fast.tiles.len(), 19);
    assert!(client.update_position(f64::NAN, 0.0, None).is_err());
}

#[tokio::test]
async fn tick_syncs_when_due_and_otherwise_does_nothing() {
    let server = working_server(false);
    let client = client(server.clone());

    let first = client.tick().await.unwrap();
    assert!(first.synced);
    // The clock has not moved, nothing changed: not due.
    let second = client.tick().await.unwrap();
    assert!(!second.synced);
    assert_eq!(server.count("GET", "/v1/config"), 1);

    // A new position is a reason to sync at once.
    client.update_position(52.52, 13.405, None).unwrap();
    assert!(client.tick().await.unwrap().synced);
}

#[tokio::test]
async fn a_full_store_is_a_clear_error_and_an_event_not_a_crash() {
    let server = working_server(false);
    let store: Arc<dyn Store> = Arc::new(InMemoryStore::with_static_entity_limit(1));
    let client = client_on(server, store, options());

    let error = client.sync().await.unwrap_err();

    assert_eq!(error.code, code::STORAGE_FULL);
    let events = client.poll_events();
    assert!(events.contains(&ClientEvent::StorageFull));
    assert_eq!(client.get_sync_status().unwrap().connection, "offline");
    // The client is still usable.
    assert!(client.get_speed_limit_at(52.0, 13.005, None).is_ok());
}

#[tokio::test]
async fn without_credentials_sync_says_so() {
    let mut opts = options();
    opts.credentials = None;
    let client = client_on(working_server(false), Arc::new(InMemoryStore::new()), opts);

    let error = client.sync().await.unwrap_err();

    assert_eq!(error.code, code::NOT_CONFIGURED);
}

#[tokio::test]
async fn an_unreachable_network_is_a_report_not_an_error_and_reads_keep_working() {
    let store: Arc<dyn Store> = Arc::new(InMemoryStore::new());
    let online = client_on(working_server(false), store.clone(), options());
    online.sync().await.unwrap();

    // Same store, but the token endpoint is gone.
    let server = Arc::new(ScriptedServer::default());
    let offline = client_on(server, store, options());
    let error = offline.sync().await.unwrap_err();
    assert_eq!(error.code, code::NETWORK);
    assert_eq!(offline.get_sync_status().unwrap().connection, "offline");
    assert!(offline
        .get_speed_limit_at(52.0, 13.005, None)
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn an_app_key_registers_the_device_once_and_keeps_the_credential() {
    let server = working_server(false);
    server.route(
        "POST",
        "/v1/devices/register",
        201,
        json!({ "clientId": "device-77", "clientSecret": "device-secret" }),
    );
    let mut opts = options();
    opts.credentials = Some(Credentials::App {
        app_client_id: "app".to_string(),
        app_client_secret: "app-secret".to_string(),
    });
    let secure = Arc::new(MemorySecureStore::new());
    let make = |secure: Arc<MemorySecureStore>| {
        TrafficNetworkClient::new(
            opts.clone(),
            Platform {
                store: Arc::new(InMemoryStore::new()),
                secure_store: secure,
                http: server.clone(),
                clock: Arc::new(FixedClock(AtomicI64::new(NOW_MS))),
                ws: Arc::new(NeverWs),
                sleep: Arc::new(NoopSleep),
            },
        )
        .unwrap()
    };

    make(secure.clone()).sync().await.unwrap();
    make(secure.clone()).sync().await.unwrap();

    // Registered once; the second start used the stored device credential.
    assert_eq!(server.count("POST", "/v1/devices/register"), 1);
    let bodies = server.bodies_to("POST", "/v1/auth/token");
    assert_eq!(bodies[0]["clientId"], "app");
    assert_eq!(bodies[1]["clientId"], "device-77");
}

#[tokio::test]
async fn the_json_call_reaches_every_method_and_reports_errors_the_same_way() {
    let client = client(working_server(false));

    let version = client.call("version", Value::Null).await.unwrap();
    assert_eq!(version["apiVersion"], API_VERSION);

    let report = client.call("sync", json!({})).await.unwrap();
    assert_eq!(report["ok"], true);

    let limit = client
        .call("getSpeedLimitAt", json!({ "lat": 52.0, "lng": 13.005 }))
        .await
        .unwrap();
    assert_eq!(limit["value"], 50.0);
    assert_eq!(limit["origin"]["kind"], "imported");

    let nothing = client
        .call("getSpeedLimitAt", json!({ "lat": -30.0, "lng": 20.0 }))
        .await
        .unwrap();
    assert!(nothing.is_null());

    let id = client
        .call(
            "submitReport",
            json!({ "type": "traffic", "lat": 52.0, "lng": 13.0 }),
        )
        .await
        .unwrap();
    assert!(id["localId"].is_string());

    let nearby = client
        .call(
            "getNearby",
            json!({ "lat": 52.0, "lng": 13.0, "radiusMeters": 300, "categories": ["hazards"] }),
        )
        .await
        .unwrap();
    assert_eq!(nearby["items"].as_array().unwrap().len(), 1);
    assert_eq!(nearby["items"][0]["kind"], "hazard");

    let events = client.call("pollEvents", json!({})).await.unwrap();
    assert!(events["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["type"] == "syncCompleted"));

    let error = client.call("noSuchMethod", json!({})).await.unwrap_err();
    assert_eq!(error.code, code::INVALID_ARGUMENT);
    let error = client
        .call("getSpeedLimitAt", json!({ "lat": "north" }))
        .await
        .unwrap_err();
    assert_eq!(error.code, code::INVALID_ARGUMENT);
    let error = client
        .call(
            "submitReport",
            json!({ "type": "dragons", "lat": 52.0, "lng": 13.0 }),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, code::INVALID_ARGUMENT);
}

#[tokio::test]
async fn a_closed_client_refuses_everything() {
    let client = client(working_server(false));
    client.close();

    assert_eq!(client.sync().await.unwrap_err().code, code::CLOSED);
    assert_eq!(
        client
            .get_speed_limit_at(52.0, 13.0, None)
            .unwrap_err()
            .code,
        code::CLOSED
    );
    assert_eq!(
        client
            .call("getSyncStatus", Value::Null)
            .await
            .unwrap_err()
            .code,
        code::CLOSED
    );
}

#[test]
fn a_client_with_no_way_to_find_a_server_is_refused_at_the_start() {
    let mut opts = options();
    opts.nodes.clear();
    opts.discovery = false;

    let result = TrafficNetworkClient::new(
        opts,
        Platform {
            store: Arc::new(InMemoryStore::new()),
            secure_store: Arc::new(MemorySecureStore::new()),
            http: Arc::new(ScriptedServer::default()),
            clock: Arc::new(FixedClock(AtomicI64::new(NOW_MS))),
            ws: Arc::new(NeverWs),
            sleep: Arc::new(NoopSleep),
        },
    );

    assert_eq!(result.err().unwrap().code, code::INVALID_ARGUMENT);
}

#[test]
fn the_same_event_from_two_servers_is_shown_once() {
    let client = client(working_server(false));
    // Two servers, two ids, one accident.
    let store = client.store_for_test();
    let mut a: crate::sync::HazardReport =
        serde_json::from_value(hazard_json("from-a", "accident", 52.0, 13.0)).unwrap();
    a.confirm_count = 1;
    let mut b: crate::sync::HazardReport =
        serde_json::from_value(hazard_json("from-b", "accident", 52.0002, 13.0002)).unwrap();
    b.confirm_count = 4;
    store.upsert_hazard_reports(&[a, b]).unwrap();
    // A different type at the same place is a different event.
    store
        .upsert_hazard_reports(&[
            serde_json::from_value(hazard_json("ice", "ice", 52.0, 13.0)).unwrap(),
        ])
        .unwrap();
    // The configuration (merge radius 100 m) comes with the first sync; set it directly.
    client.set_test_config(config_json(false));

    let items = client
        .get_nearby(52.0, 13.0, 500.0, &[NearbyCategory::Hazards])
        .unwrap();

    let ids: Vec<&str> = items
        .iter()
        .filter_map(|i| match i {
            NearbyItem::Hazard { id, .. } => Some(id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(ids.len(), 2, "{ids:?}");
    assert!(
        ids.contains(&"from-b"),
        "the better-confirmed one is kept: {ids:?}"
    );
    assert!(ids.contains(&"ice"));
}

#[test]
fn the_search_radius_and_positions_are_checked() {
    let client = client(working_server(false));

    assert_eq!(
        client.get_nearby(52.0, 13.0, 0.0, &[]).unwrap_err().code,
        code::INVALID_ARGUMENT
    );
    assert_eq!(
        client
            .get_nearby(52.0, 13.0, 60_000.0, &[])
            .unwrap_err()
            .code,
        code::INVALID_ARGUMENT
    );
    assert_eq!(
        client.get_nearby(95.0, 13.0, 100.0, &[]).unwrap_err().code,
        code::INVALID_ARGUMENT
    );
    assert_eq!(
        client
            .submit_report("ice", f64::NAN, 13.0, None)
            .unwrap_err()
            .code,
        code::INVALID_ARGUMENT
    );
}

// ----------------------------------------------------------- camera policy

fn camera_json(id: &str, lat: f64, lng: f64) -> Value {
    json!({
        "id": id, "type": "fixedSpeedCamera",
        "position": { "type": "Point", "coordinates": [lng, lat] },
        "status": "active", "removedAt": null, "source": "osm", "sourceLicense": null,
        "importedAt": "2027-01-01T00:00:00Z", "lastConfirmedAt": null, "removalReportCount": 0
    })
}

fn zone_json(id: &str, lat: f64, lng: f64) -> Value {
    json!({
        "id": id, "cell": "861f1d48fffffff", "resolution": 6,
        "boundary": { "type": "Polygon", "coordinates": [[
            [lng - 0.02, lat - 0.02], [lng + 0.02, lat - 0.02],
            [lng + 0.02, lat + 0.02], [lng - 0.02, lat + 0.02],
            [lng - 0.02, lat - 0.02]
        ]] },
        "cameraTypes": ["fixedSpeedCamera", "mobileSpeedCamera"],
        "status": "active"
    })
}

/// A configuration whose country policy says `default_level` for every
/// country and `by_country` for the listed ones.
fn policy_config(default_level: &str, by_country: Value) -> Value {
    let mut config = config_json(true);
    config["cameraPolicy"] = json!({
        "version": "p1", "namespaceEnabled": true,
        "defaultLevel": default_level, "byCountry": by_country, "zoneResolution": 6,
        "notice": { "version": 3, "text": { "de": "Hinweis vom Knoten", "en": "Notice from the node" } }
    });
    config
}

/// The tile of the one package of `camera_server`, at the resolution it says.
fn camera_tile() -> String {
    tile_at(52.0, 13.0, 4).unwrap()
}

/// A working server with `config`, whose only package holds — if asked — a
/// camera and a zone around (52.0, 13.0); its snapshot holds an `ice` report
/// and, with the camera, a report of a camera type (a server that withholds
/// the camera withholds that too).
fn camera_server(config: Value, with_camera: bool, with_zone: bool) -> Arc<ScriptedServer> {
    let server = working_server(true);
    server.route("GET", "/v1/config", 200, config);
    let cameras = if with_camera {
        vec![camera_json("cam1", 52.0, 13.0)]
    } else {
        vec![]
    };
    let zones = if with_zone {
        vec![zone_json("zone1", 52.0, 13.0)]
    } else {
        vec![]
    };
    let package = json!({
        "tile": camera_tile(),
        "speedLimitSegments": [], "staticSigns": [],
        "fixedSpeedCameras": cameras,
        "cameraZones": zones
    });
    let hash = hex::encode(Sha256::digest(serde_json::to_vec(&package).unwrap()));
    server.route(
        "GET",
        "/v1/static-data/manifest",
        200,
        json!({
            "staticDataVersion": 7, "generatedAt": "2027-01-01T00:00:00Z",
            "partitionResolution": 4,
            "partitions": [{ "tile": camera_tile(), "hash": hash, "sizeBytes": 100 }]
        }),
    );
    server.route(
        "GET",
        &format!("/v1/static-data/partitions/{}", camera_tile()),
        200,
        package,
    );
    let mut reports = vec![hazard_json("ice-report", "ice", 52.0, 13.0)];
    if with_camera {
        reports.push(hazard_json("cam-report", "mobileSpeedCamera", 52.0, 13.0));
    }
    server.route(
        "GET",
        "/v1/snapshot",
        200,
        json!({
            "snapshotSequence": 5, "speedLimitSegments": [], "staticSigns": [],
            "hazardReports": reports,
            "fixedSpeedCameras": []
        }),
    );
    server.route(
        "GET",
        "/v1/delta",
        200,
        json!({ "events": [], "nextSince": 5, "hasMore": false }),
    );
    server
}

fn host_on() -> ClientOptions {
    let mut opts = options();
    opts.camera_namespace_enabled = true;
    opts
}

#[tokio::test]
async fn a_zones_policy_shows_areas_and_never_an_individual_camera() {
    use crate::sync::CameraLevel;

    // Even a package that (wrongly) held a camera does not make one show.
    let server = camera_server(policy_config("zones", json!({})), true, true);
    let client = client_on(server, Arc::new(InMemoryStore::new()), host_on());
    client.sync().await.unwrap();

    let items = client
        .get_nearby(52.0, 13.0, 500.0, &[NearbyCategory::Cameras])
        .unwrap();
    assert_eq!(items.len(), 1, "{items:?}");
    assert!(matches!(&items[0], NearbyItem::CameraZone { id, .. } if id == "zone1"));
    let wire = serde_json::to_value(&items[0]).unwrap();
    assert_eq!(wire["kind"], "cameraZone");
    assert_eq!(wire["distanceMeters"], json!(0.0));
    assert_eq!(
        wire["cameraTypes"],
        json!(["fixedSpeedCamera", "mobileSpeedCamera"])
    );
    assert_eq!(wire["outline"].as_array().unwrap().len(), 5);
    for key in ["lat", "lng", "position", "cameraType"] {
        assert!(wire.get(key).is_none(), "a zone has no `{key}`: {wire}");
    }

    // Nor does the stored camera report of a camera type appear as a hazard.
    let hazards = client
        .get_nearby(52.0, 13.0, 500.0, &[NearbyCategory::Hazards])
        .unwrap();
    assert!(hazards
        .iter()
        .all(|item| !matches!(item, NearbyItem::Hazard { id, .. } if id == "cam-report")));
    assert!(hazards
        .iter()
        .any(|item| matches!(item, NearbyItem::Hazard { id, .. } if id == "ice-report")));

    assert_eq!(
        client.get_camera_policy().unwrap().max_level,
        CameraLevel::Zones
    );
}

#[tokio::test]
async fn a_full_country_shows_individual_cameras_and_the_host_switch_decides() {
    let config = policy_config("off", json!({ "DE": "full", "FR": "zones" }));

    // The host app did not switch cameras on (the default): nothing at all.
    let off = client_on(
        camera_server(config.clone(), true, true),
        Arc::new(InMemoryStore::new()),
        options(),
    );
    off.sync().await.unwrap();
    assert!(off
        .get_nearby(52.0, 13.0, 500.0, &[NearbyCategory::Cameras])
        .unwrap()
        .is_empty());
    assert!(!off.get_camera_policy().unwrap().active);
    assert!(!off.get_camera_policy().unwrap().host_enabled);

    // Switched on: the camera of a `full` country, and the zone of the other.
    let on = client_on(
        camera_server(config, true, true),
        Arc::new(InMemoryStore::new()),
        host_on(),
    );
    on.sync().await.unwrap();
    let items = on
        .get_nearby(52.0, 13.0, 500.0, &[NearbyCategory::Cameras])
        .unwrap();
    assert!(items
        .iter()
        .any(|item| matches!(item, NearbyItem::Camera { id, .. } if id == "cam1")));
    assert!(items
        .iter()
        .any(|item| matches!(item, NearbyItem::CameraZone { id, .. } if id == "zone1")));
    let policy = on.get_camera_policy().unwrap();
    assert!(policy.active && policy.host_enabled && policy.enabled);
}

#[tokio::test]
async fn a_policy_that_gets_stricter_removes_what_was_stored_and_refetches_the_packages() {
    let store = Arc::new(InMemoryStore::new());

    // Learned under a policy that lets individual cameras through everywhere.
    let loose = camera_server(policy_config("full", json!({})), true, true);
    let first = client_on(loose, store.clone(), host_on());
    first.sync().await.unwrap();
    assert_eq!(store.fixed_speed_cameras().unwrap().len(), 1);
    assert_eq!(store.camera_zones().unwrap().len(), 1);
    assert_eq!(store.hazard_reports().unwrap().len(), 2);
    assert!(store
        .camera_policy_stamp()
        .unwrap()
        .is_some_and(|stamp| stamp.contains("\"defaultLevel\":\"full\"")));

    // Germany is cut to zones. The package is rebuilt without the camera.
    let strict = camera_server(policy_config("full", json!({ "DE": "zones" })), false, true);
    let second = client_on(strict.clone(), store.clone(), host_on());
    second.sync().await.unwrap();

    assert!(
        store.fixed_speed_cameras().unwrap().is_empty(),
        "the camera is gone"
    );
    let reports: Vec<String> = store
        .hazard_reports()
        .unwrap()
        .into_iter()
        .map(|report| report.id)
        .collect();
    assert_eq!(
        reports,
        vec!["ice-report".to_string()],
        "only the camera report went"
    );
    assert_eq!(
        strict.count(
            "GET",
            &format!("/v1/static-data/partitions/{}", camera_tile())
        ),
        1,
        "the package that held cameras was fetched again"
    );
    assert_eq!(
        store.camera_zones().unwrap().len(),
        1,
        "the zone came back with it"
    );
    assert!(second
        .get_nearby(52.0, 13.0, 500.0, &[NearbyCategory::Cameras])
        .unwrap()
        .iter()
        .all(|item| !matches!(item, NearbyItem::Camera { .. })));

    // The same policy again changes nothing.
    let again = client_on(strict.clone(), store.clone(), host_on());
    again.sync().await.unwrap();
    assert_eq!(
        strict.count(
            "GET",
            &format!("/v1/static-data/partitions/{}", camera_tile())
        ),
        1,
        "nothing was dropped, so nothing is fetched again"
    );
}

#[tokio::test]
async fn the_emergency_brake_removes_every_camera_locally() {
    let store = Arc::new(InMemoryStore::new());
    let loose = camera_server(policy_config("full", json!({})), true, true);
    client_on(loose, store.clone(), host_on())
        .sync()
        .await
        .unwrap();
    assert_eq!(store.fixed_speed_cameras().unwrap().len(), 1);

    let mut braked = policy_config("full", json!({}));
    braked["cameraPolicy"]["namespaceEnabled"] = json!(false);
    braked["speedCameraNamespaceEnabled"] = json!(false);
    let client = client_on(
        camera_server(braked, false, false),
        store.clone(),
        host_on(),
    );
    client.sync().await.unwrap();

    assert!(store.fixed_speed_cameras().unwrap().is_empty());
    assert!(store.camera_zones().unwrap().is_empty());
    assert!(client
        .get_nearby(52.0, 13.0, 500.0, &[NearbyCategory::Cameras])
        .unwrap()
        .is_empty());
    assert!(!client.get_camera_policy().unwrap().active);
}

#[tokio::test]
async fn the_host_app_gets_the_levels_and_the_notice_through_the_api() {
    let client = client(working_server(true));

    // Before any configuration: nothing is allowed, and the library's own
    // notice is there to show.
    let before = client.call("getCameraPolicy", json!({})).await.unwrap();
    assert_eq!(before["hostEnabled"], json!(false));
    assert_eq!(before["active"], json!(false));
    assert_eq!(before["maxLevel"], json!("off"));
    assert_eq!(before["version"], Value::Null);
    assert!(before["notice"]["text"]["de"]
        .as_str()
        .unwrap()
        .contains("Beifahrer"));
    assert!(before["notice"]["text"]["en"]
        .as_str()
        .unwrap()
        .contains("Switzerland"));

    // With one: the node's levels and the node's wording.
    let server = camera_server(
        policy_config("off", json!({ "DE": "full", "CH": "off" })),
        false,
        false,
    );
    let client = client_on(server, Arc::new(InMemoryStore::new()), options());
    client.sync().await.unwrap();
    let policy = client.call("getCameraPolicy", json!({})).await.unwrap();
    assert_eq!(policy["maxLevel"], json!("full"));
    assert_eq!(policy["defaultLevel"], json!("off"));
    assert_eq!(policy["byCountry"], json!({ "CH": "off", "DE": "full" }));
    assert_eq!(policy["zoneResolution"], json!(6));
    assert_eq!(policy["version"], json!("p1"));
    assert_eq!(policy["notice"]["version"], json!(3));
    assert_eq!(
        policy["notice"]["text"]["en"],
        json!("Notice from the node")
    );
    // The host did not switch it on, so nothing is shown yet.
    assert_eq!(policy["hostEnabled"], json!(false));
    assert_eq!(policy["active"], json!(false));
}

#[test]
fn the_camera_display_is_off_unless_the_host_app_switches_it_on() {
    assert!(!ClientOptions::default().camera_namespace_enabled);
    let from_json: ClientOptions = serde_json::from_value(json!({ "nodes": [SERVER] })).unwrap();
    assert!(!from_json.camera_namespace_enabled);
    assert!(
        !client(working_server(true))
            .get_camera_policy()
            .unwrap()
            .host_enabled
    );
}

// ------------------------------------------------------------ duration of a report (server 1.1.0)

fn config_with_report_expiry() -> Value {
    let mut config = config_json(false);
    config["hazardExpiryMsByType"] =
        json!({ "traffic": 1_500_000, "mobileSpeedCamera": 10_800_000 });
    config["reportExpiry"] = json!({
        "traffic": { "defaultSeconds": 1500, "minSeconds": 300, "maxSeconds": 21600 },
        "mobileSpeedCamera": { "defaultSeconds": 10800, "minSeconds": 600, "maxSeconds": 43200 },
        // a type this build does not know, and a malformed entry: neither may break the configuration
        "hovercraft": { "defaultSeconds": 60, "minSeconds": 1, "maxSeconds": 120 },
        "ice": { "defaultSeconds": "soon" }
    });
    config
}

#[tokio::test]
async fn the_limits_of_a_report_type_come_from_the_servers_rules() {
    let server = working_server(false);
    server.route("GET", "/v1/config", 200, config_with_report_expiry());
    let client = client(server);
    client.sync().await.unwrap();

    let limits = client
        .call("getReportLimits", json!({ "type": "mobileSpeedCamera" }))
        .await
        .unwrap();
    assert_eq!(
        limits,
        json!({ "supported": true, "defaultSeconds": 10800, "minSeconds": 600, "maxSeconds": 43200 })
    );
    // a type the server lists nothing for has no bounds to offer
    let ice = client
        .call("getReportLimits", json!({ "type": "ice" }))
        .await
        .unwrap();
    assert_eq!(ice["supported"], json!(false));
}

#[tokio::test]
async fn a_requested_duration_is_queued_signed_and_sent() {
    let server = working_server(false);
    server.route("GET", "/v1/config", 200, config_with_report_expiry());
    let client = client(server.clone());
    client.sync().await.unwrap();

    let queued = client
        .call(
            "submitReport",
            json!({ "type": "mobileSpeedCamera", "lat": 52.0, "lng": 13.0, "ttlSeconds": 7200 }),
        )
        .await
        .unwrap();
    assert_eq!(queued["expiresInSeconds"], json!(7200));
    assert_eq!(queued["durationHonoured"], json!(true));
    assert_eq!(queued["defaultSeconds"], json!(10800));
    assert!(queued["localId"].is_string());

    // the local view uses it at once: the pending report ends in two hours, not at the server's default
    let nearby = client
        .call(
            "getNearby",
            json!({ "lat": 52.0, "lng": 13.0, "radiusMeters": 500, "categories": ["hazards"] }),
        )
        .await
        .unwrap();
    let pending = &nearby["items"][0];
    assert_eq!(pending["pending"], json!(true));
    let ends = chrono::DateTime::parse_from_rfc3339(pending["expiresAt"].as_str().unwrap())
        .unwrap()
        .timestamp_millis();
    assert_eq!(ends, NOW_MS + 7_200_000);

    client.sync().await.unwrap();
    let sent = server.bodies_to("POST", "/v1/hazard-reports");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["expiresInSeconds"], json!(7200));
}

#[tokio::test]
async fn a_duration_outside_the_bounds_is_refused_before_anything_is_queued() {
    let server = working_server(false);
    server.route("GET", "/v1/config", 200, config_with_report_expiry());
    let store = Arc::new(InMemoryStore::new());
    let client = client_on(server.clone(), store.clone(), options());
    client.sync().await.unwrap();

    for seconds in [30, 600_000] {
        let error = client
            .call(
                "submitReport",
                json!({ "type": "traffic", "lat": 52.0, "lng": 13.0, "ttlSeconds": seconds }),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "ttlOutOfRange");
        assert!(error.message.contains("300") && error.message.contains("21600"));
    }
    assert!(store.pending_writes().unwrap().is_empty());
    assert_eq!(server.count("POST", "/v1/hazard-reports"), 0);
}

#[tokio::test]
async fn an_older_server_takes_no_duration_and_the_host_app_is_told() {
    let server = working_server(false); // its configuration has no `reportExpiry`
    let client = client(server.clone());
    client.sync().await.unwrap();

    let limits = client
        .call("getReportLimits", json!({ "type": "traffic" }))
        .await
        .unwrap();
    assert_eq!(limits["supported"], json!(false));
    assert_eq!(limits["defaultSeconds"], json!(900));

    let queued = client
        .call(
            "submitReport",
            json!({ "type": "traffic", "lat": 52.0, "lng": 13.0, "ttlSeconds": 3600 }),
        )
        .await
        .unwrap();
    assert_eq!(queued["durationHonoured"], json!(false));
    assert_eq!(queued["expiresInSeconds"], json!(null));

    client.sync().await.unwrap();
    let sent = server.bodies_to("POST", "/v1/hazard-reports");
    assert!(
        sent[0].get("expiresInSeconds").is_none(),
        "an older server never sees the field"
    );
}

#[tokio::test]
async fn without_a_duration_nothing_changes_for_the_host_app() {
    let server = working_server(false);
    server.route("GET", "/v1/config", 200, config_with_report_expiry());
    let client = client(server.clone());
    client.sync().await.unwrap();
    let queued = client
        .call(
            "submitReport",
            json!({ "type": "traffic", "lat": 52.0, "lng": 13.0 }),
        )
        .await
        .unwrap();
    assert_eq!(queued["expiresInSeconds"], json!(null));
    assert_eq!(queued["durationHonoured"], json!(true));
    assert!(queued["localId"].is_string());
    client.sync().await.unwrap();
    assert!(server.bodies_to("POST", "/v1/hazard-reports")[0]
        .get("expiresInSeconds")
        .is_none());
}

// ------------------------------------------------ "no speed limit on record here" (server 1.1.0)

fn config_with_corrections() -> Value {
    let mut config = config_json(false);
    config["communityCorrections"] = json!({
        "enabled": true, "confirmationsRequired": 3,
        "valueRange": { "kmh": { "min": 5, "max": 150 }, "mph": { "min": 5, "max": 85 } },
        "valueStep": 5, "rateLimit": { "max": 5, "windowMinutes": 60 }
    });
    config
}

/// A server like `working_server`, but whose one package is stored under its real H3 tile, so the position lookup
/// knows which places the offline data covers.
fn covered_server() -> Arc<ScriptedServer> {
    let server = working_server(false);
    server.route("GET", "/v1/config", 200, config_with_corrections());
    let tile = crate::api::tiles::tile_at(52.0, 13.0, 4).unwrap();
    let package = json!({
        "tile": tile, "speedLimitSegments": [segment_json("seg1")],
        "staticSigns": [], "fixedSpeedCameras": []
    });
    let hash = hex::encode(Sha256::digest(serde_json::to_vec(&package).unwrap()));
    server.route(
        "GET",
        "/v1/static-data/manifest",
        200,
        json!({
            "staticDataVersion": 7, "generatedAt": "2027-01-01T00:00:00Z",
            "partitionResolution": 4,
            "partitions": [{ "tile": tile, "hash": hash, "sizeBytes": 100 }]
        }),
    );
    server.route(
        "GET",
        &format!("/v1/static-data/partitions/{tile}"),
        200,
        package,
    );
    server
}

#[tokio::test]
async fn a_stretch_of_road_is_proposed_by_two_points_and_shown_at_once() {
    let server = covered_server();
    let client = client(server.clone());
    client.sync().await.unwrap();

    // 52.01 is 1 km north of the stored road: nothing on record there. The two points are ~140 m apart.
    let proposal = client
        .call(
            "reportSpeedLimitInterval",
            json!({
                "from": { "lat": 52.01, "lng": 13.005 },
                "to": { "lat": 52.01, "lng": 13.007 },
                "value": 30, "unit": "kmh", "reason": "missing"
            }),
        )
        .await
        .unwrap();
    assert_eq!(proposal["value"], json!(30));
    assert_eq!(proposal["state"], json!("queued"));

    // the device's own proposal answers for positions along the stretch, marked as its own
    let here = client
        .call("getSpeedLimitAt", json!({ "lat": 52.01, "lng": 13.006 }))
        .await
        .unwrap();
    assert_eq!(here["value"], json!(30.0));
    assert_eq!(here["origin"]["kind"], json!("locallyProposed"));
    assert!(here["segmentKey"].as_str().unwrap().starts_with("ivl:"));
    // and not for a place far from it
    let elsewhere = client
        .call("getSpeedLimitAt", json!({ "lat": 52.012, "lng": 13.006 }))
        .await
        .unwrap();
    assert!(elsewhere.is_null());

    client.sync().await.unwrap();
    let sent = server.bodies_to("POST", "/v1/speed-limit-intervals");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["from"], json!({ "lat": 52.01, "lng": 13.005 }));
    assert_eq!(sent[0]["to"], json!({ "lat": 52.01, "lng": 13.007 }));
    let reference = crate::sync::intervals::interval_ref(
        crate::sync::IntervalPoint {
            lat: 52.01,
            lng: 13.005,
        },
        crate::sync::IntervalPoint {
            lat: 52.01,
            lng: 13.007,
        },
    )
    .unwrap();
    let signed = &sent[0]["deviceAssertion"]["payload"];
    assert_eq!(signed["segmentKey"], json!(reference));
    assert_eq!(signed["vote"], json!("support"));
    assert_eq!(signed["value"], json!(30));
}

#[tokio::test]
async fn the_order_of_the_two_points_does_not_matter_and_a_second_report_replaces_a_queued_one() {
    let server = covered_server();
    let client = client(server.clone());
    client.sync().await.unwrap();
    let report = |from: (f64, f64), to: (f64, f64), value: u32| {
        json!({
            "from": { "lat": from.0, "lng": from.1 }, "to": { "lat": to.0, "lng": to.1 },
            "value": value, "unit": "kmh"
        })
    };
    client
        .call(
            "reportSpeedLimitInterval",
            report((52.01, 13.005), (52.01, 13.007), 30),
        )
        .await
        .unwrap();
    // the same stretch picked from its other end, with another value: one proposal, the newer value
    client
        .call(
            "reportSpeedLimitInterval",
            report((52.01, 13.007), (52.01, 13.005), 50),
        )
        .await
        .unwrap();
    client.sync().await.unwrap();
    let sent = server.bodies_to("POST", "/v1/speed-limit-intervals");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["value"], json!(50));
}

#[tokio::test]
async fn points_that_name_no_stretch_are_refused_before_anything_is_queued() {
    let server = covered_server();
    let client = client(server.clone());
    client.sync().await.unwrap();
    // too close together
    let error = client
        .call(
            "reportSpeedLimitInterval",
            json!({ "from": { "lat": 52.01, "lng": 13.005 }, "to": { "lat": 52.010_01, "lng": 13.005 }, "value": 30, "unit": "kmh" }),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "intervalTooShort");
    // not a position
    let error = client
        .call(
            "reportSpeedLimitInterval",
            json!({ "from": { "lat": 95.0, "lng": 13.005 }, "to": { "lat": 52.01, "lng": 13.007 }, "value": 30, "unit": "kmh" }),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "invalidArgument");
    // a stretch needs both ends
    let error = client
        .call(
            "reportSpeedLimitInterval",
            json!({ "from": { "lat": 52.01, "lng": 13.005 }, "value": 30, "unit": "kmh" }),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "invalidArgument");
    client.sync().await.unwrap();
    assert_eq!(server.count("POST", "/v1/speed-limit-intervals"), 0);
}

#[tokio::test]
async fn implausible_values_are_refused_before_anything_is_queued() {
    let server = covered_server();
    let client = client(server.clone());
    client.sync().await.unwrap();
    for value in [33, 400] {
        let error = client
            .call(
                "reportSpeedLimitInterval",
                json!({ "from": { "lat": 52.01, "lng": 13.005 }, "to": { "lat": 52.01, "lng": 13.007 }, "value": value, "unit": "kmh" }),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalidArgument");
    }
    client.sync().await.unwrap();
    assert_eq!(server.count("POST", "/v1/speed-limit-intervals"), 0);
}

#[tokio::test]
async fn the_road_between_two_points_is_resolved_by_the_server_and_its_refusals_have_codes() {
    let server = covered_server();
    let client = client(server.clone());
    client.sync().await.unwrap();
    server.route(
        "POST",
        "/v1/roads/resolve",
        200,
        json!({
            "ref": "ivl:5201000,1300500:5201000,1300700",
            "segmentKey": "0123456789abcdef0123456789abcdef",
            "geometry": { "type": "LineString", "coordinates": [[13.005, 52.01], [13.006, 52.0102], [13.007, 52.01]] },
            "lengthM": 142.0,
            "road": { "name": "Feldweg", "ref": null, "class": "track" },
            "covered": [{ "segmentId": "s1", "segmentKey": "k", "speedLimit": 100.0, "unit": "kmh", "source": "osm", "coveredMeters": 140.0 }],
            "proposals": []
        }),
    );
    let road = client
        .call(
            "resolveRoadInterval",
            json!({ "from": { "lat": 52.01, "lng": 13.005 }, "to": { "lat": 52.01, "lng": 13.007 } }),
        )
        .await
        .unwrap();
    assert_eq!(road["road"]["name"], json!("Feldweg"));
    assert_eq!(road["geometry"]["coordinates"].as_array().unwrap().len(), 3);
    assert_eq!(road["covered"][0]["speedLimit"], json!(100.0));
    let sent = server.bodies_to("POST", "/v1/roads/resolve");
    assert_eq!(sent[0]["from"], json!({ "lat": 52.01, "lng": 13.005 }));

    server.route(
        "POST",
        "/v1/roads/resolve",
        422,
        json!({ "error": { "code": "NO_ROAD_BETWEEN_POINTS", "message": "no road between" } }),
    );
    let error = client
        .call(
            "resolveRoadInterval",
            json!({ "from": { "lat": 52.01, "lng": 13.005 }, "to": { "lat": 52.02, "lng": 13.007 } }),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "noRoadBetweenPoints");
}

#[tokio::test]
async fn an_entry_can_be_marked_as_wrong_and_the_answer_says_how_many_have() {
    let server = covered_server();
    let client = client(server.clone());
    client.sync().await.unwrap();
    server.route(
        "GET",
        "/v1/data-defects/near",
        200,
        json!({ "items": [{
            "targetType": "speedLimitSegment", "targetId": "00000000-0000-4000-8000-000000000001",
            "distanceMeters": 7, "speedLimit": 51.0, "speedLimitUnit": "kmh", "source": "osm",
            "geometry": { "type": "LineString", "coordinates": [[13.0, 52.0], [13.001, 52.0]] },
            "reports": 1, "threshold": 3
        }] }),
    );
    let items = client
        .call("dataDefectsNear", json!({ "lat": 52.0, "lng": 13.0005 }))
        .await
        .unwrap();
    assert_eq!(items[0]["reports"], json!(1));
    assert_eq!(items[0]["threshold"], json!(3));

    server.route(
        "POST",
        "/v1/data-defects",
        201,
        json!({ "recorded": true, "reports": 2, "threshold": 3, "removed": false }),
    );
    let answer = client
        .call(
            "reportDataDefect",
            json!({ "targetType": "speedLimitSegment", "targetId": "00000000-0000-4000-8000-000000000001", "reason": "not_on_a_road" }),
        )
        .await
        .unwrap();
    assert_eq!(answer["reports"], json!(2));
    assert_eq!(answer["removed"], json!(false));
    let sent = server.bodies_to("POST", "/v1/data-defects");
    assert_eq!(sent[0]["reason"], json!("not_on_a_road"));

    let error = client
        .call(
            "reportDataDefect",
            json!({ "targetType": "hazardReport", "targetId": "x" }),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "invalidArgument");
}

#[tokio::test]
async fn a_lookup_always_says_what_it_found_and_where_it_looked() {
    let server = covered_server();
    let client = client(server.clone());
    client.sync().await.unwrap();

    // a limit, from the local store
    let found = client
        .call("lookupSpeedLimit", json!({ "lat": 52.0, "lng": 13.005 }))
        .await
        .unwrap();
    assert_eq!(found["status"], json!("found"));
    assert_eq!(found["source"], json!("offline"));
    assert_eq!(found["value"], json!(50.0));

    // inside a stored tile but nothing close: the data was looked at and holds no limit - and that is said
    let none = client
        .call("lookupSpeedLimit", json!({ "lat": 52.2, "lng": 13.005 }))
        .await
        .unwrap();
    assert_eq!(
        none,
        json!({ "status": "notRecorded", "source": "offline" })
    );

    // outside every stored tile: the server is asked ...
    server.route(
        "GET",
        "/v1/speed-limit",
        200,
        json!({ "speedLimit": 70, "speedLimitUnit": "kmh", "distanceMeters": 3.5, "segmentId": "far1", "segmentKey": "abc" }),
    );
    let online = client
        .call("lookupSpeedLimit", json!({ "lat": 10.0, "lng": 10.0 }))
        .await
        .unwrap();
    assert_eq!(online["status"], json!("found"));
    assert_eq!(online["source"], json!("online"));
    assert_eq!(online["value"], json!(70.0));
    assert_eq!(online["origin"]["kind"], json!("imported"));

    // ... and when it knows nothing there, that is "not recorded", not an error
    server.route(
        "GET",
        "/v1/speed-limit",
        404,
        json!({ "error": { "code": "NOT_FOUND", "message": "no" } }),
    );
    let empty = client
        .call("lookupSpeedLimit", json!({ "lat": 10.0, "lng": 10.0 }))
        .await
        .unwrap();
    assert_eq!(
        empty,
        json!({ "status": "notRecorded", "source": "online" })
    );
}

#[tokio::test]
async fn outside_the_offline_area_without_a_network_is_said_not_silently_no_limit() {
    let server = covered_server();
    let client = client(server.clone());
    client.sync().await.unwrap();
    // no route for GET /v1/speed-limit: the scripted server answers like a dead network
    let unreachable = client
        .call("lookupSpeedLimit", json!({ "lat": 10.0, "lng": 10.0 }))
        .await
        .unwrap();
    assert_eq!(unreachable, json!({ "status": "outsideOfflineArea" }));
    // and inside the area nothing needs the network
    let covered = client
        .call("lookupSpeedLimit", json!({ "lat": 52.2, "lng": 13.005 }))
        .await
        .unwrap();
    assert_eq!(covered["status"], json!("notRecorded"));
}

// ------------------------------------------------------------ the offline area (docs/offline-storage.md)

const BERLIN: (f64, f64) = (52.52, 13.405);
const MUNICH: (f64, f64) = (48.137, 11.575);
const HAMBURG: (f64, f64) = (53.55, 9.99);

fn tile(place: (f64, f64)) -> String {
    crate::api::tiles::tile_at(place.0, place.1, 4).unwrap()
}

/// A server with three packages (Berlin, Munich, Hamburg), a regions list, and a package per tile holding one road.
fn three_tile_server() -> Arc<ScriptedServer> {
    let server = working_server(false);
    server.route("GET", "/v1/config", 200, config_with_corrections());
    let mut partitions = Vec::new();
    for (name, place, size) in [
        ("berlin", BERLIN, 1_000_000u64),
        ("munich", MUNICH, 2_000_000),
        ("hamburg", HAMBURG, 500_000),
    ] {
        let t = tile(place);
        let package = json!({
            "tile": t,
            "speedLimitSegments": [{
                "id": format!("seg-{name}"),
                "geometry": { "type": "LineString", "coordinates": [[place.1, place.0], [place.1 + 0.002, place.0]] },
                "speedLimit": 50, "speedLimitUnit": "kmh", "source": "osm", "sourceLicense": "ODbL",
                "importedAt": "2027-01-01T00:00:00Z", "lastConfirmedAt": null
            }],
            "staticSigns": [], "fixedSpeedCameras": []
        });
        let hash = hex::encode(Sha256::digest(serde_json::to_vec(&package).unwrap()));
        server.route(
            "GET",
            &format!("/v1/static-data/partitions/{t}"),
            200,
            package,
        );
        partitions.push(json!({ "tile": t, "hash": hash, "sizeBytes": size }));
    }
    server.route(
        "GET",
        "/v1/static-data/manifest",
        200,
        json!({
            "staticDataVersion": 7, "generatedAt": "2027-01-01T00:00:00Z",
            "partitionResolution": 4, "partitions": partitions
        }),
    );
    server.route(
        "GET",
        "/v1/static-data/regions",
        200,
        json!({
            "staticDataVersion": 7, "partitionResolution": 4, "generatedAt": "2027-01-01T00:00:00Z",
            "countryBoundaries": true,
            "regions": [
                { "id": "DE", "country": "DE", "tileCount": 3, "sizeBytes": 3_500_000, "gzipBytes": 900_000,
                  "brotliBytes": 850_000, "complete": true, "bbox": [9.0, 47.0, 14.0, 54.0],
                  "tiles": [tile(BERLIN), tile(MUNICH), tile(HAMBURG)] },
                { "id": "DE-south", "country": null, "tileCount": 1, "sizeBytes": 2_000_000, "gzipBytes": 500_000,
                  "brotliBytes": 470_000, "complete": true, "bbox": [11.0, 47.0, 12.0, 49.0],
                  "tiles": [tile(MUNICH)] }
            ],
            "totals": { "tileCount": 3, "sizeBytes": 3_500_000, "gzipBytes": 900_000, "brotliBytes": 850_000, "complete": true }
        }),
    );
    server
}

fn offline_client(server: Arc<ScriptedServer>) -> (TrafficNetworkClient, Arc<InMemoryStore>) {
    let store = Arc::new(InMemoryStore::new());
    // no preset: the default is the automatic area
    let c = TrafficNetworkClient::new(
        options(),
        Platform {
            store: store.clone(),
            secure_store: Arc::new(MemorySecureStore::new()),
            http: server,
            clock: Arc::new(FixedClock(AtomicI64::new(NOW_MS))),
            ws: Arc::new(NeverWs),
            sleep: Arc::new(NoopSleep),
        },
    )
    .unwrap();
    (c, store)
}

fn stored_tiles(store: &InMemoryStore) -> Vec<String> {
    let mut tiles: Vec<String> = store
        .partition_records()
        .unwrap()
        .into_iter()
        .map(|r| r.tile)
        .collect();
    tiles.sort();
    tiles
}

#[tokio::test]
async fn the_default_is_an_area_around_where_the_device_is_and_nothing_before_it_knows() {
    let server = three_tile_server();
    let (client, store) = offline_client(server.clone());

    // no position, no home: nothing is selected - and the host is told, instead of downloading Europe
    let report = client.sync().await.unwrap();
    assert!(report.needs_location);
    assert_eq!(report.offline_fetched_tiles, 0);
    assert!(stored_tiles(&store).is_empty());
    let plan = client.call("getStoragePlan", json!({})).await.unwrap();
    assert_eq!(plan["needsLocation"], json!(true));
    assert_eq!(plan["mode"], json!("auto"));

    // the first position is home and the area around it: Berlin only
    client
        .call(
            "updatePosition",
            json!({ "lat": BERLIN.0, "lng": BERLIN.1 }),
        )
        .await
        .unwrap();
    let report = client.sync().await.unwrap();
    assert!(!report.needs_location);
    assert_eq!(report.offline_fetched_tiles, 1);
    assert_eq!(stored_tiles(&store), vec![tile(BERLIN)]);
    let settings = client.call("getOfflineSettings", json!({})).await.unwrap();
    assert_eq!(settings["mode"], json!("auto"));
    assert!((settings["home"][0].as_f64().unwrap() - BERLIN.0).abs() < 1e-9);

    // Munich was never asked for, and the lookup there goes online, and says so
    assert_eq!(
        server.count(
            "GET",
            &format!("/v1/static-data/partitions/{}", tile(MUNICH))
        ),
        0
    );
    let coverage = client
        .call("getCoverage", json!({ "lat": BERLIN.0, "lng": BERLIN.1 }))
        .await
        .unwrap();
    assert_eq!(coverage["covered"], json!(true));
    assert_eq!(coverage["state"], json!("stored"));
    let away = client
        .call("getCoverage", json!({ "lat": MUNICH.0, "lng": MUNICH.1 }))
        .await
        .unwrap();
    assert_eq!(away["covered"], json!(false));
    assert_eq!(away["usesNetwork"], json!(true));
}

#[tokio::test]
async fn driving_on_brings_the_new_area_and_keeps_home_and_the_recent_one() {
    let server = three_tile_server();
    let (client, store) = offline_client(server.clone());
    client
        .call(
            "updatePosition",
            json!({ "lat": BERLIN.0, "lng": BERLIN.1 }),
        )
        .await
        .unwrap();
    client.sync().await.unwrap();

    client
        .call(
            "updatePosition",
            json!({ "lat": MUNICH.0, "lng": MUNICH.1 }),
        )
        .await
        .unwrap();
    let report = client.sync().await.unwrap();
    assert_eq!(report.offline_fetched_tiles, 1);
    assert_eq!(stored_tiles(&store), {
        let mut v = vec![tile(BERLIN), tile(MUNICH)];
        v.sort();
        v
    });
    // Berlin is home: it is not let go of; nothing was removed
    assert_eq!(report.offline_removed_tiles, 0);

    // the lookup in Munich is local now
    let found = client
        .call(
            "lookupSpeedLimit",
            json!({ "lat": MUNICH.0, "lng": MUNICH.1 + 0.001 }),
        )
        .await
        .unwrap();
    assert_eq!(found["status"], json!("found"));
    assert_eq!(found["source"], json!("offline"));

    // the use of a package is remembered: what was looked at last is let go of last
    let usage = client.call("getStorageUsage", json!({})).await.unwrap();
    assert_eq!(usage["storedTiles"], json!(2));
    let munich = usage["tiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["tile"] == json!(tile(MUNICH)))
        .unwrap();
    assert_eq!(munich["sizeBytes"], json!(2_000_000));
    assert_eq!(munich["lastUsedUnixMs"], json!(NOW_MS));
}

#[tokio::test]
async fn chosen_regions_are_exactly_what_is_kept_and_a_deselected_one_is_let_go_of() {
    let server = three_tile_server();
    let (client, store) = offline_client(server.clone());
    client
        .call(
            "updatePosition",
            json!({ "lat": BERLIN.0, "lng": BERLIN.1 }),
        )
        .await
        .unwrap();

    let regions = client.call("listOfflineRegions", json!({})).await.unwrap();
    let de = regions["regions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == json!("DE"))
        .unwrap();
    assert_eq!(de["tileCount"], json!(3));
    assert_eq!(de["downloadBytes"], json!(850_000));
    assert_eq!(de["state"], json!("none"));
    assert_eq!(de["selected"], json!(false));

    client
        .call(
            "setOfflineRegions",
            json!({ "mode": "regions", "regions": ["DE"] }),
        )
        .await
        .unwrap();
    let report = client.sync().await.unwrap();
    assert_eq!(report.offline_fetched_tiles, 3);
    assert_eq!(stored_tiles(&store).len(), 3);
    let regions = client.call("listOfflineRegions", json!({})).await.unwrap();
    let de = regions["regions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == json!("DE"))
        .unwrap();
    assert_eq!(
        (
            de["state"].as_str().unwrap(),
            de["selected"].as_bool().unwrap()
        ),
        ("complete", true)
    );

    // only the south: the rest is let go of at once, including its data
    client
        .call(
            "setOfflineRegions",
            json!({ "mode": "regions", "regions": ["DE-south"] }),
        )
        .await
        .unwrap();
    let report = client.sync().await.unwrap();
    // Berlin is the home area: kept; Hamburg is not
    assert_eq!(report.offline_removed_tiles, 1);
    assert_eq!(stored_tiles(&store), {
        let mut v = vec![tile(BERLIN), tile(MUNICH)];
        v.sort();
        v
    });
    let ids: Vec<String> = store
        .all_entities()
        .unwrap()
        .speed_limit_segments
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert!(
        !ids.contains(&"seg-hamburg".to_string()),
        "its data went with it"
    );
    assert!(ids.contains(&"seg-munich".to_string()));
}

#[tokio::test]
async fn the_limit_lets_go_of_the_longest_unused_and_never_of_home() {
    let server = three_tile_server();
    let (client, store) = offline_client(server.clone());
    // Berlin 1 MB json (0.7 device), Munich 2 MB (1.4), Hamburg 0.5 MB (0.35)
    client
        .call(
            "updatePosition",
            json!({ "lat": BERLIN.0, "lng": BERLIN.1 }),
        )
        .await
        .unwrap();
    client.sync().await.unwrap();
    client
        .call(
            "updatePosition",
            json!({ "lat": HAMBURG.0, "lng": HAMBURG.1 }),
        )
        .await
        .unwrap();
    client.sync().await.unwrap();
    assert_eq!(stored_tiles(&store).len(), 2);

    // room for Munich needs 1.4 MB; limit 2.2 MB: home (Berlin 0.7) stays, Hamburg (0.35) goes - it is only
    // kept as a recent place, and recent places are switched off here
    client
        .call("setAutoRegionPolicy", json!({ "recentPlaces": 0 }))
        .await
        .unwrap();
    client
        .call("setStorageLimits", json!({ "maxBytes": 2_200_000 }))
        .await
        .unwrap();
    client
        .call(
            "updatePosition",
            json!({ "lat": MUNICH.0, "lng": MUNICH.1 }),
        )
        .await
        .unwrap();
    let plan = client.call("getStoragePlan", json!({})).await.unwrap();
    assert_eq!(plan["maxBytes"], json!(2_200_000));
    assert_eq!(plan["toFetchTiles"], json!(1));
    assert_eq!(plan["fits"], json!(true));

    let report = client.sync().await.unwrap();
    assert_eq!(report.offline_fetched_tiles, 1);
    assert!(
        stored_tiles(&store).contains(&tile(BERLIN)),
        "home is never let go of"
    );
    assert!(stored_tiles(&store).contains(&tile(MUNICH)));
    assert!(
        !stored_tiles(&store).contains(&tile(HAMBURG)),
        "the unwanted, unused one made room"
    );
}

#[tokio::test]
async fn a_package_that_cannot_fit_is_deferred_and_nothing_is_thrown_away_for_it() {
    let server = three_tile_server();
    let (client, store) = offline_client(server.clone());
    client
        .call(
            "updatePosition",
            json!({ "lat": BERLIN.0, "lng": BERLIN.1 }),
        )
        .await
        .unwrap();
    client.sync().await.unwrap();
    // Munich needs 1.4 MB on the device: not even with every unprotected package gone
    client
        .call("setStorageLimits", json!({ "maxBytes": 1_000_000 }))
        .await
        .unwrap();
    client
        .call(
            "updatePosition",
            json!({ "lat": MUNICH.0, "lng": MUNICH.1 }),
        )
        .await
        .unwrap();
    let plan = client.call("getStoragePlan", json!({})).await.unwrap();
    assert_eq!(plan["deferredForLimit"], json!(1));
    assert_eq!(plan["fits"], json!(false));

    let report = client.sync().await.unwrap();
    assert_eq!(report.offline_deferred_tiles, 1);
    assert_eq!(report.offline_fetched_tiles, 0);
    assert_eq!(stored_tiles(&store), vec![tile(BERLIN)]);
}

#[tokio::test]
async fn a_metered_connection_holds_back_everything_but_the_tile_of_the_current_position() {
    let server = three_tile_server();
    let (client, store) = offline_client(server.clone());
    client
        .call(
            "setAutoRegionPolicy",
            json!({ "homeLat": HAMBURG.0, "homeLng": HAMBURG.1 }),
        )
        .await
        .unwrap();
    client
        .call("setConnectionMetered", json!({ "metered": true }))
        .await
        .unwrap();
    client
        .call(
            "updatePosition",
            json!({ "lat": BERLIN.0, "lng": BERLIN.1 }),
        )
        .await
        .unwrap();

    let report = client.sync().await.unwrap();
    // Berlin (here) is let through, Hamburg (home) waits for an unmetered connection
    assert_eq!(report.offline_fetched_tiles, 1);
    assert_eq!(report.offline_deferred_tiles, 1);
    assert_eq!(stored_tiles(&store), vec![tile(BERLIN)]);

    client
        .call("setConnectionMetered", json!({ "metered": false }))
        .await
        .unwrap();
    let report = client.sync().await.unwrap();
    assert_eq!(report.offline_fetched_tiles, 1);
    assert_eq!(stored_tiles(&store).len(), 2);
}

#[tokio::test]
async fn everything_remains_possible_and_the_settings_survive_a_restart() {
    let server = three_tile_server();
    let (client, store) = offline_client(server.clone());
    client
        .call("setOfflineRegions", json!({ "mode": "all" }))
        .await
        .unwrap();
    let report = client.sync().await.unwrap();
    assert_eq!(report.offline_fetched_tiles, 3);

    // a second client on the same store reads the same settings
    let again = client_on(server, store.clone() as Arc<dyn Store>, options());
    let settings = again.call("getOfflineSettings", json!({})).await.unwrap();
    assert_eq!(settings["mode"], json!("all"));
}

#[tokio::test]
async fn an_older_server_without_a_regions_list_says_so() {
    let server = working_server(false);
    server.route("GET", "/v1/config", 200, config_with_corrections());
    server.route(
        "GET",
        "/v1/static-data/regions",
        404,
        json!({ "error": { "code": "NOT_FOUND", "message": "no" } }),
    );
    let (client, _) = offline_client(server);
    client.sync().await.unwrap();
    let error = client
        .call("listOfflineRegions", json!({}))
        .await
        .unwrap_err();
    assert_eq!(error.code, "notOffered");
}

fn context_sign_server() -> Arc<ScriptedServer> {
    let server = working_server(false);
    let tile = crate::api::tiles::tile_at(52.0, 13.0, 4).unwrap();
    server.route(
        "GET",
        "/v1/context-signs/tiles",
        200,
        json!({ "version": 3, "unchanged": false, "tiles": [{ "tile": tile, "entries": [{
            "id": "e1", "signType": "DE:276", "geometry": [[12.999, 52.0], [13.003, 52.0]], "direction": "along",
            "validity": { "v": 1, "tz": "Europe/Berlin" }, "value": null, "unit": null, "lengthM": 274.0,
            "status": "confirmed", "confirmed": true, "confirmations": 3, "denials": 0, "expiresAt": null
        }] }] }),
    );
    server.route(
        "POST",
        "/v1/context-signs/e1/confirmations",
        200,
        json!({ "recorded": true }),
    );
    server
}

#[tokio::test]
async fn context_signs_arrive_with_a_sync_and_are_read_offline_for_a_position_and_a_heading() {
    let server = context_sign_server();
    let client = client(server.clone());
    client.update_position(52.0, 13.0, None).unwrap();

    let report = client.call("sync", json!({})).await.unwrap();
    assert_eq!(report["ok"], true);
    assert_eq!(report["contextSignsEntries"], 1);

    let at = "2026-10-14T10:00:00Z";
    let east = client
        .call(
            "getContextSigns",
            json!({ "lat": 52.0, "lng": 13.0, "heading": 90, "at": at }),
        )
        .await
        .unwrap();
    assert_eq!(east["covered"], true);
    assert_eq!(east["entriesHeld"], 1);
    let sign = &east["signs"][0];
    assert_eq!(
        (
            sign["id"].as_str(),
            sign["signType"].as_str(),
            sign["activeNow"].as_bool()
        ),
        (Some("e1"), Some("DE:276"), Some(true))
    );
    assert!(sign["startsInM"].as_f64().unwrap() < 0.0 && sign["endsInM"].as_f64().unwrap() > 100.0);
    assert!(sign["validUntil"].is_null());

    // against the one-way sign, and without knowing the way: nothing
    let west = client
        .call(
            "getContextSigns",
            json!({ "lat": 52.0, "lng": 13.0, "heading": 270, "at": at }),
        )
        .await
        .unwrap();
    assert!(west["signs"].as_array().unwrap().is_empty());
    let unknown = client
        .call(
            "getContextSigns",
            json!({ "lat": 52.0, "lng": 13.0, "at": at }),
        )
        .await
        .unwrap();
    assert!(unknown["signs"].as_array().unwrap().is_empty());

    // a place the device holds nothing for: empty, and it says so
    let far = client
        .call(
            "getContextSigns",
            json!({ "lat": -30.0, "lng": 20.0, "heading": 90, "at": at }),
        )
        .await
        .unwrap();
    assert_eq!(far["covered"], false);
    assert!(far["signs"].as_array().unwrap().is_empty());

    // a vote is queued and goes out with the next sync
    let id = client
        .call("voteContextSign", json!({ "id": "e1", "agrees": true }))
        .await
        .unwrap();
    assert!(id["localId"].is_string());
    client.call("sync", json!({})).await.unwrap();
    assert_eq!(
        server.count("POST", "/v1/context-signs/e1/confirmations"),
        1
    );

    // arguments are checked
    let bad = client
        .call(
            "getContextSigns",
            json!({ "lat": 52.0, "lng": 13.0, "aheadMeters": -5 }),
        )
        .await
        .unwrap_err();
    assert_eq!(bad.code, code::INVALID_ARGUMENT);
    let bad = client
        .call(
            "getContextSigns",
            json!({ "lat": 52.0, "lng": 13.0, "at": "yesterday" }),
        )
        .await
        .unwrap_err();
    assert_eq!(bad.code, code::INVALID_ARGUMENT);
    let bad = client
        .call(
            "voteContextSign",
            json!({ "id": "unknown", "agrees": true }),
        )
        .await
        .unwrap_err();
    assert_eq!(bad.code, code::INVALID_ARGUMENT);
}

#[tokio::test]
async fn a_server_without_context_signs_does_not_make_a_sync_fail() {
    // working_server has no route for the tiles: an older server answers 404, a scripted gap is a network error - neither fails the sync
    let client = client(working_server(false));
    client.update_position(52.0, 13.0, None).unwrap();
    let report = client.call("sync", json!({})).await.unwrap();
    assert_eq!(report["ok"], true);
    let signs = client
        .call(
            "getContextSigns",
            json!({ "lat": 52.0, "lng": 13.0, "heading": 90 }),
        )
        .await
        .unwrap();
    assert!(signs["signs"].as_array().unwrap().is_empty());
}
