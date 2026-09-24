//! Orchestrates snapshot/delta/static-data sync against the current server
//! pool, using a per-server cursor persisted in `storage::Store`
//! (F-C0 plan §1.4: "pro bekanntem Server ein eigener since-Cursor" — a
//! server rotation never reuses another server's cursor, and a first
//! contact with a server always starts from a fresh snapshot, never `since=0`
//! delta replay).
//!
//! Static data (speed-limit segments, static signs, fixed cameras) is
//! synced once per [`SyncEngine::sync`] call via the content-addressed
//! manifest/partition endpoints, not per server — it's the same global
//! dataset regardless of which server answers (F-C0 plan §1.4: "server-
//! unabhängig von Natur aus"), so `GET /v1/snapshot` is always called with
//! `staticData=false` here.
//!
//! Token acquisition/refresh is deliberately **not** this engine's job —
//! `sync()` takes a caller-supplied bearer token, the same boundary already
//! drawn for `platform::{Clock, HttpTransport}`. `sync::auth` provides the
//! primitives; wiring automatic refresh on top belongs to the public-API
//! facade (F-C0 plan §3's `api.rs`), once there's an actual host-app-facing
//! surface to hang a refresh policy off of.

use std::sync::Arc;

use serde::de::DeserializeOwned;

use crate::discovery::{DiscoveryError, DiscoveryService, KnownServer};
use crate::platform::{Clock, HttpRequest, HttpResponse};
use crate::storage::{Store, StoreError, StoredEntities};

use super::types::{
    ClientConfig, DeltaPage, EventLogEntry, HazardReport, PartitionContent, SnapshotResult,
    SpeedLimitSegment, StaticDataManifest, StaticSign,
};
use super::withholding;

const DELTA_LIMIT: u32 = 500;

#[derive(Debug)]
pub enum SyncError {
    Discovery(DiscoveryError),
    InvalidResponse(String),
    Store(StoreError),
    /// The server answered with a non-2xx status that isn't a transport
    /// failure — most notably `409 SNAPSHOT_REQUIRED` on a stale delta
    /// cursor, which [`SyncEngine::sync_server`] specifically catches and
    /// recovers from by falling back to a fresh snapshot.
    Rejected {
        status: u16,
        body: String,
    },
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Discovery(e) => write!(f, "discovery error: {e}"),
            SyncError::InvalidResponse(msg) => write!(f, "invalid response: {msg}"),
            SyncError::Store(e) => write!(f, "storage error: {e}"),
            SyncError::Rejected { status, body } => {
                write!(f, "server rejected the request (HTTP {status}): {body}")
            }
        }
    }
}

impl std::error::Error for SyncError {}

fn parse_ok<T: DeserializeOwned>(response: &HttpResponse) -> Result<T, SyncError> {
    if !response.is_success() {
        let body = String::from_utf8_lossy(&response.body).to_string();
        return Err(SyncError::Rejected {
            status: response.status,
            body,
        });
    }
    let value = response
        .json()
        .map_err(|e| SyncError::InvalidResponse(e.to_string()))?;
    serde_json::from_value(value).map_err(|e| SyncError::InvalidResponse(e.to_string()))
}

/// `0.0..=1.0`. Falls back to `1.0` (never sample) rather than `0.0` (always
/// sample) if the platform's RNG is unavailable — same "fail toward doing
/// less network work, not more" instinct as `discovery::service`'s own
/// `random_jitter`, which falls back to no jitter for the identical reason.
fn random_roll() -> f64 {
    let mut buf = [0u8; 8];
    if getrandom::fill(&mut buf).is_err() {
        return 1.0;
    }
    (u64::from_le_bytes(buf) as f64) / (u64::MAX as f64)
}

fn auth_header(bearer_token: &str) -> (String, String) {
    (
        "Authorization".to_string(),
        format!("Bearer {bearer_token}"),
    )
}

pub struct SyncEngine {
    discovery: Arc<DiscoveryService>,
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
}

