//! Offline write buffer: [`submit_report`] persists a `POST
//! /v1/hazard-reports` submission via `storage::Store` before ever
//! attempting a network call, so it survives a process restart;
//! [`flush_pending`] retries whatever's still queued against the current
//! server pool.
//!
//! Deliberately **not** signed at `submit_report` time: a `deviceAssertion`
//! must carry a timestamp within 60 seconds of server time
//! (`server/docs/api.md`'s `ASSERTION_FRESHNESS_WINDOW_SECONDS`), so a
//! report that sits in the buffer for longer than that — the whole point of
//! an *offline* write buffer — would have a permanently stale signature by
//! the time a connection comes back. `flush_pending` signs fresh, with the
//! current time, on every attempt instead.

use serde::Serialize;

use crate::crypto::{sign_envelope, CanonicalError, Ed25519KeyPair, SignedEnvelope};
use crate::discovery::DiscoveryService;
use crate::platform::{Clock, HttpRequest};
use crate::storage::{PendingWrite, Store, StoreError};

use super::types::HazardType;

#[derive(Debug)]
pub enum WriteBufferError {
    Store(StoreError),
    Signing(String),
}

impl std::fmt::Display for WriteBufferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteBufferError::Store(e) => write!(f, "storage error: {e}"),
            WriteBufferError::Signing(msg) => write!(f, "signing error: {msg}"),
        }
    }
}

impl std::error::Error for WriteBufferError {}

pub struct ReportSubmission {
    pub hazard_type: HazardType,
    pub lat: f64,
    pub lng: f64,
    pub speed_kmh: Option<f64>,
}

/// Builds the plain (unsigned) `POST /v1/hazard-reports` body and enqueues
/// it in `store`. Returns the local queue id — not a server report id, that
/// only exists once [`flush_pending`] succeeds.
pub fn submit_report(
    store: &dyn Store,
    clock: &dyn Clock,
    submission: &ReportSubmission,
) -> Result<String, WriteBufferError> {
    let now = clock.now_unix_ms();
    let mut body = serde_json::json!({
        "type": submission.hazard_type,
        "lat": submission.lat,
        "lng": submission.lng,
    });
    if let Some(speed_kmh) = submission.speed_kmh {
        body["speedKmh"] = serde_json::json!(speed_kmh);
    }

    let id = local_write_id(&body, now);
    let item = PendingWrite {
        id: id.clone(),
        request_body: body,
        created_at_unix_ms: now,
        attempts: 0,
    };
    store.enqueue_write(&item).map_err(WriteBufferError::Store)?;
    Ok(id)
}

#[derive(Debug)]
pub enum FlushOutcome {
    /// Accepted by the server (`201`/`200`), or a `409
    /// DUPLICATE_FEDERATION_EVENT` for a signed submission the server
    /// already had — either way, nothing left to retry.
    Submitted { local_id: String, merged: bool },
    /// A permanent rejection (any `4xx` other than `409`) — retrying the
    /// identical body would just fail again, so it's dropped rather than
    /// retried forever.
    Rejected { local_id: String, status: u16 },
    /// Every server in the pool failed (network error / `5xx`) — left in
    /// the queue with `attempts` incremented, for the next `flush_pending`.
    Failed { local_id: String },
}

