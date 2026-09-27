//! The public API: one object a host app creates, asks questions of (all
//! local, all fast) and lets sync when it says so. Everything the earlier
//! milestones built — discovery and failover, the sync engine, the offline
//! write buffer, map matching, corrections — sits behind it.
//!
//! The rules the design follows:
//!
//! * **Reads never touch the network.** `get_speed_limit_at`, `get_nearby`
//!   and the status calls answer from the local store.
//! * **Writes queue first.** `submit_report` and the votes are stored
//!   locally and sent by the next `sync`/`tick`; a report made offline is
//!   visible to the device that made it right away.
//! * **Nothing runs by itself.** The host app calls `tick()` (cheap, syncs
//!   when due) or `sync()`; scheduling belongs to the platform.
//! * **Servers are not trusted, and neither is one server.** See the other
//!   modules; here that shows as the camera namespace needing three yeses
//!   (server, verified network configuration, host app) and as reports being
//!   de-duplicated across servers when they are read.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::crypto::{generate_ed25519_keypair, verify_signed_envelope, Ed25519KeyPair};
use crate::discovery::{DiscoveryConfig, DiscoveryService};
use crate::platform::{Clock, HttpTransport, Sleep, WsTransport};
use crate::status::OnlineStatusService;
use crate::storage::{Store, WriteKind};
use crate::sync::{
    bind_device_key, confirm_hazard_report, confirm_speed_limit_correction,
    effective_camera_namespace_enabled, exchange_client_secret, fetch_corrections, flush_pending,
    haversine_distance_meters, nearby_hazard_reports, register_device, report_camera_removed,
    report_wrong_speed_limit, run_realtime as run_realtime_protocol, speed_limit_at,
    submit_report, ClientConfig, Correction, CorrectionTarget, FlushOutcome, HazardType,
    NetworkConfigPayload, ReportSubmission, SegmentRef, SyncEngine, WrongSpeedLimitReport,
};

use super::error::{code, ApiError};
use super::events::{ClientEvent, EventHub, HubObserver};
use super::options::{ClientOptions, Credentials};
use super::secure_store::{
    SecureStore, KEY_BOUND_PUBLIC_KEY, KEY_CLIENT_ID, KEY_CLIENT_SECRET, KEY_PRIVATE_KEY,
    KEY_PUBLIC_KEY,
};
use super::tiles::{ring_for_speed, tiles_around, DEFAULT_REGION_RESOLUTION};
use super::types::{
    BootstrapPlanView, NearbyCategory, NearbyItem, NetworkStatusView, NodeView, PositionUpdate,
    ProposalView, SpeedLimitAnswer, SyncReport, SyncStatus, TickResult,
};

/// How long a fetched `GET /v1/config` is used before it is fetched again.
const CONFIG_TTL_MS: i64 = 10 * 60 * 1000;
/// A token is renewed this long before it runs out.
const TOKEN_MARGIN_MS: i64 = 30_000;
/// How far from a position `getSpeedLimitAt` looks, until the server's
/// configuration says otherwise.
const DEFAULT_LOOKUP_METERS: f64 = 50.0;
/// How long `run_realtime` waits before looking again when there is no
/// server to even try (nothing known yet, or every one just failed to
/// issue a token) — short enough that push resumes soon after a server
/// comes back, not so short that a genuinely offline device spins.
const NO_SERVER_RETRY_MS: u64 = 5_000;

/// The host app's side of the seams: where things are stored, how to reach
/// the network, what time it is.
pub struct Platform {
    pub store: Arc<dyn Store>,
    pub secure_store: Arc<dyn SecureStore>,
    pub http: Arc<dyn HttpTransport>,
    pub clock: Arc<dyn Clock>,
    /// Backs [`TrafficNetworkClient::run_realtime`] (add-on B1). Unused by
    /// every other call — a host app that never starts realtime push never
    /// needs this to do anything.
    pub ws: Arc<dyn WsTransport>,
    pub sleep: Arc<dyn Sleep>,
}

#[cfg(not(target_arch = "wasm32"))]
impl Platform {
    /// The native defaults, all inside `directory`: a SQLite database, a
    /// secret file (see [`super::FileSecureStore`] for what that is and is
    /// not), `reqwest` for the network, the system clock, `tokio-tungstenite`
    /// for realtime push and `tokio::time::sleep` for the reconnect backoff.
    pub fn native(directory: impl AsRef<std::path::Path>) -> Result<Self, ApiError> {
        let directory = directory.as_ref();
        std::fs::create_dir_all(directory).map_err(|e| {
            ApiError::new(code::STORAGE, format!("cannot create {directory:?}: {e}"))
        })?;
        let store = crate::storage::SqliteStore::open(directory.join("trafficnetwork.db"))?;
        Ok(Self {
            store: Arc::new(store),
            secure_store: Arc::new(super::secure_store::FileSecureStore::new(
                directory.join("secure-store.json"),
            )),
            http: Arc::new(
                crate::platform::ReqwestHttpTransport::new()
                    .map_err(|e| ApiError::new(code::NETWORK, e.to_string()))?,
            ),
            clock: Arc::new(crate::platform::SystemClock),
            ws: Arc::new(crate::platform::TokioTungsteniteWsTransport),
            sleep: Arc::new(crate::platform::TokioSleeper),
        })
    }
}