impl SyncEngine {
    pub fn new(
        discovery: Arc<DiscoveryService>,
        store: Arc<dyn Store>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            discovery,
            store,
            clock,
        }
    }

    /// One full sync cycle against the current pool: static data first
    /// (server-independent), then each pool server's own delta/snapshot in
    /// turn. `tiles` are the H3 resolution-7 region cells the caller
    /// currently cares about (subscribed via position/map-matching,
    /// outside this module's scope).
    pub async fn sync(&self, bearer_token: &str, tiles: &[String]) -> Result<(), SyncError> {
        self.sync_static_data(bearer_token).await?;
        for server in self.discovery.current_pool() {
            self.sync_server(bearer_token, &server, tiles).await?;
        }
        self.prune_redundant_proposals()
    }

    /// A local correction proposal whose value the community has since
    /// confirmed is redundant — the synced segment now says the same, with
    /// the real count — so it is dropped. One for a value nobody confirmed
    /// stays: it is still this device's standing vote.
    fn prune_redundant_proposals(&self) -> Result<(), SyncError> {
        let proposals = self.store.local_proposals().map_err(SyncError::Store)?;
        if proposals.is_empty() {
            return Ok(());
        }
        let entities = self.store.all_entities().map_err(SyncError::Store)?;
        for proposal in proposals {
            let confirmed = entities.speed_limit_segments.iter().any(|s| {
                s.segment_key.as_deref() == Some(proposal.segment_key.as_str())
                    && s.corrected_by.as_deref() == Some("community")
                    && s.speed_limit_unit == proposal.unit.as_str()
                    && (s.speed_limit - f64::from(proposal.value)).abs() < 0.5
            });
            if confirmed {
                self.store
                    .remove_local_proposal(&proposal.segment_key)
                    .map_err(SyncError::Store)?;
            }
        }
        Ok(())
    }

    /// `GET /v1/config`, tried against any pool server (not tied to a
    /// per-server cursor) — see `sync::types::effective_camera_namespace_enabled`
    /// for how a caller should combine this with a verified network config.
    pub async fn fetch_config(&self, bearer_token: &str) -> Result<ClientConfig, SyncError> {
        let (name, value) = auth_header(bearer_token);
        let (_, response) = self
            .discovery
            .request_with_failover(|server| {
                let url = format!("{}/v1/config", server.address.trim_end_matches('/'));
                HttpRequest::get(url).with_header(name.clone(), value.clone())
            })
            .await
            .map_err(SyncError::Discovery)?;
        parse_ok(&response)
    }

    async fn sync_server(
        &self,
        bearer_token: &str,
        server: &KnownServer,
        tiles: &[String],
    ) -> Result<(), SyncError> {
        let cursor = self
            .store
            .get_cursor(&server.node_id)
            .map_err(SyncError::Store)?;
        match cursor {
            Some(since) => match self.pull_delta(bearer_token, server, since, tiles).await {
                Ok(()) => Ok(()),
                Err(SyncError::Rejected { status: 409, .. }) => {
                    self.bootstrap_from_server(bearer_token, server, tiles)
                        .await
                }
                Err(e) => Err(e),
            },
            None => {
                self.bootstrap_from_server(bearer_token, server, tiles)
                    .await
            }
        }
    }

    async fn bootstrap_from_server(
        &self,
        bearer_token: &str,
        server: &KnownServer,
        tiles: &[String],
    ) -> Result<(), SyncError> {
        let snapshot = self.fetch_snapshot(bearer_token, server, tiles).await?;
        self.store
            .upsert_hazard_reports(&snapshot.hazard_reports)
            .map_err(SyncError::Store)?;
        self.store
            .set_cursor(&server.node_id, snapshot.snapshot_sequence)
            .map_err(SyncError::Store)?;
        Ok(())
    }

    async fn fetch_snapshot(
        &self,
        bearer_token: &str,
        server: &KnownServer,
        tiles: &[String],
    ) -> Result<SnapshotResult, SyncError> {
        let mut url = format!(
            "{}/v1/snapshot?staticData=false",
            server.address.trim_end_matches('/')
        );
        if !tiles.is_empty() {
            url.push_str("&tiles=");
            url.push_str(&tiles.join(","));
        }
        let (name, value) = auth_header(bearer_token);
        let request = HttpRequest::get(url).with_header(name, value);
        let response = self
            .discovery
            .request_to_server(server, request)
            .await
            .map_err(SyncError::Discovery)?;
        parse_ok(&response)
    }

    async fn pull_delta(
        &self,
        bearer_token: &str,
        server: &KnownServer,
        since: u64,
        tiles: &[String],
    ) -> Result<(), SyncError> {
        let mut cursor = since;
        let mut first_page = None;
        loop {
            let page = self
                .fetch_delta_page(bearer_token, server, cursor, tiles)
                .await?;
            if first_page.is_none() {
                first_page = Some(page.clone());
            }
            for event in &page.events {
                self.apply_event(event)?;
            }
            let has_more = page.has_more;
            if let Some(next) = page.next_since {
                self.store
                    .set_cursor(&server.node_id, next)
                    .map_err(SyncError::Store)?;
                cursor = next;
            }
            if !has_more {
                break;
            }
        }

        // Best-effort, client-local withholding sample check (F-C0 plan
        // §1.5) — a failure here is never a sync failure, it's just a
        // missed opportunity to catch a misbehaving server this cycle.
        if let Some(page) = first_page {
            if withholding::should_sample(random_roll(), withholding::DEFAULT_SAMPLE_RATE) {
                let _ = withholding::sample_check(
                    &self.discovery,
                    server,
                    &page,
                    since,
                    tiles,
                    bearer_token,
                    self.clock.now_unix_ms(),
                )
                .await;
            }
        }
        Ok(())
    }

    async fn fetch_delta_page(
        &self,
        bearer_token: &str,
        server: &KnownServer,
        since: u64,
        tiles: &[String],
    ) -> Result<DeltaPage, SyncError> {
        let mut url = format!(
            "{}/v1/delta?since={since}&limit={DELTA_LIMIT}",
            server.address.trim_end_matches('/')
        );
        if !tiles.is_empty() {
            url.push_str("&tiles=");
            url.push_str(&tiles.join(","));
        }
        let (name, value) = auth_header(bearer_token);
        let request = HttpRequest::get(url).with_header(name, value);
        let response = self
            .discovery
            .request_to_server(server, request)
            .await
            .map_err(SyncError::Discovery)?;
        parse_ok(&response)
    }

    /// `pub(crate)`, not private: `sync::realtime` applies WebSocket-pushed
    /// events through this exact same dispatch, so a pushed event and a
    /// delta-pulled event are handled identically — no separate code path
    /// to drift.
    pub(crate) fn apply_event(&self, event: &EventLogEntry) -> Result<(), SyncError> {
        match event.entity_type.as_str() {
            "hazardReport" => self.apply_hazard_report_event(event),
            "speedLimitSegment" | "staticSign" | "fixedSpeedCamera" => {
                self.apply_static_entity_event(event)
            }
            // Forward-compatible: an entity type this build doesn't know
            // about yet is skipped, not fatal — matches how the server
            // itself treats unrecognized `types` filters as "drop, don't
            // reject" (server/docs/api.md).
            _ => Ok(()),
        }
    }

    fn apply_hazard_report_event(&self, event: &EventLogEntry) -> Result<(), SyncError> {
        if event.event_type == "ReportExpired" {
            self.store
                .remove_hazard_report(&event.entity_id)
                .map_err(SyncError::Store)?;
            return Ok(());
        }
        let report: HazardReport = serde_json::from_value(event.payload.clone())
            .map_err(|e| SyncError::InvalidResponse(e.to_string()))?;
        if report.status == "active" {
            self.store
                .upsert_hazard_reports(&[report])
                .map_err(SyncError::Store)?;
        } else {
            self.store
                .remove_hazard_report(&report.id)
                .map_err(SyncError::Store)?;
        }
        Ok(())
    }

    fn apply_static_entity_event(&self, event: &EventLogEntry) -> Result<(), SyncError> {
        if event.event_type == "StaticDataRemoved" {
            self.store
                .remove_static_entity(&event.entity_type, &event.entity_id)
                .map_err(SyncError::Store)?;
            return Ok(());
        }
        let mut data = StoredEntities::default();
        match event.entity_type.as_str() {
            "speedLimitSegment" => {
                data.speed_limit_segments.push(
                    serde_json::from_value::<SpeedLimitSegment>(event.payload.clone())
                        .map_err(|e| SyncError::InvalidResponse(e.to_string()))?,
                );
            }
            "staticSign" => {
                data.static_signs.push(
                    serde_json::from_value::<StaticSign>(event.payload.clone())
                        .map_err(|e| SyncError::InvalidResponse(e.to_string()))?,
                );
            }
            "fixedSpeedCamera" => {
                let camera =
                    serde_json::from_value::<super::types::FixedSpeedCamera>(event.payload.clone())
                        .map_err(|e| SyncError::InvalidResponse(e.to_string()))?;
                if camera.status == "removed" {
                    return self
                        .store
                        .remove_static_entity("fixedSpeedCamera", &camera.id)
                        .map_err(SyncError::Store);
                }
                data.fixed_speed_cameras.push(camera);
            }
            _ => return Ok(()),
        }
        self.store
            .upsert_static_data(&data)
            .map_err(SyncError::Store)
    }

    async fn sync_static_data(&self, bearer_token: &str) -> Result<(), SyncError> {
        let manifest = self.fetch_manifest(bearer_token).await?;
        for partition in &manifest.partitions {
            let current_hash = self
                .store
                .get_partition_hash(&partition.tile)
                .map_err(SyncError::Store)?;
            if current_hash.as_deref() == Some(partition.hash.as_str()) {
                continue;
            }
            let content = self.fetch_partition(bearer_token, &partition.tile).await?;
            let data = StoredEntities {
                speed_limit_segments: content.speed_limit_segments,
                static_signs: content.static_signs,
                fixed_speed_cameras: content.fixed_speed_cameras,
                hazard_reports: Vec::new(),
            };
            self.store
                .upsert_static_data(&data)
                .map_err(SyncError::Store)?;
            self.store
                .set_partition_hash(&partition.tile, &partition.hash)
                .map_err(SyncError::Store)?;
        }
        Ok(())
    }

    async fn fetch_manifest(&self, bearer_token: &str) -> Result<StaticDataManifest, SyncError> {
        let (name, value) = auth_header(bearer_token);
        let (_, response) = self
            .discovery
            .request_with_failover(|server| {
                let url = format!(
                    "{}/v1/static-data/manifest",
                    server.address.trim_end_matches('/')
                );
                HttpRequest::get(url).with_header(name.clone(), value.clone())
            })
            .await
            .map_err(SyncError::Discovery)?;
        parse_ok(&response)
    }

    async fn fetch_partition(
        &self,
        bearer_token: &str,
        tile: &str,
    ) -> Result<PartitionContent, SyncError> {
        let (name, value) = auth_header(bearer_token);
        let (_, response) = self
            .discovery
            .request_with_failover(|server| {
                let url = format!(
                    "{}/v1/static-data/partitions/{}",
                    server.address.trim_end_matches('/'),
                    tile
                );
                HttpRequest::get(url).with_header(name.clone(), value.clone())
            })
            .await
            .map_err(SyncError::Discovery)?;
        parse_ok(&response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::DiscoveryConfig;
    use crate::platform::{Clock, HttpError, HttpTransport};
    use crate::storage::{InMemoryStore, LocalCorrectionProposal, ProposalState};
    use crate::sync::matching::{speed_limit_at, SpeedLimitOrigin};
    use crate::sync::types::SpeedLimitUnit;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Mutex;

    struct FixedClock(AtomicI64);
    impl Clock for FixedClock {
        fn now_unix_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct MockTransport {
        responses: Mutex<HashMap<String, HttpResponse>>,
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
            self.responses
                .lock()
                .unwrap()
                .get(&request.url)
                .cloned()
                .ok_or_else(|| HttpError::Network(format!("no mock response for {}", request.url)))
        }
    }

    fn engine_with_one_server(transport: Arc<MockTransport>) -> (SyncEngine, Arc<InMemoryStore>) {
        let clock = Arc::new(FixedClock(AtomicI64::new(0)));
        let discovery = Arc::new(DiscoveryService::new(
            transport,
            clock.clone(),
            DiscoveryConfig::default(),
        ));
        discovery.seed_fixed_nodes(&[("node1".to_string(), "https://a.example".to_string())]);
        let store = Arc::new(InMemoryStore::new());
        (SyncEngine::new(discovery, store.clone(), clock), store)
    }

    fn empty_manifest() -> serde_json::Value {
        serde_json::json!({
            "staticDataVersion": 1,
            "generatedAt": "2026-01-01T00:00:00Z",
            "partitions": []
        })
    }

    #[tokio::test]
    async fn first_sync_bootstraps_from_a_snapshot_and_sets_the_cursor() {
        let transport = Arc::new(MockTransport::new());
        transport.set(
            "https://a.example/v1/static-data/manifest",
            200,
            empty_manifest(),
        );
        transport.set(
            "https://a.example/v1/snapshot?staticData=false",
            200,
            serde_json::json!({
                "snapshotSequence": 10,
                "speedLimitSegments": [],
                "staticSigns": [],
                "hazardReports": [],
                "fixedSpeedCameras": []
            }),
        );
        let (engine, store) = engine_with_one_server(transport);

        engine.sync("token", &[]).await.unwrap();
        assert_eq!(store.get_cursor("node1").unwrap(), Some(10));
    }

    #[tokio::test]
    async fn delta_pull_applies_report_created_and_report_expired_events() {
        let transport = Arc::new(MockTransport::new());
        transport.set(
            "https://a.example/v1/static-data/manifest",
            200,
            empty_manifest(),
        );
        transport.set(
            "https://a.example/v1/delta?since=5&limit=500",
            200,
            serde_json::json!({
                "events": [
                    {
                        "sequence": 6,
                        "occurredAt": "2026-01-01T00:00:00Z",
                        "type": "ReportCreated",
                        "entityType": "hazardReport",
                        "entityId": "hr1",
                        "payload": {
                            "id": "hr1",
                            "type": "ice",
                            "position": { "type": "Point", "coordinates": [13.4, 52.5] },
                            "regionTile": "tile1",
                            "reportedAt": "2026-01-01T00:00:00Z",
                            "reporterId": "r1",
                            "speedKmh": null,
                            "expiresAt": "2026-01-01T00:20:00Z",
                            "status": "active",
                            "source": "community",
                            "sourceLicense": null,
                            "confirmCount": 0,
                            "denyCount": 0
                        },
                        "regionTile": "tile1",
                        "source": "community"
                    },
                    {
                        "sequence": 7,
                        "occurredAt": "2026-01-01T00:20:00Z",
                        "type": "ReportExpired",
                        "entityType": "hazardReport",
                        "entityId": "hr1",
                        "payload": {},
                        "regionTile": "tile1",
                        "source": "community"
                    }
                ],
                "nextSince": 8,
                "hasMore": false
            }),
        );
        let (engine, store) = engine_with_one_server(transport);
        store.set_cursor("node1", 5).unwrap();

        engine.sync("token", &[]).await.unwrap();
        assert_eq!(store.get_cursor("node1").unwrap(), Some(8));
        let entities = store.all_entities().unwrap();
        assert!(entities.hazard_reports.is_empty());
    }

    #[tokio::test]
    async fn a_409_on_delta_falls_back_to_a_fresh_snapshot() {
        let transport = Arc::new(MockTransport::new());
        transport.set(
            "https://a.example/v1/static-data/manifest",
            200,
            empty_manifest(),
        );
        transport.set(
            "https://a.example/v1/delta?since=1&limit=500",
            409,
            serde_json::json!({"error": {"code": "SNAPSHOT_REQUIRED"}}),
        );
        transport.set(
            "https://a.example/v1/snapshot?staticData=false",
            200,
            serde_json::json!({
                "snapshotSequence": 99,
                "speedLimitSegments": [],
                "staticSigns": [],
                "hazardReports": [],
                "fixedSpeedCameras": []
            }),
        );
        let (engine, store) = engine_with_one_server(transport);
        store.set_cursor("node1", 1).unwrap();

        engine.sync("token", &[]).await.unwrap();
        assert_eq!(store.get_cursor("node1").unwrap(), Some(99));
    }

    #[tokio::test]
    async fn static_data_sync_skips_a_partition_whose_hash_is_unchanged() {
        let transport = Arc::new(MockTransport::new());
        transport.set(
            "https://a.example/v1/static-data/manifest",
            200,
            serde_json::json!({
                "staticDataVersion": 2,
                "generatedAt": "2026-01-01T00:00:00Z",
                "partitions": [ { "tile": "tileA", "hash": "hash-1", "sizeBytes": 10 } ]
            }),
        );
        transport.set(
            "https://a.example/v1/snapshot?staticData=false",
            200,
            serde_json::json!({
                "snapshotSequence": 1,
                "speedLimitSegments": [],
                "staticSigns": [],
                "hazardReports": [],
                "fixedSpeedCameras": []
            }),
        );
        // Deliberately no mock for /v1/static-data/partitions/tileA — if the
        // engine tried to fetch it despite the unchanged hash, the request
        // would error and this test would fail.
        let (engine, store) = engine_with_one_server(transport);
        store.set_partition_hash("tileA", "hash-1").unwrap();

        engine.sync("token", &[]).await.unwrap();
    }

    const KEY: &str = "0123456789abcdef0123456789abcdef";

    fn segment_event(sequence: u64, speed_limit: u32, corrected: bool) -> serde_json::Value {
        let mut payload = serde_json::json!({
            "id": "seg1",
            "geometry": {
                "type": "LineString",
                "coordinates": [[13.0, 52.0], [13.01, 52.0]]
            },
            "speedLimit": speed_limit,
            "speedLimitUnit": "kmh",
            "source": "osm",
            "sourceLicense": null,
            "importedAt": "2026-01-01T00:00:00Z",
            "lastConfirmedAt": null,
            "segmentKey": KEY
        });
        if corrected {
            payload["correctedBy"] = serde_json::json!("community");
            payload["importedSpeedLimit"] = serde_json::json!(50);
            payload["correction"] = serde_json::json!({
                "id": "c1",
                "confirmations": 3,
                "denials": 0,
                "appliedAt": "2026-09-24T12:00:00.000Z",
                "needsReview": false
            });
        }
        serde_json::json!({
            "sequence": sequence,
            "occurredAt": "2026-09-24T12:00:00Z",
            "type": "StaticDataUpdated",
            "entityType": "speedLimitSegment",
            "entityId": "seg1",
            "payload": payload,
            "regionTile": null,
            "source": "community"
        })
    }

    fn set_delta(transport: &MockTransport, events: Vec<serde_json::Value>, next_since: u64) {
        transport.set(
            "https://a.example/v1/static-data/manifest",
            200,
            empty_manifest(),
        );
        transport.set(
            "https://a.example/v1/delta?since=5&limit=500",
            200,
            serde_json::json!({ "events": events, "nextSince": next_since, "hasMore": false }),
        );
    }

    #[tokio::test]
    async fn a_community_correction_arrives_through_delta_with_its_origin() {
        let transport = Arc::new(MockTransport::new());
        set_delta(&transport, vec![segment_event(6, 30, true)], 6);
        let (engine, store) = engine_with_one_server(transport);
        store.set_cursor("node1", 5).unwrap();

        engine.sync("token", &[]).await.unwrap();

        let result = speed_limit_at(&*store, 52.0, 13.005, 100.0).unwrap().unwrap();
        assert_eq!(result.speed_limit, 30.0);
        assert!(matches!(
            result.origin,
            SpeedLimitOrigin::CommunityCorrected {
                confirmations: 3,
                ..
            }
        ));
        assert_eq!(result.imported_speed_limit, Some(50.0));
    }

    #[tokio::test]
    async fn a_reverted_correction_falls_back_to_the_imported_value() {
        let transport = Arc::new(MockTransport::new());
        set_delta(
            &transport,
            vec![segment_event(6, 30, true), segment_event(7, 50, false)],
            7,
        );
        let (engine, store) = engine_with_one_server(transport);
        store.set_cursor("node1", 5).unwrap();

        engine.sync("token", &[]).await.unwrap();

        let result = speed_limit_at(&*store, 52.0, 13.005, 100.0).unwrap().unwrap();
        assert_eq!(result.speed_limit, 50.0);
        assert_eq!(result.origin, SpeedLimitOrigin::Imported);
    }

    fn sent_proposal(value: u32) -> LocalCorrectionProposal {
        LocalCorrectionProposal {
            segment_key: KEY.to_string(),
            segment_id: "seg1".to_string(),
            value,
            unit: SpeedLimitUnit::Kmh,
            reason: None,
            state: ProposalState::Sent,
            correction_id: Some("c1".to_string()),
            confirmations: 1,
            proposed_at_unix_ms: 0,
        }
    }

    #[tokio::test]
    async fn a_proposal_the_community_confirmed_is_dropped_after_sync() {
        let transport = Arc::new(MockTransport::new());
        set_delta(&transport, vec![segment_event(6, 30, true)], 6);
        let (engine, store) = engine_with_one_server(transport);
        store.set_cursor("node1", 5).unwrap();
        store.upsert_local_proposal(&sent_proposal(30)).unwrap();

        engine.sync("token", &[]).await.unwrap();

        assert!(store.local_proposals().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_proposal_for_a_different_value_stays_after_sync() {
        let transport = Arc::new(MockTransport::new());
        set_delta(&transport, vec![segment_event(6, 30, true)], 6);
        let (engine, store) = engine_with_one_server(transport);
        store.set_cursor("node1", 5).unwrap();
        store.upsert_local_proposal(&sent_proposal(70)).unwrap();

        engine.sync("token", &[]).await.unwrap();

        assert_eq!(store.local_proposals().unwrap().len(), 1);
    }
}
