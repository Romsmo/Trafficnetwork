//! The public API of the library (F-C0 plan §3): [`TrafficNetworkClient`],
//! what a host app creates and talks to, plus the seams it fills in
//! ([`Platform`]: store, secret store, HTTP, clock) and the options it
//! passes. Every binding exposes exactly this, through [`TrafficNetworkClient::call`].
//!
//! See `client-lib/docs/api.md` for the method-by-method description.

mod client;
mod dispatch;
mod error;
mod events;
mod options;
mod secure_store;
mod tiles;
mod types;

pub use client::{Platform, TrafficNetworkClient};
pub use dispatch::API_VERSION;
pub use error::{code, ApiError};
pub use events::{ClientEvent, EventHub, Listener as EventListener};
pub use options::{ClientOptions, Credentials, DEFAULT_NETWORK_ROOT_KEY, DEFAULT_SEEDS};
#[cfg(not(target_arch = "wasm32"))]
pub use secure_store::FileSecureStore;
pub use secure_store::{MemorySecureStore, SecureStore};
pub use tiles::{ring_for_speed, tile_at, tiles_around, DEFAULT_REGION_RESOLUTION};
pub use types::{
    BootstrapPlanView, NearbyCategory, NearbyItem, NetworkStatusView, NodeView, OriginView,
    PositionUpdate, ProposalView, SpeedLimitAnswer, SyncReport, SyncStatus, TickResult,
};

#[cfg(test)]
mod tests;