struct CachedToken {
    access_token: String,
    expires_at_ms: i64,
}

struct CachedConfig {
    config: ClientConfig,
    /// The network configuration, only if its signature verified against the
    /// root key.
    network: Option<NetworkConfigPayload>,
    fetched_at_ms: i64,
}

#[derive(Default)]
struct State {
    token: Option<CachedToken>,
    config: Option<CachedConfig>,
    /// The device's signing key, once it exists and the server has bound it.
    device_key: Option<Ed25519KeyPair>,
    tiles: Vec<String>,
    /// The tiles changed since the last sync.
    sync_due: bool,
    last_sync_at_ms: Option<i64>,
    last_sync_ok: Option<bool>,
    last_error: Option<ApiError>,
    syncing: bool,
    closed: bool,
}

pub struct TrafficNetworkClient {
    options: ClientOptions,
    clock: Arc<dyn Clock>,
    store: Arc<dyn Store>,
    secure: Arc<dyn SecureStore>,
    discovery: Arc<DiscoveryService>,
    engine: SyncEngine,
    online: OnlineStatusService,
    events: Arc<EventHub>,
    ws: Arc<dyn WsTransport>,
    sleep: Arc<dyn Sleep>,
    state: Mutex<State>,
}

/// Puts `State::syncing` back however a sync ends.
struct SyncGuard<'a>(&'a Mutex<State>);

impl Drop for SyncGuard<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap().syncing = false;
    }
}

impl TrafficNetworkClient {
    pub fn new(options: ClientOptions, platform: Platform) -> Result<Self, ApiError> {
        let discovery = Arc::new(DiscoveryService::new(
            platform.http,
            platform.clock.clone(),
            DiscoveryConfig {
                seeds: if options.discovery {
                    options.effective_seeds()
                } else {
                    Vec::new()
                },
                ..DiscoveryConfig::default()
            },
        ));
        if !options.nodes.is_empty() {
            let nodes: Vec<(String, String)> = options
                .nodes
                .iter()
                .map(|address| (address.trim_end_matches('/').to_string(), address.clone()))
                .collect();
            discovery.seed_fixed_nodes(&nodes);
        } else if !options.discovery {
            return Err(ApiError::invalid(
                "discovery is off and no fixed nodes are given: there would be no server to talk to",
            ));
        }
        let events = Arc::new(EventHub::new());
        let engine = SyncEngine::new(
            discovery.clone(),
            platform.store.clone(),
            platform.clock.clone(),
        )
        .with_observer(Arc::new(HubObserver(events.clone())));
        let online = OnlineStatusService::new(discovery.clone(), platform.clock.clone());
        Ok(Self {
            options,
            clock: platform.clock,
            store: platform.store,
            secure: platform.secure_store,
            discovery,
            engine,
            online,
            events,
            ws: platform.ws,
            sleep: platform.sleep,
            state: Mutex::new(State::default()),
        })
    }

    // ------------------------------------------------------------ plumbing

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    fn check_open(&self) -> Result<(), ApiError> {
        if self.state().closed {
            Err(ApiError::new(code::CLOSED, "the client was closed"))
        } else {
            Ok(())
        }
    }

    fn now(&self) -> i64 {
        self.clock.now_unix_ms()
    }

    fn cached_config(&self) -> Option<ClientConfig> {
        self.state().config.as_ref().map(|c| c.config.clone())
    }

    fn region_resolution(&self) -> u8 {
        self.state()
            .config
            .as_ref()
            .map(|c| c.config.region_tile_h3_resolution)
            .unwrap_or(DEFAULT_REGION_RESOLUTION)
    }

    /// The camera namespace is on only when the server, the (verified)
    /// network configuration and the host app all say so. Without a fetched
    /// configuration it is off.
    fn camera_namespace_enabled(&self) -> bool {
        if !self.options.camera_namespace_enabled {
            return false;
        }
        let state = self.state();
        match &state.config {
            Some(cached) => {
                effective_camera_namespace_enabled(&cached.config, cached.network.as_ref())
            }
            None => false,
        }
    }

    // ---------------------------------------------------------------- auth

    async fn ensure_token(&self) -> Result<String, ApiError> {
        self.check_open()?;
        let now = self.now();
        if let Some(token) = &self.state().token {
            if token.expires_at_ms - TOKEN_MARGIN_MS > now {
                return Ok(token.access_token.clone());
            }
        }
        let credentials = self.options.credentials.clone().ok_or_else(|| {
            ApiError::new(
                code::NOT_CONFIGURED,
                "no credentials were given to the client",
            )
        })?;
        let (client_id, client_secret) = self.client_credentials(&credentials).await?;
        let response = exchange_client_secret(&self.discovery, &client_id, &client_secret).await?;
        self.state().token = Some(CachedToken {
            access_token: response.access_token.clone(),
            expires_at_ms: self.now() + response.expires_in.max(0) * 1000,
        });
        self.ensure_device_key(&response.access_token).await;
        Ok(response.access_token)
    }

