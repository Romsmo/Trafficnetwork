//! `Store`: the local-persistence seam (F-C0 plan §2's `storage/` module) —
//! every entity read/write, per-server sync cursor, static-data partition
//! hash, and offline write-buffer item goes through this trait rather than a
//! concrete database, so each platform binding (F-C4) can supply the storage
//! backend that actually fits it (SQLite via `rusqlite` natively,
//! `sqlite-wasm-rs`/IndexedDB in the browser, ...) without `sync`/`matching`/
//! `writebuffer` depending on any one of them — the same pattern already
//! used for `platform::{Clock, HttpTransport}`.
//!
//! Deliberately **not** a concrete `rusqlite`-backed implementation yet: the
//! trait shape is what the rest of the core needs to stabilize against now,
//! and a real embedded-database implementation (with the R*Tree spatial
//! indexing the F-C0 plan calls for) is naturally a per-platform concern —
//! it lands with F-C4's bindings, where each target's actual storage
//! constraints (native file access vs. `sqlite-wasm-rs` in a browser) are
//! known, rather than being guessed at here. [`InMemoryStore`] is the
//! reference implementation every test in this crate runs against in the
//! meantime — deterministic, no I/O, and exercises the exact same trait a
//! real backend must satisfy.

mod memory;

pub use memory::InMemoryStore;

use serde::{Deserialize, Serialize};

use crate::sync::types::{
    CorrectionReason, FixedSpeedCamera, HazardReport, SpeedLimitSegment, SpeedLimitUnit, StaticSign,
};

pub type StoreError = Box<dyn std::error::Error + Send + Sync>;

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
}
