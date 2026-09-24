//! `Store`: the local-persistence seam (F-C0 plan §2's `storage/` module) —
//! every entity read/write, per-server sync cursor, static-data partition
//! hash, and offline write-buffer item goes through this trait rather than a
//! concrete database, so each platform binding (F-C4) can supply the storage
//! backend that actually fits it (SQLite via `rusqlite` natively,
//! `sqlite-wasm-rs`/IndexedDB in the browser, ...) without `sync`/`matching`/
//! `writebuffer` depending on any one of them — the same pattern already
//! used for `platform::{Clock, HttpTransport}`.
//!
//! [`SqliteStore`] (native targets) is the persistent implementation: SQLite
//! through `rusqlite`, with an R*Tree over the segments' bounding boxes so a
//! position lookup touches a handful of rows instead of the whole dataset.
//! [`InMemoryStore`] is the reference implementation the engine tests run
//! against. Browser targets (`sqlite-wasm-rs`/IndexedDB) bring their own
//! `Store` with F-C4's WASM binding. Both implementations here are held to
//! the same behaviour by one shared contract test.

#[cfg(test)]
mod contract;
mod memory;
#[cfg(not(target_arch = "wasm32"))]
mod sqlite;

pub use memory::InMemoryStore;
#[cfg(not(target_arch = "wasm32"))]
pub use sqlite::SqliteStore;

use serde::{Deserialize, Serialize};

use crate::sync::types::{
    CorrectionReason, FixedSpeedCamera, Geometry, HazardReport, SpeedLimitSegment, SpeedLimitUnit,
    StaticSign,
};

pub type StoreError = Box<dyn std::error::Error + Send + Sync>;

/// What a store puts inside its [`StoreError`] when it has run out of room
/// (a full disk, a quota) — the one storage failure a host app can act on, so
/// the sync engine recognises it ([`is_storage_full`]) and reports it as
/// `SyncError::StorageFull` instead of an opaque storage error.
#[derive(Debug)]
pub struct StorageFullError;

impl std::fmt::Display for StorageFullError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the local store is out of space")
    }
}

impl std::error::Error for StorageFullError {}

pub fn is_storage_full(error: &StoreError) -> bool {
    error.downcast_ref::<StorageFullError>().is_some()
}

/// `(min_lng, max_lng, min_lat, max_lat)` of a segment's line string.
pub(crate) fn segment_bbox(segment: &SpeedLimitSegment) -> Option<(f64, f64, f64, f64)> {
    let Geometry::LineString { coordinates } = &segment.geometry else {
        return None;
    };
    let first = coordinates.first()?;
    let mut bbox = (first[0], first[0], first[1], first[1]);
    for c in coordinates {
        bbox.0 = bbox.0.min(c[0]);
        bbox.1 = bbox.1.max(c[0]);
        bbox.2 = bbox.2.min(c[1]);
        bbox.3 = bbox.3.max(c[1]);
    }
    Some(bbox)
}

/// The box around a point that holds everything within `radius_meters` of
/// it, as `(min_lng, max_lng, min_lat, max_lat)`. Slightly generous on
/// purpose (111,000 m per degree, below the real 111,195): the exact
/// distance is measured afterwards, so a box that is a little too large
/// costs nothing and one that is too small would lose segments.
pub(crate) fn query_box(lat: f64, lng: f64, radius_meters: f64) -> (f64, f64, f64, f64) {
    const METERS_PER_DEGREE: f64 = 111_000.0;
    let lat_margin = radius_meters / METERS_PER_DEGREE;
    let cos_lat = lat.to_radians().cos().abs().max(0.01);
    let lng_margin = radius_meters / (METERS_PER_DEGREE * cos_lat);
    (lng - lng_margin, lng + lng_margin, lat - lat_margin, lat + lat_margin)
}

