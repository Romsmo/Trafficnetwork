//! Sync engine (F-C3): bootstrap/delta/static-data packages against the
//! federation-aware `discovery::DiscoveryService`, with a per-server cursor
//! persisted through `storage::Store` (F-C0 plan §1.4). `auth` provides the
//! bearer tokens sync calls need; `writebuffer` is the signed offline
//! submission queue; `matching`/`expiry` are local, network-free reads
//! against already-synced data; `withholding` is the client-local
//! anti-withholding sample check (F-C0 plan §1.5); `corrections` is the
//! community speed-limit correction flow (add-on K-C) on top of the same
//! write buffer.

pub mod auth;
pub mod corrections;
pub mod engine;
pub mod expiry;
pub mod matching;
pub mod realtime;
pub mod types;
pub mod withholding;
pub mod writebuffer;

pub use auth::{
    bind_device_key, device_token, exchange_client_secret, register_device, AuthError,
    BindKeyResponse, DeviceRegistration, TokenResponse,
};
pub use corrections::{
    confirm_speed_limit_correction, correction_id, fetch_corrections, report_wrong_speed_limit,
    Correction, CorrectionError, CorrectionTarget, SegmentRef, WrongSpeedLimitReport,
};
pub use engine::{SyncEngine, SyncError};
pub use expiry::{expires_at_unix_ms, expiry_ms_for, is_expired};
pub use matching::{
    distance_to_line_string_meters, haversine_distance_meters, nearby_hazard_reports,
    nearest_speed_limit, nearest_speed_limit_with_proposals, speed_limit_at, NearbyHazardReport,
    NearestSpeedLimit, SpeedLimitOrigin,
};
pub use realtime::run as run_realtime;
pub use types::{
    effective_camera_namespace_enabled, ClientConfig, CommunityCorrectionsConfig, CorrectionReason,
    DeltaPage, EventLogEntry, FixedSpeedCamera, Geometry, HazardReport, HazardType,
    NetworkConfigPayload, PartitionContent, PartitionSummary, SegmentCorrection, SnapshotResult,
    SpeedLimitSegment, SpeedLimitUnit, StaticDataManifest, StaticSign,
};
pub use withholding::{detects_withholding, sample_check, should_sample};
pub use writebuffer::{
    flush_pending, submit_report, FlushOutcome, ReportSubmission, WriteBufferError,
};
