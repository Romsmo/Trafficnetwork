// Native-only: uses `#[tokio::test]`, which needs a real tokio runtime. (Included by `context_signs.rs` as its `tests` module.)
use super::*;
use crate::crypto::{generate_ed25519_keypair, verify_signed_envelope, SignedEnvelope};
use crate::discovery::DiscoveryConfig;
use crate::platform::{HttpError, HttpTransport};
use crate::storage::InMemoryStore;
use crate::sync::writebuffer::flush_pending;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

const T0: i64 = 1_000_000;
const A: &str = "https://a.example";
const ENTRY: &str = "0123456789abcdef0123456789abcdef";

struct FixedClock(AtomicI64);
impl Clock for FixedClock {
    fn now_unix_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct MockTransport {
    responses: Mutex<HashMap<String, HttpResponse>>,
    seen: Mutex<Vec<(String, Option<Vec<u8>>)>>,
}
impl MockTransport {
    fn new() -> Self {
        Self {
            responses: Mutex::new(HashMap::new()),
            seen: Mutex::new(Vec::new()),
        }
    }
    fn set(&self, url: &str, status: u16, body: Value) {
        self.responses.lock().unwrap().insert(
            url.to_string(),
            HttpResponse {
                status,
                body: serde_json::to_vec(&body).unwrap(),
            },
        );
    }
    fn bodies_to(&self, url: &str) -> Vec<Value> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(u, _)| u == url)
            .filter_map(|(_, b)| b.as_ref())
            .filter_map(|b| serde_json::from_slice(b).ok())
            .collect()
    }
    fn urls(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|(u, _)| u.clone())
            .collect()
    }
}
#[async_trait::async_trait]
impl HttpTransport for MockTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        self.seen
            .lock()
            .unwrap()
            .push((request.url.clone(), request.body.clone()));
        self.responses
            .lock()
            .unwrap()
            .get(&request.url)
            .cloned()
            .ok_or_else(|| HttpError::Network(format!("no mock response for {}", request.url)))
    }
}

struct Fixture {
    store: InMemoryStore,
    discovery: DiscoveryService,
    transport: Arc<MockTransport>,
    clock: Arc<FixedClock>,
}

fn fixture() -> Fixture {
    let transport = Arc::new(MockTransport::new());
    let clock = Arc::new(FixedClock(AtomicI64::new(T0)));
    let discovery =
        DiscoveryService::new(transport.clone(), clock.clone(), DiscoveryConfig::default());
    discovery.seed_fixed_nodes(&[("node1".to_string(), A.to_string())]);
    Fixture {
        store: InMemoryStore::new(),
        discovery,
        transport,
        clock,
    }
}

fn entry_json(id: &str, sign: &str) -> Value {
    json!({
        "id": id, "signType": sign, "geometry": [[10.0, 50.0], [10.002, 50.0]], "direction": "along",
        "validity": { "v": 1, "tz": "Europe/Berlin" }, "value": null, "unit": null, "lengthM": 143.0,
        "status": "confirmed", "confirmed": true, "confirmations": 3, "denials": 0,
        "firstProposedAt": "2026-10-01T00:00:00.000Z", "lastConfirmedAt": null, "expiresAt": null
    })
}

fn tiles(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|s| s.to_string()).collect()
}

fn tiles_url(query: &str) -> String {
    format!("{A}/v1/context-signs/tiles?{query}")
}

