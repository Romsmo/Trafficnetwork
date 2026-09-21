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

use crate::sync::types::{FixedSpeedCamera, HazardReport, SpeedLimitSegment, StaticSign};

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
}
