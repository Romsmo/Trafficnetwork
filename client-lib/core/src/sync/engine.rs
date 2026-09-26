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
use sha2::{Digest, Sha256};

use crate::discovery::{DiscoveryError, DiscoveryService, KnownServer};
use crate::platform::{Clock, HttpRequest, HttpResponse};
use crate::storage::{is_storage_full, Store, StoreError, StoredEntities};

use super::types::{
    ClientConfig, DeltaPage, EventLogEntry, HazardReport, PartitionContent, PartitionSummary,
    SnapshotResult, SpeedLimitSegment, StaticDataManifest, StaticSign,
};
use super::withholding;

const DELTA_LIMIT: u32 = 500;

#[derive(Debug)]
pub enum SyncError {
    Discovery(DiscoveryError),
    InvalidResponse(String),
    Store(StoreError),
    /// The local store ran out of space. Nothing is lost: what was stored so
    /// far stays, and the next sync resumes from there — free some space (or
    /// ask [`SyncEngine::plan_static_bootstrap`] how much a bootstrap still
    /// needs, before starting) and call again.
    StorageFull,
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
            SyncError::StorageFull => write!(f, "the local store is out of space"),
            SyncError::Rejected { status, body } => {
                write!(f, "server rejected the request (HTTP {status}): {body}")
            }
        }
    }
}

impl std::error::Error for SyncError {}

impl SyncError {
    /// A store that has run out of room says so with a `StorageFullError`;
    /// that one storage failure is something a host app can act on, so it
    /// gets its own variant.
    fn from_store(error: StoreError) -> Self {
        if is_storage_full(&error) {
            SyncError::StorageFull
        } else {
            SyncError::Store(error)
        }
    }
}

fn parse_ok<T: DeserializeOwned>(response: &HttpResponse) -> Result<T, SyncError> {
    if !response.is_success() {
        let body = String::from_utf8_lossy(&response.body).to_string();
        return Err(SyncError::Rejected {
            status: response.status,
            body,
        });
    }
    // Straight from the bytes into the typed value: going through a
    // `serde_json::Value` first would keep a second, several times larger
    // copy of a partition (tens of MB of JSON) in memory at the same time.
    serde_json::from_slice(&response.body).map_err(|e| SyncError::InvalidResponse(e.to_string()))
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

/// Progress of the static-data part of a sync, relative to *this* run: after
/// an interruption the next run's totals cover only what was still missing.
/// Byte counts are the server's `sizeBytes` (the JSON size, which is what
/// crosses the wire).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapProgress {
    pub partitions_total: usize,
    pub partitions_done: usize,
    pub bytes_total: u64,
    pub bytes_done: u64,
}

/// What a static-data bootstrap still has to download — see
/// [`SyncEngine::plan_static_bootstrap`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapPlan {
    pub partitions_total: usize,
    pub partitions_pending: usize,
    pub bytes_total: u64,
    pub bytes_pending: u64,
}

/// Receives progress while [`SyncEngine::sync_static_data`] runs — once at
/// the start and after every partition. Called on the syncing task itself,
/// so keep it quick.
pub trait SyncObserver: Send + Sync {
    fn on_bootstrap_progress(&self, progress: &BootstrapProgress);

    /// A delta-pulled or pushed event changed the local data (a report
    /// appeared or expired, a static entity changed or was removed).
    /// Not called for a snapshot or a static package — those end in a sync
    /// that reports its own completion. The default ignores it.
    fn on_data_changed(&self, _event: &EventLogEntry) {}
}