pub(crate) fn boxes_intersect(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> bool {
    a.0 <= b.1 && a.1 >= b.0 && a.2 <= b.3 && a.3 >= b.2
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct StoredEntities {
    pub speed_limit_segments: Vec<SpeedLimitSegment>,
    pub static_signs: Vec<StaticSign>,
    pub fixed_speed_cameras: Vec<FixedSpeedCamera>,
    pub hazard_reports: Vec<HazardReport>,
}

/// A signed-but-not-yet-confirmed-delivered report submission
/// (`writebuffer::submit_report`) — kept until the server accepts or
/// permanently rejects it, so a submission made while offline survives a
/// process restart. `id` is local-only (never sent to a server); `request_body`
/// is the exact `POST /v1/hazard-reports` body, already including
/// `deviceAssertion` when a device key is bound.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingWrite {
    pub id: String,
    pub request_body: serde_json::Value,
    pub created_at_unix_ms: i64,
    pub attempts: u32,
    #[serde(default)]
    pub kind: WriteKind,
}

/// What a queued write is. Most need more than the plain request body to be
/// sent, so the extra routing/signing data travels with the write itself.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum WriteKind {
    /// `POST /v1/hazard-reports`.
    #[default]
    HazardReport,
    /// `POST /v1/speed-limit-segments/:id/corrections`. `segment_id` is a
    /// server-local row id (of whichever server supplied the segment, so
    /// another server may not know it); `segment_key` is the segment's
    /// cross-server identity, used to find the right row on another server
    /// and to sign; `resolve_hint` is `(lat, lng)` of a vertex of the
    /// segment, where to look for it.
    SpeedLimitCorrection {
        segment_id: String,
        segment_key: String,
        resolve_hint: Option<(f64, f64)>,
    },
    /// `POST /v1/speed-limit-corrections/:id/confirmations`. The correction's
    /// own `segment_key`/`value`/`unit` are what a device-signed vote must
    /// name — the confirmation body itself carries none of them.
    SpeedLimitConfirmation {
        correction_id: String,
        segment_key: String,
        value: u32,
        unit: SpeedLimitUnit,
        agrees: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProposalState {
    /// Still in the write buffer.
    Queued,
    /// The server accepted it — it stands as a vote there, but is not (yet)
    /// a community-confirmed correction.
    Sent,
}

/// This device's own, not-yet-confirmed correction proposal for one segment —
/// an **overlay** next to the synced segment, never a change to it, so the
/// imported value is always still there to fall back to. At most one per
/// `segment_key`: a device supports one value per segment
/// (`server/docs/speed-limit-corrections.md` D3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalCorrectionProposal {
    pub segment_key: String,
    pub segment_id: String,
    pub value: u32,
    pub unit: SpeedLimitUnit,
    pub reason: Option<CorrectionReason>,
    pub state: ProposalState,
    /// Known once the server has accepted the proposal.
    pub correction_id: Option<String>,
    /// The server's count when it accepted it (it includes this device);
    /// `0` while still queued.
    pub confirmations: u32,
    pub proposed_at_unix_ms: i64,
}

/// `entity_type` matches the server's `EntityType` values
/// (`server/src/config/constants.ts`): `"speedLimitSegment"`, `"staticSign"`,
/// `"fixedSpeedCamera"`, `"hazardReport"`.
pub trait Store: Send + Sync {
    fn get_cursor(&self, node_id: &str) -> Result<Option<u64>, StoreError>;
    fn set_cursor(&self, node_id: &str, since: u64) -> Result<(), StoreError>;

    fn get_partition_hash(&self, tile: &str) -> Result<Option<String>, StoreError>;
    fn set_partition_hash(&self, tile: &str, hash: &str) -> Result<(), StoreError>;

    /// Drops every locally stored static entity — used only ahead of a full
    /// snapshot bootstrap, never for an incremental partition update (see
    /// `upsert_static_data`).
    fn clear_static_data(&self) -> Result<(), StoreError>;

    /// Insert-or-replace by id. Used for both a full snapshot's static
    /// payload and a single re-fetched partition's content — upsert-only by
    /// design, since a partition can straddle another partition's boundary
    /// (`server/docs/api.md`'s manifest section) and inferring "no longer
    /// present in this one partition" as "removed" would be wrong when the
    /// same entity is still listed under a different partition. Actual
    /// removal is a `StaticDataRemoved` delta event (`remove_static_entity`),
    /// mirroring how the server itself models it.
    fn upsert_static_data(&self, data: &StoredEntities) -> Result<(), StoreError>;

    fn remove_static_entity(&self, entity_type: &str, entity_id: &str) -> Result<(), StoreError>;

    fn upsert_hazard_reports(&self, reports: &[HazardReport]) -> Result<(), StoreError>;
    fn remove_hazard_report(&self, id: &str) -> Result<(), StoreError>;

    fn all_entities(&self) -> Result<StoredEntities, StoreError>;

    fn enqueue_write(&self, item: &PendingWrite) -> Result<(), StoreError>;
    fn pending_writes(&self) -> Result<Vec<PendingWrite>, StoreError>;
    fn remove_pending_write(&self, id: &str) -> Result<(), StoreError>;

    /// Insert-or-replace by `segment_key`.
    fn upsert_local_proposal(&self, proposal: &LocalCorrectionProposal) -> Result<(), StoreError>;
    fn local_proposals(&self) -> Result<Vec<LocalCorrectionProposal>, StoreError>;
    fn remove_local_proposal(&self, segment_key: &str) -> Result<(), StoreError>;

    /// Adds one static-data partition's entities *and* records its hash. A
    /// store with transactions should make this atomic: a bootstrap killed
    /// between the two steps would otherwise download that partition again
    /// for nothing when it resumes. (The default is the two calls in a row.)
    fn upsert_static_partition(
        &self,
        tile: &str,
        hash: &str,
        data: &StoredEntities,
    ) -> Result<(), StoreError> {
        self.upsert_static_data(data)?;
        self.set_partition_hash(tile, hash)
    }

    /// Segments that may lie within `radius_meters` of a point — a superset
    /// is fine (the matcher measures exactly), but a store with a spatial
    /// index should return only the handful nearby, not the whole dataset.
    /// (The default returns every segment.)
    fn speed_limit_segments_near(
        &self,
        _lat: f64,
        _lng: f64,
        _radius_meters: f64,
    ) -> Result<Vec<SpeedLimitSegment>, StoreError> {
        Ok(self.all_entities()?.speed_limit_segments)
    }

    /// One segment by its id — indexed in a real store. (The default scans
    /// everything.)
    fn speed_limit_segment(&self, id: &str) -> Result<Option<SpeedLimitSegment>, StoreError> {
        Ok(self
            .all_entities()?
            .speed_limit_segments
            .into_iter()
            .find(|s| s.id == id))
    }

    /// How many bytes the store occupies, if it can tell — for reports and
    /// for a host app's own free-space checks.
    fn storage_bytes(&self) -> Option<u64> {
        None
    }
}