/// Retries every currently queued submission, signing each fresh (see the
/// module doc) when `device_key` is `Some`. Submissions without a bound
/// device key are sent unsigned, exactly as before device identity existed
/// — federation replication just won't pick them up
/// (`server/docs/api.md`'s `deviceAssertion` is optional).
pub async fn flush_pending(
    store: &dyn Store,
    discovery: &DiscoveryService,
    clock: &dyn Clock,
    bearer_token: &str,
    device_key: Option<&Ed25519KeyPair>,
) -> Result<Vec<FlushOutcome>, WriteBufferError> {
    let pending = store.pending_writes().map_err(WriteBufferError::Store)?;
    let mut outcomes = Vec::with_capacity(pending.len());

    for item in pending {
        let mut body = item.request_body.clone();
        if let Some(key) = device_key {
            let assertion = build_device_assertion(&body, clock.now_unix_ms(), key)
                .map_err(|e| WriteBufferError::Signing(e.to_string()))?;
            body["deviceAssertion"] = serde_json::to_value(&assertion)
                .map_err(|e| WriteBufferError::Signing(e.to_string()))?;
        }

        let result = discovery
            .request_with_failover(|server| {
                let url = format!(
                    "{}/v1/hazard-reports",
                    server.address.trim_end_matches('/')
                );
                HttpRequest::post_json(url, &body)
                    .expect("pending write body always serializes")
                    .with_header("Authorization", format!("Bearer {bearer_token}"))
            })
            .await;

        match result {
            Ok((_, response)) if response.is_success() => {
                store
                    .remove_pending_write(&item.id)
                    .map_err(WriteBufferError::Store)?;
                let merged = response
                    .json()
                    .ok()
                    .and_then(|v| v.get("merged").and_then(|m| m.as_bool()))
                    .unwrap_or(false);
                outcomes.push(FlushOutcome::Submitted {
                    local_id: item.id,
                    merged,
                });
            }
            Ok((_, response)) if response.status == 409 => {
                store
                    .remove_pending_write(&item.id)
                    .map_err(WriteBufferError::Store)?;
                outcomes.push(FlushOutcome::Submitted {
                    local_id: item.id,
                    merged: false,
                });
            }
            Ok((_, response)) => {
                store
                    .remove_pending_write(&item.id)
                    .map_err(WriteBufferError::Store)?;
                outcomes.push(FlushOutcome::Rejected {
                    local_id: item.id,
                    status: response.status,
                });
            }
            Err(_) => {
                let mut retried = item.clone();
                retried.attempts += 1;
                store
                    .enqueue_write(&retried)
                    .map_err(WriteBufferError::Store)?;
                outcomes.push(FlushOutcome::Failed { local_id: item.id });
            }
        }
    }
    Ok(outcomes)
}

#[derive(Debug, Clone, Serialize)]
struct DeviceCreateEventPayload {
    kind: &'static str,
    #[serde(rename = "type")]
    hazard_type: HazardType,
    lat: f64,
    lng: f64,
    #[serde(rename = "speedKmh", skip_serializing_if = "Option::is_none")]
    speed_kmh: Option<f64>,
    #[serde(rename = "devicePublicKey")]
    device_public_key: String,
    timestamp: String,
}

fn build_device_assertion(
    body: &serde_json::Value,
    now_unix_ms: i64,
    key: &Ed25519KeyPair,
) -> Result<SignedEnvelope<DeviceCreateEventPayload>, CanonicalError> {
    let payload = DeviceCreateEventPayload {
        kind: "create",
        hazard_type: serde_json::from_value(body["type"].clone())
            .expect("submit_report always writes a valid hazard type"),
        lat: body["lat"]
            .as_f64()
            .expect("submit_report always writes a numeric lat"),
        lng: body["lng"]
            .as_f64()
            .expect("submit_report always writes a numeric lng"),
        speed_kmh: body.get("speedKmh").and_then(|v| v.as_f64()),
        device_public_key: key.public_key_raw.clone(),
        timestamp: unix_ms_to_rfc3339(now_unix_ms),
    };
    sign_envelope(payload, key)
}

