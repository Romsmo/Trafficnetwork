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