pub struct SyncEngine {
    discovery: Arc<DiscoveryService>,
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    observer: Option<Arc<dyn SyncObserver>>,
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
            observer: None,
        }
    }

    pub fn with_observer(mut self, observer: Arc<dyn SyncObserver>) -> Self {
        self.observer = Some(observer);
        self
    }

    /// One full sync cycle against the current pool: static data first
    /// (server-independent), then each pool server's own delta/snapshot in
    /// turn. `tiles` are the H3 resolution-7 region cells the caller
    /// currently cares about (subscribed via position/map-matching,
    /// outside this module's scope).
    ///
    /// The two parts do not hold each other up: a static bootstrap that is
    /// interrupted, out of space or still in progress does not keep the
    /// current hazard reports from arriving. Both are attempted; the error
    /// of the static part, if any, is the one returned.
    pub async fn sync(&self, bearer_token: &str, tiles: &[String]) -> Result<(), SyncError> {
        let static_result = self.sync_static_data(bearer_token).await;
        let dynamic_result = self.sync_dynamic(bearer_token, tiles).await;
        static_result.and(dynamic_result)
    }

    /// The dynamic part of a sync: every server of the pool's own delta (or
    /// snapshot), then the local clean-up that depends on it. One server
    /// failing does not stop the others; the call fails only when none could
    /// be synced — or when the store is full, which nothing else makes up for.
    pub async fn sync_dynamic(
        &self,
        bearer_token: &str,
        tiles: &[String],
    ) -> Result<(), SyncError> {
        let pool = self.discovery.current_pool();
        if pool.is_empty() {
            return Err(SyncError::Discovery(DiscoveryError::NoServersAvailable));
        }
        let mut synced_any = false;
        let mut first_error = None;
        for server in pool {
            match self.sync_server(bearer_token, &server, tiles).await {
                Ok(()) => synced_any = true,
                Err(SyncError::StorageFull) => return Err(SyncError::StorageFull),
                Err(e) => {
                    first_error.get_or_insert(e);
                }
            }
        }
        self.prune_redundant_proposals()?;
        match first_error {
            Some(e) if !synced_any => Err(e),
            _ => Ok(()),
        }
    }

    /// A local correction proposal whose value the community has since
    /// confirmed is redundant — the synced segment now says the same, with
    /// the real count — so it is dropped. One for a value nobody confirmed
    /// stays: it is still this device's standing vote.
    fn prune_redundant_proposals(&self) -> Result<(), SyncError> {
        let proposals = self
            .store
            .local_proposals()
            .map_err(SyncError::from_store)?;
        if proposals.is_empty() {
            return Ok(());
        }
        for proposal in proposals {
            // Looked up by id (indexed), not by scanning every segment: with a
            // large dataset this runs at the end of every sync.
            let segment = self
                .store
                .speed_limit_segment(&proposal.segment_id)
                .map_err(SyncError::from_store)?;
            let confirmed = segment.is_some_and(|s| {
                s.segment_key.as_deref() == Some(proposal.segment_key.as_str())
                    && s.corrected_by.as_deref() == Some("community")
                    && s.speed_limit_unit == proposal.unit.as_str()
                    && (s.speed_limit - f64::from(proposal.value)).abs() < 0.5
            });
            if confirmed {
                self.store
                    .remove_local_proposal(&proposal.segment_key)
                    .map_err(SyncError::from_store)?;
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
            .map_err(SyncError::from_store)?;
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
            .map_err(SyncError::from_store)?;
        self.store
            .set_cursor(&server.node_id, snapshot.snapshot_sequence)
            .map_err(SyncError::from_store)?;
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
                    .map_err(SyncError::from_store)?;
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
        let result = match event.entity_type.as_str() {
            "hazardReport" => self.apply_hazard_report_event(event),
            "speedLimitSegment" | "staticSign" | "fixedSpeedCamera" => {
                self.apply_static_entity_event(event)
            }
            // Forward-compatible: an entity type this build doesn't know
            // about yet is skipped, not fatal — matches how the server
            // itself treats unrecognized `types` filters as "drop, don't
            // reject" (server/docs/api.md).
            _ => return Ok(()),
        };
        if result.is_ok() {
            if let Some(observer) = &self.observer {
                observer.on_data_changed(event);
            }
        }
        result
    }

    fn apply_hazard_report_event(&self, event: &EventLogEntry) -> Result<(), SyncError> {
        if event.event_type == "ReportExpired" {
            self.store
                .remove_hazard_report(&event.entity_id)
                .map_err(SyncError::from_store)?;
            return Ok(());
        }
        let report: HazardReport = serde_json::from_value(event.payload.clone())
            .map_err(|e| SyncError::InvalidResponse(e.to_string()))?;
        if report.status == "active" {
            self.store
                .upsert_hazard_reports(&[report])
                .map_err(SyncError::from_store)?;
        } else {
            self.store
                .remove_hazard_report(&report.id)
                .map_err(SyncError::from_store)?;
        }
        Ok(())
    }

    fn apply_static_entity_event(&self, event: &EventLogEntry) -> Result<(), SyncError> {
        if event.event_type == "StaticDataRemoved" {
            self.store
                .remove_static_entity(&event.entity_type, &event.entity_id)
                .map_err(SyncError::from_store)?;
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
                        .map_err(SyncError::from_store);
                }
                data.fixed_speed_cameras.push(camera);
            }
            _ => return Ok(()),
        }
        self.store
            .upsert_static_data(&data)
            .map_err(SyncError::from_store)
    }

    /// What a static-data bootstrap still has to download, from the server's
    /// manifest and what is already stored — so a host app can compare
    /// `bytes_pending` with the free space *before* starting, and show
    /// "3 of 120 regions". Costs one manifest request.
    pub async fn plan_static_bootstrap(
        &self,
        bearer_token: &str,
    ) -> Result<BootstrapPlan, SyncError> {
        let (_, manifest) = self.fetch_manifest(bearer_token).await?;
        let pending = self.pending_partitions(&manifest)?;
        Ok(BootstrapPlan {
            partitions_total: manifest.partitions.len(),
            partitions_pending: pending.len(),
            bytes_total: manifest.partitions.iter().map(|p| p.size_bytes).sum(),
            bytes_pending: pending.iter().map(|p| p.size_bytes).sum(),
        })
    }

    /// True when the server cuts its packages at another H3 resolution than
    /// the stored ones were: tile ids of different resolutions never match,
    /// so what is stored cannot be brought up to date, only replaced.
    fn resolution_changed(&self, manifest: &StaticDataManifest) -> Result<bool, SyncError> {
        let Some(resolution) = manifest.partition_resolution else {
            return Ok(false);
        };
        let stored = self
            .store
            .static_partition_resolution()
            .map_err(SyncError::from_store)?;
        Ok(stored.is_some_and(|stored| stored != resolution))
    }

    /// On a resolution change, forgets the old packages (and only then
    /// records the new resolution — a run killed in between just repeats
    /// this). The first time a resolution is seen it is only recorded.
    fn reconcile_partition_resolution(
        &self,
        manifest: &StaticDataManifest,
    ) -> Result<(), SyncError> {
        let Some(resolution) = manifest.partition_resolution else {
            return Ok(());
        };
        if self.resolution_changed(manifest)? {
            self.store
                .clear_static_data()
                .map_err(SyncError::from_store)?;
        }
        self.store
            .set_static_partition_resolution(resolution)
            .map_err(SyncError::from_store)
    }

    fn pending_partitions<'a>(
        &self,
        manifest: &'a StaticDataManifest,
    ) -> Result<Vec<&'a PartitionSummary>, SyncError> {
        // After a resolution change everything stored is about to go.
        let everything_stale = self.resolution_changed(manifest)?;
        let mut pending = Vec::new();
        for partition in &manifest.partitions {
            let current = if everything_stale {
                None
            } else {
                self.store
                    .get_partition_hash(&partition.tile)
                    .map_err(SyncError::from_store)?
            };
            if current.as_deref() != Some(partition.hash.as_str()) {
                pending.push(partition);
            }
        }
        Ok(pending)
    }

    /// Brings the static data (speed-limit segments, signs, cameras) up to
    /// date, one partition at a time. Each partition is stored together with
    /// its hash, so a bootstrap that is interrupted — killed, offline, out of
    /// space — picks up at the next partition the next time this is called
    /// instead of starting over. Progress goes to the observer, if any.
    ///
    /// Every package is fetched from the server that answered with the
    /// manifest (not from whichever server answers next: another server's
    /// package may differ), and its SHA-256 must equal the manifest's hash
    /// before anything is stored — a package that does not match is rejected
    /// and counts against the server that sent it. If the manifest names
    /// another partition resolution than the one the stored packages have,
    /// the stored packages are dropped and downloaded again.
    pub async fn sync_static_data(&self, bearer_token: &str) -> Result<(), SyncError> {
        let (server, manifest) = self.fetch_manifest(bearer_token).await?;
        self.reconcile_partition_resolution(&manifest)?;
        let pending = self.pending_partitions(&manifest)?;
        let mut progress = BootstrapProgress {
            partitions_total: pending.len(),
            partitions_done: 0,
            bytes_total: pending.iter().map(|p| p.size_bytes).sum(),
            bytes_done: 0,
        };
        self.report(&progress);
        for partition in pending {
            let content = self
                .fetch_partition(bearer_token, &server, partition)
                .await?;
            let data = StoredEntities {
                speed_limit_segments: content.speed_limit_segments,
                static_signs: content.static_signs,
                fixed_speed_cameras: content.fixed_speed_cameras,
                hazard_reports: Vec::new(),
            };
            self.store
                .upsert_static_partition(&partition.tile, &partition.hash, &data)
                .map_err(SyncError::from_store)?;
            progress.partitions_done += 1;
            progress.bytes_done += partition.size_bytes;
            self.report(&progress);
        }
        Ok(())
    }

    fn report(&self, progress: &BootstrapProgress) {
        if let Some(observer) = &self.observer {
            observer.on_bootstrap_progress(progress);
        }
    }

    async fn fetch_manifest(
        &self,
        bearer_token: &str,
    ) -> Result<(KnownServer, StaticDataManifest), SyncError> {
        let (name, value) = auth_header(bearer_token);
        let (server, response) = self
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
        Ok((server, parse_ok(&response)?))
    }

    /// One package from `server`, checked against the manifest's hash. The
    /// content-addressed `path` is preferred where the manifest has one: it
    /// can only answer with the content the hash names, whereas the
    /// per-tile URL answers with whatever the server holds by now.
    async fn fetch_partition(
        &self,
        bearer_token: &str,
        server: &KnownServer,
        partition: &PartitionSummary,
    ) -> Result<PartitionContent, SyncError> {
        let (name, value) = auth_header(bearer_token);
        let base = server.address.trim_end_matches('/');
        let url = match &partition.path {
            Some(path) => format!("{base}{path}"),
            None => format!("{base}/v1/static-data/partitions/{}", partition.tile),
        };
        let response = self
            .discovery
            .request_to_server(server, HttpRequest::get(url).with_header(name, value))
            .await
            .map_err(SyncError::Discovery)?;
        if response.is_success() && !hash_matches(&response.body, &partition.hash) {
            self.discovery.record_invalid_data(&server.node_id);
            return Err(SyncError::InvalidResponse(format!(
                "the package for tile {} does not match the hash in the manifest",
                partition.tile
            )));
        }
        parse_ok(&response)
    }
}