fn unix_ms_to_rfc3339(unix_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(unix_ms)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

fn local_write_id(body: &serde_json::Value, now_unix_ms: i64) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(body.to_string().as_bytes());
    hasher.update(now_unix_ms.to_le_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::generate_ed25519_keypair;
    use crate::discovery::DiscoveryConfig;
    use crate::platform::{HttpError, HttpResponse, HttpTransport};
    use crate::storage::InMemoryStore;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::{Arc, Mutex};

    struct FixedClock(AtomicI64);
    impl Clock for FixedClock {
        fn now_unix_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct MockTransport {
        responses: Mutex<HashMap<String, HttpResponse>>,
        seen_bodies: Mutex<Vec<Vec<u8>>>,
    }
    impl MockTransport {
        fn new() -> Self {
            Self {
                responses: Mutex::new(HashMap::new()),
                seen_bodies: Mutex::new(Vec::new()),
            }
        }
        fn set(&self, url: &str, status: u16, body: serde_json::Value) {
            self.responses.lock().unwrap().insert(
                url.to_string(),
                HttpResponse {
                    status,
                    body: serde_json::to_vec(&body).unwrap(),
                },
            );
        }
    }
    #[async_trait::async_trait]
    impl HttpTransport for MockTransport {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
            if let Some(body) = &request.body {
                self.seen_bodies.lock().unwrap().push(body.clone());
            }
            self.responses
                .lock()
                .unwrap()
                .get(&request.url)
                .cloned()
                .ok_or_else(|| HttpError::Network(format!("no mock response for {}", request.url)))
        }
    }

    fn discovery_with_one_server(transport: Arc<MockTransport>) -> DiscoveryService {
        let clock = Arc::new(FixedClock(AtomicI64::new(0)));
        let discovery = DiscoveryService::new(transport, clock, DiscoveryConfig::default());
        discovery.seed_fixed_nodes(&[("node1".to_string(), "https://a.example".to_string())]);
        discovery
    }

    fn submission() -> ReportSubmission {
        ReportSubmission {
            hazard_type: HazardType::Ice,
            lat: 52.5,
            lng: 13.4,
            speed_kmh: None,
        }
    }

    #[test]
    fn submit_report_enqueues_an_unsigned_pending_write() {
        let store = InMemoryStore::new();
        let clock = FixedClock(AtomicI64::new(1000));
        let id = submit_report(&store, &clock, &submission()).unwrap();

        let pending = store.pending_writes().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, id);
        assert!(pending[0].request_body.get("deviceAssertion").is_none());
    }

    #[tokio::test]
    async fn flush_pending_removes_on_success_and_reports_merged() {
        let transport = Arc::new(MockTransport::new());
        transport.set(
            "https://a.example/v1/hazard-reports",
            201,
            serde_json::json!({ "report": {}, "merged": false }),
        );
        let discovery = discovery_with_one_server(transport);
        let store = InMemoryStore::new();
        let clock = FixedClock(AtomicI64::new(1000));
        submit_report(&store, &clock, &submission()).unwrap();

        let outcomes = flush_pending(&store, &discovery, &clock, "token", None)
            .await
            .unwrap();
        assert!(matches!(
            outcomes.as_slice(),
            [FlushOutcome::Submitted { merged: false, .. }]
        ));
        assert!(store.pending_writes().unwrap().is_empty());
    }

    #[tokio::test]
    async fn flush_pending_signs_fresh_with_the_current_time_not_the_submit_time() {
        let transport = Arc::new(MockTransport::new());
        transport.set(
            "https://a.example/v1/hazard-reports",
            201,
            serde_json::json!({ "report": {}, "merged": false }),
        );
        let discovery = discovery_with_one_server(transport.clone());
        let store = InMemoryStore::new();
        let submit_clock = FixedClock(AtomicI64::new(1_000_000));
        submit_report(&store, &submit_clock, &submission()).unwrap();

        let key = generate_ed25519_keypair().unwrap();
        // Simulate the device having been offline well past the 60s
        // assertion-freshness window before the connection comes back.
        let flush_clock = FixedClock(AtomicI64::new(1_000_000 + 5 * 60 * 1000));
        flush_pending(&store, &discovery, &flush_clock, "token", Some(&key))
            .await
            .unwrap();

        let seen = transport.seen_bodies.lock().unwrap();
        let sent: serde_json::Value = serde_json::from_slice(&seen[0]).unwrap();
        let timestamp = sent["deviceAssertion"]["payload"]["timestamp"]
            .as_str()
            .unwrap();
        let sent_ms = chrono::DateTime::parse_from_rfc3339(timestamp)
            .unwrap()
            .timestamp_millis();
        assert_eq!(sent_ms, 1_000_000 + 5 * 60 * 1000);
    }

    #[tokio::test]
    async fn flush_pending_requeues_with_incremented_attempts_on_transport_failure() {
        let transport = Arc::new(MockTransport::new());
        // Deliberately no mock response configured — every send fails.
        let discovery = discovery_with_one_server(transport);
        let store = InMemoryStore::new();
        let clock = FixedClock(AtomicI64::new(1000));
        submit_report(&store, &clock, &submission()).unwrap();

        let outcomes = flush_pending(&store, &discovery, &clock, "token", None)
            .await
            .unwrap();
        assert!(matches!(outcomes.as_slice(), [FlushOutcome::Failed { .. }]));
        let pending = store.pending_writes().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].attempts, 1);
    }

    #[tokio::test]
    async fn flush_pending_drops_a_permanent_rejection_without_retrying() {
        let transport = Arc::new(MockTransport::new());
        transport.set(
            "https://a.example/v1/hazard-reports",
            400,
            serde_json::json!({ "error": { "code": "VALIDATION_ERROR" } }),
        );
        let discovery = discovery_with_one_server(transport);
        let store = InMemoryStore::new();
        let clock = FixedClock(AtomicI64::new(1000));
        submit_report(&store, &clock, &submission()).unwrap();

        let outcomes = flush_pending(&store, &discovery, &clock, "token", None)
            .await
            .unwrap();
        assert!(matches!(
            outcomes.as_slice(),
            [FlushOutcome::Rejected { status: 400, .. }]
        ));
        assert!(store.pending_writes().unwrap().is_empty());
    }
}