    /// The `client`-scope credential to ask for tokens with: the given one,
    /// or — for an app key — the device's own, registered on first use.
    async fn client_credentials(
        &self,
        credentials: &Credentials,
    ) -> Result<(String, String), ApiError> {
        match credentials {
            Credentials::Client {
                client_id,
                client_secret,
            } => Ok((client_id.clone(), client_secret.clone())),
            Credentials::App {
                app_client_id,
                app_client_secret,
            } => {
                if let (Some(id), Some(secret)) = (
                    self.secure.get(KEY_CLIENT_ID),
                    self.secure.get(KEY_CLIENT_SECRET),
                ) {
                    return Ok((id, secret));
                }
                let app_token =
                    exchange_client_secret(&self.discovery, app_client_id, app_client_secret)
                        .await?;
                let device = register_device(&self.discovery, &app_token.access_token).await?;
                self.secure
                    .set(KEY_CLIENT_ID, &device.client_id)
                    .and_then(|()| self.secure.set(KEY_CLIENT_SECRET, &device.client_secret))
                    .map_err(|e| ApiError::new(code::STORAGE, format!("secure store: {e}")))?;
                Ok((device.client_id, device.client_secret))
            }
        }
    }

    fn stored_key(&self) -> Option<Ed25519KeyPair> {
        Some(Ed25519KeyPair {
            public_key_raw: self.secure.get(KEY_PUBLIC_KEY)?,
            private_key_raw: self.secure.get(KEY_PRIVATE_KEY)?,
        })
    }

    /// Makes sure the device has a signing key and the server knows it, so
    /// reports and votes can be signed. Best effort: without a bound key
    /// everything still works, just unsigned (and not replicated between
    /// servers). Tried again the next time a token is fetched.
    async fn ensure_device_key(&self, token: &str) {
        if self.state().device_key.is_some() {
            return;
        }
        let key = match self.stored_key() {
            Some(key) => key,
            None => {
                let Ok(key) = generate_ed25519_keypair() else {
                    return;
                };
                if self
                    .secure
                    .set(KEY_PUBLIC_KEY, &key.public_key_raw)
                    .is_err()
                    || self
                        .secure
                        .set(KEY_PRIVATE_KEY, &key.private_key_raw)
                        .is_err()
                {
                    return;
                }
                key
            }
        };
        let already_bound =
            self.secure.get(KEY_BOUND_PUBLIC_KEY).as_deref() == Some(key.public_key_raw.as_str());
        if !already_bound {
            match bind_device_key(&self.discovery, &*self.clock, token, &key).await {
                Ok(_) => {
                    let _ = self.secure.set(KEY_BOUND_PUBLIC_KEY, &key.public_key_raw);
                }
                // Not bound: the server is out of reach, or it knows another
                // key for this device already (a reinstall that lost its key
                // store), which this key can then never replace.
                Err(_) => return,
            }
        }
        self.state().device_key = Some(key);
    }

    // -------------------------------------------------------------- config

    async fn ensure_config(&self, token: &str) -> Result<ClientConfig, ApiError> {
        let now = self.now();
        {
            let state = self.state();
            if let Some(cached) = &state.config {
                if now - cached.fetched_at_ms < CONFIG_TTL_MS {
                    return Ok(cached.config.clone());
                }
            }
        }
        let config = self.engine.fetch_config(token).await?;
        let network = match (&config.network_config, self.options.effective_root_key()) {
            (Some(envelope), Some(root_key)) => {
                if verify_signed_envelope(envelope, &root_key) {
                    Some(envelope.payload.clone())
                } else {
                    None
                }
            }
            _ => None,
        };
        self.state().config = Some(CachedConfig {
            config: config.clone(),
            network,
            fetched_at_ms: now,
        });
        Ok(config)
    }

    // --------------------------------------------------------------- reads

    /// The speed limit at a position, from the local store. `heading` is
    /// accepted for the day the matching uses it; today the nearest segment
    /// decides.
    pub fn get_speed_limit_at(
        &self,
        lat: f64,
        lng: f64,
        _heading: Option<f64>,
    ) -> Result<Option<SpeedLimitAnswer>, ApiError> {
        self.check_open()?;
        check_position(lat, lng)?;
        let max_distance = self
            .cached_config()
            .map(|c| c.speed_limit_lookup_max_distance_meters)
            .unwrap_or(DEFAULT_LOOKUP_METERS);
        let nearest = speed_limit_at(&*self.store, lat, lng, max_distance)?;
        Ok(nearest.map(SpeedLimitAnswer::from))
    }

