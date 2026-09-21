//! Sync engine (F-C3): bootstrap/delta/static-data packages against the
//! federation-aware `discovery::DiscoveryService`, with a per-server cursor
//! persisted through `storage::Store` (F-C0 plan §1.4).

pub mod auth;
pub mod engine;
pub mod types;

pub use auth::{
    bind_device_key, device_token, exchange_client_secret, register_device, AuthError,
    BindKeyResponse, DeviceRegistration, TokenResponse,
};
pub use engine::{SyncEngine, SyncError};
pub use types::{
    effective_camera_namespace_enabled, ClientConfig, DeltaPage, EventLogEntry, FixedSpeedCamera,
    Geometry, HazardReport, HazardType, NetworkConfigPayload, PartitionContent, PartitionSummary,
    SnapshotResult, SpeedLimitSegment, StaticDataManifest, StaticSign,
};