#[tokio::test]
async fn the_offline_copy_follows_the_wanted_tiles_and_asks_only_what_moved() {
    let f = fixture();
    f.transport.set(
        &tiles_url("tiles=t1,t2"),
        200,
        json!({ "version": 5, "unchanged": false, "tiles": [
            { "tile": "t1", "entries": [entry_json("e1", "DE:276")] }, { "tile": "t2", "entries": [] } ] }),
    );

    let first = sync_context_signs(&f.store, &f.discovery, "token", &tiles(&["t1", "t2"]))
        .await
        .unwrap();
    assert_eq!(
        first,
        ContextSignSyncOutcome {
            tiles: 2,
            entries: 1,
            changed: true,
            not_offered: false
        }
    );
    assert_eq!(stored_entries(&f.store).len(), 1);
    assert_eq!(stored_tiles(&f.store), tiles(&["t1", "t2"]));

    // both tiles are held at version 5: the next ask names it, and "unchanged" is a few bytes
    f.transport.set(
        &tiles_url("tiles=t1,t2&since=5"),
        200,
        json!({ "version": 5, "unchanged": true, "tiles": [] }),
    );
    let again = sync_context_signs(&f.store, &f.discovery, "token", &tiles(&["t1", "t2"]))
        .await
        .unwrap();
    assert!(!again.changed);
    assert_eq!(again.entries, 1);

    // a tile nobody wants any more is let go, a new one is fetched without "since" (it is not held)
    f.transport.set(
        &tiles_url("tiles=t1,t3"),
        200,
        json!({ "version": 6, "unchanged": false, "tiles": [
            { "tile": "t1", "entries": [entry_json("e1", "DE:276"), entry_json("e2", "DE:283")] }, { "tile": "t3", "entries": [] } ] }),
    );
    let moved = sync_context_signs(&f.store, &f.discovery, "token", &tiles(&["t1", "t3"]))
        .await
        .unwrap();
    assert!(moved.changed);
    assert_eq!(stored_tiles(&f.store), tiles(&["t1", "t3"]));
    assert_eq!(stored_entries(&f.store).len(), 2);
}

#[tokio::test]
async fn an_entry_on_several_tiles_is_one_entry() {
    let f = fixture();
    f.transport.set(
        &tiles_url("tiles=t1,t2"),
        200,
        json!({ "version": 1, "unchanged": false, "tiles": [
            { "tile": "t1", "entries": [entry_json("e1", "DE:276")] }, { "tile": "t2", "entries": [entry_json("e1", "DE:276")] } ] }),
    );
    sync_context_signs(&f.store, &f.discovery, "token", &tiles(&["t1", "t2"]))
        .await
        .unwrap();
    assert_eq!(stored_entries(&f.store).len(), 1);
}

#[tokio::test]
async fn a_server_without_context_signs_empties_the_copy_and_is_not_an_error() {
    let f = fixture();
    f.transport.set(&tiles_url("tiles=t1"), 200, json!({ "version": 1, "unchanged": false, "tiles": [{ "tile": "t1", "entries": [entry_json("e1", "DE:276")] }] }));
    sync_context_signs(&f.store, &f.discovery, "token", &tiles(&["t1"]))
        .await
        .unwrap();
    f.transport.set(
        &tiles_url("tiles=t1&since=1"),
        404,
        json!({ "error": { "code": "NOT_FOUND" } }),
    );
    let outcome = sync_context_signs(&f.store, &f.discovery, "token", &tiles(&["t1"]))
        .await
        .unwrap();
    assert!(outcome.not_offered && outcome.changed);
    assert!(stored_entries(&f.store).is_empty());
}

#[tokio::test]
async fn a_failing_server_leaves_the_copy_as_it_was() {
    let f = fixture();
    f.transport.set(&tiles_url("tiles=t1"), 200, json!({ "version": 1, "unchanged": false, "tiles": [{ "tile": "t1", "entries": [entry_json("e1", "DE:276")] }] }));
    sync_context_signs(&f.store, &f.discovery, "token", &tiles(&["t1"]))
        .await
        .unwrap();
    f.transport
        .set(&tiles_url("tiles=t1&since=1"), 500, json!({}));
    assert!(
        sync_context_signs(&f.store, &f.discovery, "token", &tiles(&["t1"]))
            .await
            .is_err()
    );
    assert_eq!(stored_entries(&f.store).len(), 1);
}