    /// What is around a position, nearest first: reports from drivers
    /// (including this device's own, not yet delivered ones), signs, and —
    /// only when the camera namespace is on — cameras.
    pub fn get_nearby(
        &self,
        lat: f64,
        lng: f64,
        radius_meters: f64,
        categories: &[NearbyCategory],
    ) -> Result<Vec<NearbyItem>, ApiError> {
        self.check_open()?;
        check_position(lat, lng)?;
        if !(radius_meters.is_finite() && radius_meters > 0.0 && radius_meters <= 50_000.0) {
            return Err(ApiError::invalid(
                "radiusMeters must be between 0 and 50000",
            ));
        }
        let wanted =
            |category: NearbyCategory| categories.is_empty() || categories.contains(&category);
        let namespace_on = self.camera_namespace_enabled();
        let config = self.cached_config();
        let now = self.now();
        let mut items: Vec<NearbyItem> = Vec::new();

        if wanted(NearbyCategory::Hazards) {
            let mut reports = self.store.hazard_reports()?;
            // The camera types are the camera namespace's, wherever they turn up.
            if !namespace_on {
                let camera_types = config
                    .as_ref()
                    .map(|c| c.camera_namespace_hazard_types.clone())
                    .unwrap_or_default();
                reports.retain(|r| {
                    !camera_types.contains(&r.hazard_type) && !is_camera_type(r.hazard_type)
                });
            }
            for found in nearby_hazard_reports(lat, lng, &reports, radius_meters, now) {
                let Some((report_lat, report_lng)) = found.report.position.as_lat_lng() else {
                    continue;
                };
                items.push(NearbyItem::Hazard {
                    id: found.report.id,
                    hazard_type: hazard_type_name(found.report.hazard_type),
                    lat: report_lat,
                    lng: report_lng,
                    distance_meters: found.distance_meters,
                    expires_at: Some(found.report.expires_at),
                    confirm_count: found.report.confirm_count,
                    deny_count: found.report.deny_count,
                    pending: false,
                });
            }
            for write in self.store.pending_writes()? {
                if !matches!(write.kind, WriteKind::HazardReport) {
                    continue;
                }
                if let Some(item) =
                    pending_hazard(&write.id, &write.request_body, lat, lng, radius_meters)
                {
                    items.push(item);
                }
            }
            let merge_radius = config
                .as_ref()
                .map(|c| c.duplicate_merge_radius_meters)
                .unwrap_or(0.0);
            items = merge_duplicate_hazards(items, merge_radius);
        }

        if wanted(NearbyCategory::Signs) {
            for sign in self.store.static_signs_near(lat, lng, radius_meters)? {
                let Some((sign_lat, sign_lng)) = sign.position.as_lat_lng() else {
                    continue;
                };
                let distance = haversine_distance_meters(lat, lng, sign_lat, sign_lng);
                if distance <= radius_meters {
                    items.push(NearbyItem::Sign {
                        id: sign.id,
                        sign_type: sign.sign_type,
                        lat: sign_lat,
                        lng: sign_lng,
                        distance_meters: distance,
                    });
                }
            }
        }

        if wanted(NearbyCategory::Cameras) && namespace_on {
            for camera in self.store.fixed_speed_cameras()? {
                if camera.status != "active" {
                    continue;
                }
                let Some((camera_lat, camera_lng)) = camera.position.as_lat_lng() else {
                    continue;
                };
                let distance = haversine_distance_meters(lat, lng, camera_lat, camera_lng);
                if distance <= radius_meters {
                    items.push(NearbyItem::Camera {
                        id: camera.id,
                        camera_type: hazard_type_name(camera.camera_type),
                        lat: camera_lat,
                        lng: camera_lng,
                        distance_meters: distance,
                    });
                }
            }
        }

        items.sort_by(|a, b| a.distance_meters().total_cmp(&b.distance_meters()));
        Ok(items)
    }

    // -------------------------------------------------------------- writes

    /// Queues a report for sending and returns its local id. Nothing is sent
    /// now — the next `sync`/`tick` does — and the report shows up in
    /// `get_nearby` (marked `pending`) at once.
    pub fn submit_report(
        &self,
        hazard_type: &str,
        lat: f64,
        lng: f64,
        speed_kmh: Option<f64>,
    ) -> Result<String, ApiError> {
        self.check_open()?;
        check_position(lat, lng)?;
        let hazard_type = parse_hazard_type(hazard_type)?;
        let id = submit_report(
            &*self.store,
            &*self.clock,
            &ReportSubmission {
                hazard_type,
                lat,
                lng,
                speed_kmh,
            },
        )?;
        Ok(id)
    }

    /// "Still there" (`true`) or "gone" (`false`) for a report from
    /// `get_nearby`. Queued like every write.
    pub fn confirm_report(&self, report_id: &str, still_there: bool) -> Result<String, ApiError> {
        self.check_open()?;
        Ok(confirm_hazard_report(
            &*self.store,
            &*self.clock,
            report_id,
            still_there,
        )?)
    }