/// Whether `body` hashes (SHA-256, hex) to `expected_hex`.
fn hash_matches(body: &[u8], expected_hex: &str) -> bool {
    hex::encode(Sha256::digest(body)).eq_ignore_ascii_case(expected_hex)
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
        requested: Mutex<Vec<String>>,
    }
    impl MockTransport {
        fn new() -> Self {
            Self {
                responses: Mutex::new(HashMap::new()),
                requested: Mutex::new(Vec::new()),
            }
        }
        fn request_count(&self, url: &str) -> usize {
            self.requested
                .lock()
                .unwrap()
                .iter()
                .filter(|u| u.as_str() == url)
                .count()
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
            self.requested.lock().unwrap().push(request.url.clone());
            self.responses
                .lock()
                .unwrap()
                .get(&request.url)
                .cloned()
                .ok_or_else(|| HttpError::Network(format!("no mock response for {}", request.url)))
        }
    }

    fn engine_with_one_server(transport: Arc<MockTransport>) -> (SyncEngine, Arc<InMemoryStore>) {
        let store = Arc::new(InMemoryStore::new());
        (engine_with_store(transport, store.clone()), store)
    }

    fn engine_with_store(transport: Arc<MockTransport>, store: Arc<dyn Store>) -> SyncEngine {
        let clock = Arc::new(FixedClock(AtomicI64::new(0)));
        let discovery = Arc::new(DiscoveryService::new(
            transport,
            clock.clone(),
            DiscoveryConfig::default(),
        ));
        discovery.seed_fixed_nodes(&[("node1".to_string(), "https://a.example".to_string())]);
        SyncEngine::new(discovery, store, clock)
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

        let result = speed_limit_at(&*store, 52.0, 13.005, 100.0)
            .unwrap()
            .unwrap();
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

        let result = speed_limit_at(&*store, 52.0, 13.005, 100.0)
            .unwrap()
            .unwrap();
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

    const MANIFEST_URL: &str = "https://a.example/v1/static-data/manifest";

    fn partition_url(tile: &str) -> String {
        format!("https://a.example/v1/static-data/partitions/{tile}")
    }

    fn plain_segment_json(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "geometry": { "type": "LineString", "coordinates": [[13.0, 52.0], [13.01, 52.0]] },
            "speedLimit": 50,
            "speedLimitUnit": "kmh",
            "source": "osm",
            "sourceLicense": null,
            "importedAt": "2026-01-01T00:00:00Z",
            "lastConfirmedAt": null
        })
    }

    /// What the mock server serves for one of the three test tiles: A and B
    /// hold two segments, C one.
    fn tile_content(tile: &str) -> serde_json::Value {
        let ids: Vec<&str> = match tile {
            "tileA" => vec!["a1", "a2"],
            "tileB" => vec!["b1", "b2"],
            _ => vec!["c1"],
        };
        let segments: Vec<serde_json::Value> = ids.into_iter().map(plain_segment_json).collect();
        serde_json::json!({
            "tile": tile,
            "speedLimitSegments": segments,
            "staticSigns": [],
            "fixedSpeedCameras": []
        })
    }

    /// The hash a server's manifest names for `content`: SHA-256 of the bytes
    /// that are served.
    fn hash_of(content: &serde_json::Value) -> String {
        hex::encode(Sha256::digest(serde_json::to_vec(content).unwrap()))
    }

    fn tile_hash(tile: &str) -> String {
        hash_of(&tile_content(tile))
    }

    /// Three partitions of 100 bytes each; only the `available` ones can be
    /// downloaded.
    fn set_three_partitions(transport: &MockTransport, available: &[&str]) {
        set_three_partitions_at(transport, available, None);
    }

    fn set_three_partitions_at(
        transport: &MockTransport,
        available: &[&str],
        resolution: Option<u8>,
    ) {
        let partitions: Vec<serde_json::Value> = ["tileA", "tileB", "tileC"]
            .iter()
            .map(|tile| {
                serde_json::json!({ "tile": tile, "hash": tile_hash(tile), "sizeBytes": 100 })
            })
            .collect();
        let mut manifest = serde_json::json!({
            "staticDataVersion": 1,
            "generatedAt": "2026-01-01T00:00:00Z",
            "partitions": partitions
        });
        if let Some(resolution) = resolution {
            manifest["partitionResolution"] = serde_json::json!(resolution);
        }
        transport.set(MANIFEST_URL, 200, manifest);
        for tile in ["tileA", "tileB", "tileC"] {
            if available.contains(&tile) {
                transport.set(&partition_url(tile), 200, tile_content(tile));
            }
        }
    }

    #[tokio::test]
    async fn a_bootstrap_that_runs_out_of_space_resumes_at_the_next_partition() {
        let transport = Arc::new(MockTransport::new());
        set_three_partitions(&transport, &["tileA", "tileB", "tileC"]);
        // Room for the first partition (2 entities) but not the second.
        let store = Arc::new(InMemoryStore::with_static_entity_limit(3));
        let engine = engine_with_store(transport.clone(), store.clone());

        let first = engine.sync_static_data("token").await;

        assert!(matches!(first, Err(SyncError::StorageFull)));
        assert_eq!(
            store.get_partition_hash("tileA").unwrap(),
            Some(tile_hash("tileA"))
        );
        assert_eq!(store.get_partition_hash("tileB").unwrap(), None);

        // The user frees space; the same call carries on.
        store.set_static_entity_limit(None);
        engine.sync_static_data("token").await.unwrap();

        assert_eq!(transport.request_count(&partition_url("tileA")), 1);
        assert_eq!(transport.request_count(&partition_url("tileB")), 2);
        assert_eq!(transport.request_count(&partition_url("tileC")), 1);
        assert_eq!(store.all_entities().unwrap().speed_limit_segments.len(), 5);
    }

    struct Recorder(Mutex<Vec<BootstrapProgress>>);
    impl SyncObserver for Recorder {
        fn on_bootstrap_progress(&self, progress: &BootstrapProgress) {
            self.0.lock().unwrap().push(progress.clone());
        }
    }

    #[tokio::test]
    async fn progress_is_reported_at_the_start_and_after_every_partition() {
        let transport = Arc::new(MockTransport::new());
        set_three_partitions(&transport, &["tileA", "tileB", "tileC"]);
        let recorder = Arc::new(Recorder(Mutex::new(Vec::new())));
        let (engine, _store) = engine_with_one_server(transport);
        let engine = engine.with_observer(recorder.clone());

        engine.sync_static_data("token").await.unwrap();

        let seen = recorder.0.lock().unwrap();
        let steps: Vec<(usize, u64)> = seen
            .iter()
            .map(|p| (p.partitions_done, p.bytes_done))
            .collect();
        assert_eq!(steps, vec![(0, 0), (1, 100), (2, 200), (3, 300)]);
        assert!(seen
            .iter()
            .all(|p| p.partitions_total == 3 && p.bytes_total == 300));
    }

    #[tokio::test]
    async fn the_plan_shrinks_as_partitions_complete() {
        let transport = Arc::new(MockTransport::new());
        set_three_partitions(&transport, &["tileA", "tileB", "tileC"]);
        let store = Arc::new(InMemoryStore::with_static_entity_limit(3));
        let engine = engine_with_store(transport, store);

        let before = engine.plan_static_bootstrap("token").await.unwrap();
        let _ = engine.sync_static_data("token").await;
        let after = engine.plan_static_bootstrap("token").await.unwrap();

        assert_eq!(
            before,
            BootstrapPlan {
                partitions_total: 3,
                partitions_pending: 3,
                bytes_total: 300,
                bytes_pending: 300
            }
        );
        assert_eq!(
            after,
            BootstrapPlan {
                partitions_total: 3,
                partitions_pending: 2,
                bytes_total: 300,
                bytes_pending: 200
            }
        );
    }

    #[tokio::test]
    async fn a_package_that_does_not_match_its_hash_is_rejected_and_not_stored() {
        let transport = Arc::new(MockTransport::new());
        set_three_partitions(&transport, &["tileA", "tileB", "tileC"]);
        // Tile B is served with different content than the manifest names.
        let mut tampered = tile_content("tileB");
        tampered["speedLimitSegments"][0]["speedLimit"] = serde_json::json!(130);
        transport.set(&partition_url("tileB"), 200, tampered);
        let (engine, store) = engine_with_one_server(transport.clone());

        let result = engine.sync_static_data("token").await;

        assert!(matches!(result, Err(SyncError::InvalidResponse(_))));
        // Tile A came first and is kept; B was refused and C never asked for.
        assert_eq!(
            store.get_partition_hash("tileA").unwrap(),
            Some(tile_hash("tileA"))
        );
        assert_eq!(store.get_partition_hash("tileB").unwrap(), None);
        assert_eq!(transport.request_count(&partition_url("tileC")), 0);
        assert_eq!(store.all_entities().unwrap().speed_limit_segments.len(), 2);
    }

    #[tokio::test]
    async fn the_content_addressed_path_is_used_when_the_manifest_has_one() {
        let transport = Arc::new(MockTransport::new());
        let content = tile_content("tileA");
        let hash = hash_of(&content);
        transport.set(
            MANIFEST_URL,
            200,
            serde_json::json!({
                "staticDataVersion": 1,
                "generatedAt": "2026-01-01T00:00:00Z",
                "partitionResolution": 4,
                "partitions": [{
                    "tile": "tileA", "hash": hash, "sizeBytes": 100,
                    "gzipBytes": 30, "brotliBytes": 28,
                    "path": format!("/v1/static-data/packages/tileA/{hash}")
                }]
            }),
        );
        transport.set(
            &format!("https://a.example/v1/static-data/packages/tileA/{hash}"),
            200,
            content,
        );
        let (engine, store) = engine_with_one_server(transport.clone());

        engine.sync_static_data("token").await.unwrap();

        assert_eq!(transport.request_count(&partition_url("tileA")), 0);
        assert_eq!(store.all_entities().unwrap().speed_limit_segments.len(), 2);
    }

    #[tokio::test]
    async fn a_new_partition_resolution_replaces_the_stored_packages() {
        let transport = Arc::new(MockTransport::new());
        set_three_partitions_at(&transport, &["tileA", "tileB", "tileC"], Some(2));
        let (engine, store) = engine_with_one_server(transport.clone());
        engine.sync_static_data("token").await.unwrap();
        assert_eq!(store.static_partition_resolution().unwrap(), Some(2));
        assert_eq!(store.all_entities().unwrap().speed_limit_segments.len(), 5);

        // The same server, now cutting its packages at resolution 4: a single
        // new tile, and the old ones gone from the manifest.
        let content = tile_content("tileC");
        transport.set(
            MANIFEST_URL,
            200,
            serde_json::json!({
                "staticDataVersion": 2,
                "generatedAt": "2026-01-02T00:00:00Z",
                "partitionResolution": 4,
                "partitions": [{ "tile": "tile4", "hash": hash_of(&content), "sizeBytes": 100 }]
            }),
        );
        transport.set(&partition_url("tile4"), 200, content);

        let before = engine.plan_static_bootstrap("token").await.unwrap();
        engine.sync_static_data("token").await.unwrap();

        assert_eq!(before.partitions_pending, 1);
        assert_eq!(store.static_partition_resolution().unwrap(), Some(4));
        // Only the new package is left — the old ones were dropped, not merged.
        assert_eq!(store.all_entities().unwrap().speed_limit_segments.len(), 1);
        assert_eq!(store.get_partition_hash("tileA").unwrap(), None);
    }

    #[tokio::test]
    async fn an_unchanged_resolution_keeps_what_is_stored() {
        let transport = Arc::new(MockTransport::new());
        set_three_partitions_at(&transport, &["tileA", "tileB", "tileC"], Some(4));
        let (engine, store) = engine_with_one_server(transport.clone());
        engine.sync_static_data("token").await.unwrap();
        engine.sync_static_data("token").await.unwrap();

        assert_eq!(transport.request_count(&partition_url("tileA")), 1);
        assert_eq!(store.all_entities().unwrap().speed_limit_segments.len(), 5);
    }

    #[tokio::test]
    async fn a_server_without_a_resolution_in_its_manifest_is_never_second_guessed() {
        let transport = Arc::new(MockTransport::new());
        set_three_partitions(&transport, &["tileA", "tileB", "tileC"]);
        let (engine, store) = engine_with_one_server(transport);
        store.set_static_partition_resolution(2).unwrap();

        engine.sync_static_data("token").await.unwrap();

        assert_eq!(store.static_partition_resolution().unwrap(), Some(2));
        assert_eq!(store.all_entities().unwrap().speed_limit_segments.len(), 5);
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[tokio::test]
    async fn a_bootstrap_killed_midway_resumes_from_the_file_on_the_next_start() {
        use crate::storage::SqliteStore;

        let path = std::env::temp_dir().join(format!("tn-resume-{}.db", std::process::id()));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }

        // First run: only partition A can be fetched; B and C fail — as if the
        // connection dropped, or the app was killed, after the first partition.
        let first_transport = Arc::new(MockTransport::new());
        set_three_partitions(&first_transport, &["tileA"]);
        let store = Arc::new(SqliteStore::open(&path).unwrap());
        let engine = engine_with_store(first_transport.clone(), store.clone());
        assert!(engine.sync_static_data("token").await.is_err());
        assert_eq!(first_transport.request_count(&partition_url("tileA")), 1);
        drop(engine);
        drop(store);

        // Second run: a fresh process, a fresh engine, the same file.
        let second_transport = Arc::new(MockTransport::new());
        set_three_partitions(&second_transport, &["tileA", "tileB", "tileC"]);
        let store = Arc::new(SqliteStore::open(&path).unwrap());
        let engine = engine_with_store(second_transport.clone(), store.clone());
        engine.sync_static_data("token").await.unwrap();

        assert_eq!(second_transport.request_count(&partition_url("tileA")), 0);
        assert_eq!(second_transport.request_count(&partition_url("tileB")), 1);
        assert_eq!(second_transport.request_count(&partition_url("tileC")), 1);
        assert_eq!(store.all_entities().unwrap().speed_limit_segments.len(), 5);

        drop(engine);
        drop(store);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}