fn request() -> ContextSignRequest {
    ContextSignRequest {
        sign_type: "DE:276".to_string(),
        from: PointJson {
            lat: 50.0,
            lng: 10.0,
        },
        to: Some(PointJson {
            lat: 50.0,
            lng: 10.002,
        }),
        direction: Some(Direction::Along),
        heading: None,
        validity: None,
        value: None,
        unit: None,
    }
}

#[test]
fn a_request_that_cannot_be_right_is_refused_before_anything_is_queued() {
    let f = fixture();
    let clock = FixedClock(AtomicI64::new(T0));
    let mut bad = request();
    bad.from = PointJson { lat: 0.0, lng: 0.0 };
    assert!(matches!(
        queue_context_sign_proposal(&f.store, &clock, &bad),
        Err(ContextSignError::Invalid(_))
    ));
    let mut bad = request();
    bad.sign_type = " ".to_string();
    assert!(queue_context_sign_proposal(&f.store, &clock, &bad).is_err());
    let mut bad = request();
    bad.heading = Some(400.0);
    assert!(queue_context_sign_proposal(&f.store, &clock, &bad).is_err());
    assert!(f.store.pending_writes().unwrap().is_empty());
}

fn preview_json(existing: Option<Value>) -> Value {
    json!({
        "descriptor": { "v": 1, "signType": "DE:276", "geometry": [[10.0, 50.0], [10.002, 50.0]], "direction": "along",
                        "validity": { "v": 1, "tz": "Europe/Berlin" }, "value": null, "unit": null },
        "entryKey": ENTRY, "lengthM": 143.0, "road": { "name": "Hauptstrasse", "ref": null, "class": "residential" },
        "timezone": "Europe/Berlin", "existing": existing, "similar": []
    })
}

const RESOLVE: &str = "https://a.example/v1/context-signs/resolve";
const PROPOSE: &str = "https://a.example/v1/context-signs";

#[tokio::test]
async fn a_queued_proposal_is_resolved_signed_when_sent_and_survives_being_offline() {
    let f = fixture();
    queue_context_sign_proposal(&f.store, &*f.clock, &request()).unwrap();
    let key = generate_ed25519_keypair().unwrap();
    f.transport.set(RESOLVE, 200, preview_json(None));
    f.transport.set(
        PROPOSE,
        201,
        json!({ "recorded": true, "created": true, "entry": entry_json(ENTRY, "DE:276") }),
    );
    // offline for five minutes - far past a signature window of 60 seconds: it is signed now, not when it was made
    f.clock.0.fetch_add(5 * 60 * 1000, Ordering::SeqCst);

    let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", Some(&key))
        .await
        .unwrap();

    assert!(matches!(
        outcomes.as_slice(),
        [FlushOutcome::Submitted { .. }]
    ));
    assert!(f.store.pending_writes().unwrap().is_empty());
    let resolve_body = &f.transport.bodies_to(RESOLVE)[0];
    assert_eq!(resolve_body["signType"], "DE:276");
    assert_eq!(resolve_body["from"]["lat"], 50.0);
    let sent = &f.transport.bodies_to(PROPOSE)[0];
    assert_eq!(sent["descriptor"]["signType"], "DE:276");
    let payload = &sent["deviceAssertion"]["payload"];
    assert_eq!(payload["kind"], "contextSignVote");
    assert_eq!(payload["vote"], "support");
    assert_eq!(payload["entryKey"], ENTRY);
    assert_eq!(payload["entry"], sent["descriptor"]);
    assert_eq!(payload["devicePublicKey"], key.public_key_raw);
    let signed_at = chrono::DateTime::parse_from_rfc3339(payload["timestamp"].as_str().unwrap())
        .unwrap()
        .timestamp_millis();
    assert_eq!(signed_at, T0 + 5 * 60 * 1000);
    let envelope: SignedEnvelope<Value> =
        serde_json::from_value(sent["deviceAssertion"].clone()).unwrap();
    assert!(verify_signed_envelope(&envelope, &key.public_key_raw));
}