    /// "This camera is gone."
    pub fn report_camera_removed(&self, camera_id: &str) -> Result<String, ApiError> {
        self.check_open()?;
        Ok(report_camera_removed(
            &*self.store,
            &*self.clock,
            camera_id,
        )?)
    }

    fn corrections_config(&self) -> Result<ClientConfig, ApiError> {
        self.cached_config().ok_or_else(|| {
            ApiError::new(
                code::UNAVAILABLE,
                "the server's configuration has not been fetched yet — sync once first",
            )
        })
    }

    /// Proposes the right speed limit for a segment (by id, or the nearest
    /// one to a position). Effective for this device at once, sent on the
    /// next sync. Fails with `notOffered` if the server has no such feature.
    pub fn report_wrong_speed_limit(
        &self,
        report: &WrongSpeedLimitReport,
    ) -> Result<ProposalView, ApiError> {
        self.check_open()?;
        let config = self.corrections_config()?;
        let proposal = report_wrong_speed_limit(&*self.store, &*self.clock, &config, report)?;
        Ok(ProposalView::from(&proposal))
    }

    /// Agrees or disagrees with a community correction. Returns the local
    /// queue id, or `None` when the vote only withdrew this device's own
    /// still-queued proposal.
    pub fn confirm_speed_limit_correction(
        &self,
        target: &CorrectionTarget,
        agrees: bool,
    ) -> Result<Option<String>, ApiError> {
        self.check_open()?;
        let config = self.corrections_config()?;
        Ok(confirm_speed_limit_correction(
            &*self.store,
            &*self.clock,
            &config,
            target,
            agrees,
        )?)
    }

    /// The target of a vote for the correction a segment currently carries.
    pub fn correction_target_for_segment(
        &self,
        segment_id: &str,
    ) -> Result<CorrectionTarget, ApiError> {
        self.check_open()?;
        let segment = self
            .store
            .speed_limit_segment(segment_id)?
            .ok_or_else(|| ApiError::new(code::UNKNOWN_SEGMENT, "no such segment"))?;
        CorrectionTarget::from_segment(&segment).ok_or_else(|| {
            ApiError::invalid("the segment does not carry a community correction to vote on")
        })
    }

    /// Open proposals and applied corrections around the watched tiles —
    /// for asking a driver "still true?". Needs the network.
    pub async fn fetch_corrections(&self) -> Result<Vec<Correction>, ApiError> {
        let token = self.ensure_token().await?;
        let tiles = self.state().tiles.clone();
        if tiles.is_empty() {
            return Ok(Vec::new());
        }
        Ok(fetch_corrections(&self.discovery, &token, &tiles).await?)
    }

    // ------------------------------------------------------------ position

    /// Tells the client where the device is: it watches that tile and its
    /// neighbours. When the set changes, the next `tick` syncs.
    pub fn update_position(
        &self,
        lat: f64,
        lng: f64,
        speed_kmh: Option<f64>,
    ) -> Result<PositionUpdate, ApiError> {
        self.check_open()?;
        check_position(lat, lng)?;
        let tiles = tiles_around(
            lat,
            lng,
            self.region_resolution(),
            ring_for_speed(speed_kmh),
        );
        let mut state = self.state();
        let changed = state.tiles != tiles;
        if changed {
            state.tiles = tiles.clone();
            state.sync_due = true;
        }
        Ok(PositionUpdate { tiles, changed })
    }

    // ---------------------------------------------------------------- sync

    /// One sync cycle: token, configuration, static data, reports, then the
    /// queued writes. Parts that fail do not stop the others; what happened
    /// is in the report. Fails outright only when the client is closed, has
    /// no credentials, cannot get a token — or the local store is full, which
    /// the host app has to act on.
    pub async fn sync(&self) -> Result<SyncReport, ApiError> {
        self.check_open()?;
        {
            let mut state = self.state();
            if state.syncing {
                return Ok(SyncReport {
                    skipped: true,
                    ..SyncReport::default()
                });
            }
            state.syncing = true;
        }
        let _guard = SyncGuard(&self.state);
        let outcome = self.run_sync().await;
        let mut state = self.state();
        state.last_sync_at_ms = Some(self.now());
        match &outcome {
            Ok(report) => {
                state.last_sync_ok = Some(report.ok);
                state.last_error = report
                    .static_data_error
                    .clone()
                    .or_else(|| report.dynamic_data_error.clone())
                    .map(|c| ApiError::new(&c, "see the events for details"));
            }
            Err(error) => {
                state.last_sync_ok = Some(false);
                state.last_error = Some(error.clone());
            }
        }
        drop(state);
        match &outcome {
            Ok(report) => self.events.emit(ClientEvent::SyncCompleted {
                pending_writes: report.pending_writes,
            }),
            Err(error) => {
                if error.code == code::STORAGE_FULL {
                    self.events.emit(ClientEvent::StorageFull);
                }
                self.events.emit(ClientEvent::SyncFailed {
                    code: error.code.clone(),
                    message: error.message.clone(),
                });
            }
        }
        outcome
    }

