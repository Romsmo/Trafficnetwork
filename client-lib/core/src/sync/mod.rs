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
pub mod camera_policy;
pub mod context_sign_eval;
pub mod context_signs;
pub mod corrections;
pub mod engine;
pub mod expiry;
pub mod intervals;
pub mod matching;
pub mod offline;
pub mod realtime;
pub mod report_ttl;
pub mod roads;
pub(crate) mod server_time;
pub mod types;
pub mod withholding;
pub mod writebuffer;

pub use auth::{
    bind_device_key, device_token, exchange_client_secret, register_device, AuthError,
    BindKeyResponse, DeviceRegistration, TokenResponse,
};
pub use camera_policy::{
    effective_camera_policy, purge_camera_data, CameraLevel, CameraNotice, CameraPolicyConfig,
    CameraZone, EffectiveCameraPolicy, ZoneBoundary,
};
pub use context_sign_eval::{evaluate as evaluate_context_signs, ContextSign, ContextSignQuery};
pub use context_signs::{
    find_stored_entry as find_context_sign_entry, queue_context_sign_proposal,
    queue_context_sign_vote, resolve_context_sign, stored_entries as stored_context_signs,
    stored_tiles as stored_context_sign_tiles, sync_context_signs, ContextSignEntry,
    ContextSignError, ContextSignPreview, ContextSignRequest, ContextSignSyncOutcome,
};
pub use corrections::{
    confirm_speed_limit_correction, correction_id, fetch_corrections, report_speed_limit_interval,
    report_wrong_speed_limit, Correction, CorrectionError, CorrectionTarget, SegmentRef,
    SpeedLimitIntervalReport, WrongSpeedLimitReport,
};
pub use engine::{
    BootstrapPlan, BootstrapProgress, StaticPlanReport, StaticSyncOutcome, StaticSyncRequest,
    SyncEngine, SyncError, SyncObserver,
};
pub use expiry::{expires_at_unix_ms, expiry_ms_for, is_expired};
pub use intervals::IntervalPoint;
pub use matching::{
    distance_to_line_string_meters, haversine_distance_meters, nearby_hazard_reports,
    nearest_speed_limit, nearest_speed_limit_with_proposals, speed_limit_at, NearbyHazardReport,
    NearestSpeedLimit, SpeedLimitOrigin,
};
pub use realtime::run as run_realtime;
pub use report_ttl::{
    check_ttl, limits_for, remaining_seconds, ExpiryRule, ReportLimits, TtlDecision, TtlOutOfRange,
};
pub use roads::{
    fetch_data_defects_near, report_data_defect, resolve_road_interval, CoveredLimit, DataDefect,
    DefectReportAnswer, RoadError, RoadInterval, RoadName,
};
pub use types::{
    effective_camera_namespace_enabled, ClientConfig, CommunityCorrectionsConfig, CorrectionReason,
    DeltaPage, EventLogEntry, FixedSpeedCamera, Geometry, HazardReport, HazardType,
    NetworkConfigPayload, PartitionContent, PartitionSummary, SegmentCorrection, SnapshotResult,
    SpeedLimitSegment, SpeedLimitUnit, StaticDataManifest, StaticSign,
};
pub use withholding::{detects_withholding, sample_check, should_sample};
pub use writebuffer::{
    confirm_hazard_report, flush_pending, report_camera_removed, submit_report, FlushOutcome,
    ReportSubmission, WriteBufferError,
};