#[tokio::test]
async fn a_proposal_for_a_sign_that_exists_becomes_a_confirmation_of_it() {
    let f = fixture();
    queue_context_sign_proposal(&f.store, &*f.clock, &request()).unwrap();
    let key = generate_ed25519_keypair().unwrap();
    f.transport.set(
        RESOLVE,
        200,
        preview_json(Some(entry_json(ENTRY, "DE:276"))),
    );
    let confirm = format!("{A}/v1/context-signs/{ENTRY}/confirmations");
    f.transport
        .set(&confirm, 200, json!({ "recorded": true, "created": false }));

    let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", Some(&key))
        .await
        .unwrap();

    assert!(matches!(
        outcomes.as_slice(),
        [FlushOutcome::Submitted { .. }]
    ));
    assert!(f.transport.bodies_to(PROPOSE).is_empty());
    let sent = &f.transport.bodies_to(&confirm)[0];
    assert_eq!(sent["kind"], "confirm");
    assert_eq!(sent["deviceAssertion"]["payload"]["vote"], "support");
    assert_eq!(
        sent["deviceAssertion"]["payload"]["entry"]["signType"],
        "DE:276"
    );
}

#[tokio::test]
async fn without_a_device_key_it_is_sent_unsigned() {
    let f = fixture();
    queue_context_sign_proposal(&f.store, &*f.clock, &request()).unwrap();
    f.transport.set(RESOLVE, 200, preview_json(None));
    f.transport.set(PROPOSE, 201, json!({ "recorded": true }));
    flush_pending(&f.store, &f.discovery, &*f.clock, "token", None)
        .await
        .unwrap();
    assert!(f.transport.bodies_to(PROPOSE)[0]
        .get("deviceAssertion")
        .is_none());
}

#[tokio::test]
async fn a_refusal_drops_the_write_and_a_busy_or_unreachable_server_keeps_it() {
    let f = fixture();
    queue_context_sign_proposal(&f.store, &*f.clock, &request()).unwrap();
    // the node cannot find a road there: permanent
    f.transport.set(
        RESOLVE,
        422,
        json!({ "error": { "code": "NO_ROAD_FOUND", "message": "no road" } }),
    );
    let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", None)
        .await
        .unwrap();
    assert!(matches!(
        outcomes.as_slice(),
        [FlushOutcome::Rejected { status: 422, .. }]
    ));
    assert!(f.store.pending_writes().unwrap().is_empty());

    // the node's budget: later
    queue_context_sign_proposal(&f.store, &*f.clock, &request()).unwrap();
    f.transport.set(RESOLVE, 200, preview_json(None));
    f.transport.set(
        PROPOSE,
        429,
        json!({ "error": { "code": "TOO_MANY_REQUESTS" } }),
    );
    let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", None)
        .await
        .unwrap();
    assert!(matches!(outcomes.as_slice(), [FlushOutcome::Failed { .. }]));
    let pending = f.store.pending_writes().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].attempts, 1);

    // nobody answers: later, too
    f.transport.responses.lock().unwrap().clear();
    let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", None)
        .await
        .unwrap();
    assert!(matches!(outcomes.as_slice(), [FlushOutcome::Failed { .. }]));
    assert_eq!(f.store.pending_writes().unwrap().len(), 1);
}

fn hold(f: &Fixture, entries: &[Value]) {
    let data = StoredData {
        tiles: BTreeMap::from([(
            "t1".to_string(),
            StoredTile {
                version: 1,
                entries: entries
                    .iter()
                    .map(|e| serde_json::from_value(e.clone()).unwrap())
                    .collect(),
            },
        )]),
    };
    save(&f.store, &data).unwrap();
}