    async fn run_sync(&self) -> Result<SyncReport, ApiError> {
        if self.options.discovery {
            // A stale directory is refreshed; failing to is fine as long as
            // there is a pool to work with, which the calls below find out.
            let _ = self.discovery.ensure_fresh_directory().await;
        }
        let token = self.ensure_token().await?;
        // The configuration is needed for tiles and rules; a fetch that fails
        // while an older one exists is not worth failing the sync for.
        if let Err(error) = self.ensure_config(&token).await {
            if self.cached_config().is_none() {
                return Err(error);
            }
        }
        let tiles = self.state().tiles.clone();
        let mut report = SyncReport {
            ok: true,
            ..SyncReport::default()
        };

        if let Err(error) = self.engine.sync_static_data(&token).await {
            let error = ApiError::from(error);
            if error.code == code::STORAGE_FULL {
                return Err(error);
            }
            report.ok = false;
            report.static_data_error = Some(error.code);
        }
        if let Err(error) = self.engine.sync_dynamic(&token, &tiles).await {
            let error = ApiError::from(error);
            if error.code == code::STORAGE_FULL {
                return Err(error);
            }
            report.ok = false;
            report.dynamic_data_error = Some(error.code);
        }

        let device_key = self.state().device_key.clone();
        match flush_pending(
            &*self.store,
            &self.discovery,
            &*self.clock,
            &token,
            device_key.as_ref(),
        )
        .await
        {
            Ok(outcomes) => {
                for outcome in outcomes {
                    match outcome {
                        FlushOutcome::Submitted { .. } => report.submitted += 1,
                        FlushOutcome::Rejected { .. } => report.rejected += 1,
                        FlushOutcome::Failed { .. } => {}
                    }
                }
            }
            Err(error) => return Err(ApiError::from(error)),
        }
        report.pending_writes = self.store.pending_writes()?.len();

        self.online.refresh().await;
        self.state().sync_due = false;
        Ok(report)
    }

    /// Syncs if it is due — the interval has passed, or the position moved to
    /// other tiles — and otherwise does nothing. Cheap to call often.
    pub async fn tick(&self) -> Result<TickResult, ApiError> {
        self.check_open()?;
        let due = {
            let state = self.state();
            let interval = i64::try_from(self.options.sync_interval_seconds)
                .unwrap_or(i64::MAX)
                .saturating_mul(1000);
            match state.last_sync_at_ms {
                None => true,
                Some(last) => state.sync_due || self.now() - last >= interval,
            }
        };
        if !due {
            return Ok(TickResult {
                synced: false,
                report: None,
            });
        }
        let report = self.sync().await?;
        Ok(TickResult {
            synced: !report.skipped,
            report: Some(report),
        })
    }

    /// What a static-data bootstrap still has to download, before it starts —
    /// compare `bytesPending` with the free space. Needs the network.
    pub async fn plan_bootstrap(&self) -> Result<BootstrapPlanView, ApiError> {
        let token = self.ensure_token().await?;
        let plan = self.engine.plan_static_bootstrap(&token).await?;
        Ok(BootstrapPlanView {
            partitions_total: plan.partitions_total,
            partitions_pending: plan.partitions_pending,
            bytes_total: plan.bytes_total,
            bytes_pending: plan.bytes_pending,
        })
    }

    // ------------------------------------------------------------ realtime

    /// Keeps a WebSocket connection to the current best server open,
    /// applying pushed events as they arrive
    /// (`server/docs/api.md`'s "Real-time push", add-on B1) — the events
    /// come out through the same [`ClientEvent::DataChanged`] a delta pull
    /// produces, so a host app does not need to tell them apart. Runs until
    /// `stop` is set to `true` or [`Self::close`] is called; checked between
    /// connection attempts, not while one is open (a live connection ends
    /// when the server closes it or an error occurs, same as any blocking
    /// read).
    ///
    /// A server that fails to connect, or whose connection later errors, is
    /// scored down exactly like a failed HTTP request
    /// ([`crate::discovery::DiscoveryService::record_ws_failure`]) and the
    /// next attempt picks a different one from the pool; a *clean* close is
    /// not held against it. Every (re)connect first closes any gap with a
    /// [`SyncEngine::sync_dynamic`] call — the WebSocket protocol itself has
    /// no replay, so anything that happened while disconnected only ever
    /// arrives through delta — then resumes listening.
    ///
    /// **Known simplification:** the tile subscription used for a
    /// connection is whatever [`Self::update_position`] last set; a change
    /// made while already connected takes effect on the *next* reconnect,
    /// not by pushing new subscribe messages onto a live one
    /// (`sync::realtime::run` subscribes only once, right after the auth
    /// handshake). **Also:** this runs independently of `sync()`/`tick()` —
    /// both may call into the sync engine at the same time, which is safe
    /// (the store and the engine are thread-safe) but not deduplicated.
    ///
    /// Nothing here starts this on its own — the host app decides whether
    /// and when to call it (typically on a background thread/task it owns;
    /// the C ABI's `tn_client_start_realtime` does this using the crate's
    /// own runtime).
    pub async fn run_realtime(&self, stop: &AtomicBool) -> Result<(), ApiError> {
        self.check_open()?;
        while !stop.load(Ordering::Relaxed) && !self.state().closed {
            let Some(server) = self.discovery.current_pool().into_iter().next() else {
                if self.options.discovery {
                    let _ = self.discovery.ensure_fresh_directory().await;
                }
                self.sleep.sleep_ms(NO_SERVER_RETRY_MS).await;
                continue;
            };
            let wait_ms = server
                .backoff_until_unix_ms
                .map(|until| u64::try_from(until - self.now()).unwrap_or(0))
                .unwrap_or(0);
            if wait_ms > 0 {
                self.sleep.sleep_ms(wait_ms).await;
                continue;
            }

            let token = match self.ensure_token().await {
                Ok(token) => token,
                // Nothing will ever fix a missing credential by waiting.
                Err(error) if error.code == code::NOT_CONFIGURED => return Err(error),
                // Every server in the pool just failed to issue a token —
                // transient (all of them briefly down, or a directory
                // that needs refreshing); wait a moment and reassess
                // rather than giving up on realtime push entirely.
                Err(_) => {
                    self.sleep.sleep_ms(NO_SERVER_RETRY_MS).await;
                    continue;
                }
            };

            let url = format!("{}/v1/ws", server.address.trim_end_matches('/'));
            let connect_started = self.now();
            let mut connection = match self.ws.connect(&url).await {
                Ok(connection) => {
                    let elapsed = (self.now() - connect_started).max(0) as f64;
                    self.discovery.record_ws_success(&server.node_id, elapsed);
                    connection
                }
                Err(_) => {
                    self.discovery.record_ws_failure(&server.node_id);
                    continue;
                }
            };

            let tiles = self.state().tiles.clone();
            match self.engine.sync_dynamic(&token, &tiles).await {
                // The one gap-close failure worth stopping the whole loop
                // for — everything else is best-effort (the WebSocket
                // connection itself, about to run, will catch up on
                // whatever it can from here).
                Err(crate::sync::SyncError::StorageFull) => {
                    return Err(ApiError::new(code::STORAGE_FULL, "the local store is out of space"))
                }
                _ => {}
            }

            match run_realtime_protocol(connection.as_mut(), &self.engine, &token, &tiles).await {
                Ok(()) => {} // A clean close is not held against the server.
                Err(_) => self.discovery.record_ws_failure(&server.node_id),
            }
        }
        Ok(())
    }

    // -------------------------------------------------------------- status

    pub fn get_sync_status(&self) -> Result<SyncStatus, ApiError> {
        self.check_open()?;
        let state = self.state();
        let connection = match state.last_sync_ok {
            None => "never",
            Some(true) => "online",
            Some(false) => "offline",
        };
        let pending_writes = self.store.pending_writes()?.len();
        Ok(SyncStatus {
            connection: connection.to_string(),
            last_synced_at_unix_ms: state.last_sync_at_ms,
            pending_writes,
            subscribed_tiles: state.tiles.clone(),
            static_data_version: state.config.as_ref().map(|c| c.config.static_data_version),
            last_error_code: state.last_error.as_ref().map(|e| e.code.clone()),
            last_error_message: state.last_error.as_ref().map(|e| e.message.clone()),
            storage_bytes: self.store.storage_bytes(),
        })
    }

    pub fn get_network_status(&self) -> Result<NetworkStatusView, ApiError> {
        self.check_open()?;
        let now = self.now();
        let known = self.discovery.known_servers();
        let known_nodes: Vec<NodeView> = known
            .iter()
            .map(|server| NodeView::from_server(server, now))
            .collect();
        let active_nodes = known_nodes
            .iter()
            .filter(|node| !node.backed_off)
            .map(|node| node.node_id.clone())
            .collect();
        let current_nodes = self
            .discovery
            .current_pool()
            .into_iter()
            .map(|server| server.node_id)
            .collect();
        let config_version = self
            .state()
            .config
            .as_ref()
            .and_then(|c| c.network.as_ref().map(|n| n.version));
        Ok(NetworkStatusView {
            known_nodes,
            active_nodes,
            current_nodes,
            directory_generated_at: self.discovery.directory_generated_at(),
            config_version,
            camera_namespace_enabled: self.camera_namespace_enabled(),
            online: self.online.network_status(),
        })
    }

    // -------------------------------------------------------------- events

    /// Everything that happened since the last call, oldest first.
    pub fn poll_events(&self) -> Vec<ClientEvent> {
        self.events.drain()
    }