#[tokio::test]
async fn a_vote_is_queued_signed_when_sent_and_the_newest_stance_wins() {
    let f = fixture();
    hold(&f, &[entry_json(ENTRY, "DE:283")]);
    queue_context_sign_vote(&f.store, &*f.clock, ENTRY, false).unwrap();
    queue_context_sign_vote(&f.store, &*f.clock, ENTRY, true).unwrap();
    assert_eq!(f.store.pending_writes().unwrap().len(), 1);

    let key = generate_ed25519_keypair().unwrap();
    let url = format!("{A}/v1/context-signs/{ENTRY}/confirmations");
    f.transport.set(&url, 200, json!({ "recorded": true }));
    let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", Some(&key))
        .await
        .unwrap();

    assert!(matches!(
        outcomes.as_slice(),
        [FlushOutcome::Submitted { .. }]
    ));
    let sent = &f.transport.bodies_to(&url)[0];
    assert_eq!(sent["kind"], "confirm");
    let payload = &sent["deviceAssertion"]["payload"];
    assert_eq!(
        (payload["vote"].as_str(), payload["entryKey"].as_str()),
        (Some("support"), Some(ENTRY))
    );
    assert_eq!(payload["entry"]["signType"], "DE:283");
    assert_eq!(payload["entry"]["direction"], "along");
    assert!(f.transport.urls().iter().all(|u| !u.contains("/resolve")));
}

#[tokio::test]
async fn an_objection_carries_only_the_key() {
    let f = fixture();
    hold(&f, &[entry_json(ENTRY, "DE:283")]);
    queue_context_sign_vote(&f.store, &*f.clock, ENTRY, false).unwrap();
    let key = generate_ed25519_keypair().unwrap();
    let url = format!("{A}/v1/context-signs/{ENTRY}/confirmations");
    f.transport.set(&url, 200, json!({ "recorded": true }));
    flush_pending(&f.store, &f.discovery, &*f.clock, "token", Some(&key))
        .await
        .unwrap();
    let sent = &f.transport.bodies_to(&url)[0];
    assert_eq!(sent["kind"], "deny");
    assert_eq!(sent["deviceAssertion"]["payload"]["vote"], "deny");
    assert!(sent["deviceAssertion"]["payload"].get("entry").is_none());
}

#[test]
fn a_confirmation_needs_the_entry_the_device_holds() {
    let f = fixture();
    assert!(matches!(
        queue_context_sign_vote(&f.store, &*f.clock, ENTRY, true),
        Err(ContextSignError::Invalid(_))
    ));
    // an objection does not: the key is enough
    assert!(queue_context_sign_vote(&f.store, &*f.clock, ENTRY, false).is_ok());
}

#[tokio::test]
async fn the_preview_is_asked_of_the_node_and_a_missing_feature_is_not_offered() {
    let f = fixture();
    f.transport.set(RESOLVE, 200, preview_json(None));
    let preview = resolve_context_sign(&f.discovery, "token", &request())
        .await
        .unwrap();
    assert_eq!(preview.entry_key, ENTRY);
    assert_eq!(preview.road.name.as_deref(), Some("Hauptstrasse"));
    assert!(preview.existing.is_none());

    f.transport.set(RESOLVE, 404, json!({}));
    assert_eq!(
        resolve_context_sign(&f.discovery, "token", &request()).await,
        Err(ContextSignError::NotOffered)
    );
    f.transport.set(
        RESOLVE,
        422,
        json!({ "error": { "code": "UNKNOWN_SIGN", "message": "x" } }),
    );
    assert!(matches!(
        resolve_context_sign(&f.discovery, "token", &request()).await,
        Err(ContextSignError::Refused { status: 422, .. })
    ));
}

#[test]
fn the_wanted_tiles_are_the_packages_and_the_ring_around_the_position() {
    let f = fixture();
    assert!(wanted_tiles(&f.store, 4, None).is_empty());
    let around = wanted_tiles(&f.store, 4, Some((50.0, 10.0)));
    assert_eq!(around.len(), 7);
}