    /// Calls `listener` for every event as it happens (in addition to the
    /// queue `poll_events` drains). `None` removes it.
    pub fn set_event_listener(&self, listener: Option<super::events::Listener>) {
        self.events.set_listener(listener);
    }

    /// After this every call fails with `closed`. Nothing is lost: the store
    /// is already durable, so a new client on the same directory carries on.
    pub fn close(&self) {
        self.state().closed = true;
    }
}

#[cfg(test)]
impl TrafficNetworkClient {
    pub(super) fn store_for_test(&self) -> &Arc<dyn Store> {
        &self.store
    }

    /// As if `GET /v1/config` had been fetched.
    pub(super) fn set_test_config(&self, config: serde_json::Value) {
        self.state().config = Some(CachedConfig {
            config: serde_json::from_value(config).unwrap(),
            network: None,
            fetched_at_ms: self.now(),
        });
    }
}

// ------------------------------------------------------------------ helpers

fn check_position(lat: f64, lng: f64) -> Result<(), ApiError> {
    if lat.is_finite()
        && lng.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lng)
    {
        Ok(())
    } else {
        Err(ApiError::invalid("lat/lng is not a position"))
    }
}

fn parse_hazard_type(name: &str) -> Result<HazardType, ApiError> {
    match serde_json::from_value::<HazardType>(serde_json::Value::String(name.to_string())) {
        Ok(HazardType::Unknown) | Err(_) => {
            Err(ApiError::invalid(format!("unknown hazard type `{name}`")))
        }
        Ok(hazard_type) => Ok(hazard_type),
    }
}

fn hazard_type_name(hazard_type: HazardType) -> String {
    serde_json::to_value(hazard_type)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

/// The five camera-namespace types (`server/docs/api.md`, "Hazard types").
fn is_camera_type(hazard_type: HazardType) -> bool {
    matches!(
        hazard_type,
        HazardType::FixedSpeedCamera
            | HazardType::MobileSpeedCamera
            | HazardType::TrailerCamera
            | HazardType::RedLightCamera
            | HazardType::DistanceControl
    )
}

/// A report still in the write buffer, as it would appear once delivered.
fn pending_hazard(
    id: &str,
    body: &serde_json::Value,
    lat: f64,
    lng: f64,
    radius_meters: f64,
) -> Option<NearbyItem> {
    let hazard_type = body.get("type")?.as_str()?.to_string();
    let report_lat = body.get("lat")?.as_f64()?;
    let report_lng = body.get("lng")?.as_f64()?;
    let distance = haversine_distance_meters(lat, lng, report_lat, report_lng);
    (distance <= radius_meters).then(|| NearbyItem::Hazard {
        id: id.to_string(),
        hazard_type,
        lat: report_lat,
        lng: report_lng,
        distance_meters: distance,
        expires_at: None,
        confirm_count: 0,
        deny_count: 0,
        pending: true,
    })
}

/// The same event can reach a device through two servers with two different
/// ids (each server numbers its own rows). Reports of one type closer to
/// each other than the network's merge radius are the same event: one is
/// kept — the one from a server over a still-pending one, then the one with
/// more confirmations.
fn merge_duplicate_hazards(items: Vec<NearbyItem>, merge_radius_meters: f64) -> Vec<NearbyItem> {
    if merge_radius_meters <= 0.0 {
        return items;
    }
    let mut kept: Vec<NearbyItem> = Vec::with_capacity(items.len());
    for item in items {
        let NearbyItem::Hazard {
            hazard_type,
            lat,
            lng,
            pending,
            confirm_count,
            ..
        } = &item
        else {
            kept.push(item);
            continue;
        };
        let twin = kept.iter().position(|other| {
            matches!(other, NearbyItem::Hazard { hazard_type: other_type, lat: other_lat, lng: other_lng, .. }
                if other_type == hazard_type
                    && haversine_distance_meters(*lat, *lng, *other_lat, *other_lng) <= merge_radius_meters)
        });
        match twin {
            None => kept.push(item),
            Some(index) => {
                let replace = match &kept[index] {
                    NearbyItem::Hazard {
                        pending: other_pending,
                        confirm_count: other_confirms,
                        ..
                    } => {
                        (*other_pending && !*pending)
                            || (*other_pending == *pending && confirm_count > other_confirms)
                    }
                    _ => false,
                };
                if replace {
                    kept[index] = item;
                }
            }
        }
    }
    kept
}

/// A wrongly-typed helper kept private: the sync module's public segment
/// reference, re-exported for the dispatcher.
pub(crate) fn segment_ref(
    id: Option<String>,
    position: Option<(f64, f64)>,
) -> Result<SegmentRef, ApiError> {
    match (id, position) {
        (Some(id), _) => Ok(SegmentRef::Id(id)),
        (None, Some((lat, lng))) => Ok(SegmentRef::Position { lat, lng }),
        (None, None) => Err(ApiError::invalid(
            "name the segment by segmentId or by lat/lng",
        )),
    }
}
