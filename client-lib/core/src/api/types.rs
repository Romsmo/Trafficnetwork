//! What the public calls hand back. Plain data with `camelCase` JSON names —
//! the shapes are identical in every binding.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::discovery::KnownServer;
use crate::status::NetworkStatus;
use crate::storage::{LocalCorrectionProposal, ProposalState};
use crate::sync::{CameraLevel, CameraNotice, NearestSpeedLimit, SpeedLimitOrigin};

/// The speed limit in effect at a position, and where it comes from.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedLimitAnswer {
    pub value: f64,
    /// `"kmh"` or `"mph"`, as stored — never converted.
    pub unit: String,
    pub segment_id: String,
    /// Names the segment on every server (what a correction refers to).
    pub segment_key: Option<String>,
    pub distance_meters: f64,
    pub origin: OriginView,
    /// The import's own value, while another one is in effect.
    pub imported_value: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OriginView {
    Imported,
    /// This device's own proposal, not confirmed by anyone else yet.
    LocallyProposed {
        confirmations: u32,
    },
    CommunityCorrected {
        confirmations: u32,
        #[serde(rename = "needsReview")]
        needs_review: bool,
    },
}

impl From<SpeedLimitOrigin> for OriginView {
    fn from(origin: SpeedLimitOrigin) -> Self {
        match origin {
            SpeedLimitOrigin::Imported => OriginView::Imported,
            SpeedLimitOrigin::LocallyProposed { confirmations } => {
                OriginView::LocallyProposed { confirmations }
            }
            SpeedLimitOrigin::CommunityCorrected {
                confirmations,
                needs_review,
            } => OriginView::CommunityCorrected {
                confirmations,
                needs_review,
            },
        }
    }
}

impl From<NearestSpeedLimit> for SpeedLimitAnswer {
    fn from(nearest: NearestSpeedLimit) -> Self {
        Self {
            value: nearest.speed_limit,
            unit: nearest.speed_limit_unit,
            segment_id: nearest.segment_id,
            segment_key: nearest.segment_key,
            distance_meters: nearest.distance_meters,
            origin: nearest.origin.into(),
            imported_value: nearest.imported_speed_limit,
        }
    }
}

/// This device's own speed-limit proposal.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalView {
    pub segment_key: String,
    pub segment_id: String,
    pub value: u32,
    pub unit: String,
    /// `"queued"` (not sent yet) or `"sent"` (the server has it).
    pub state: String,
    pub correction_id: Option<String>,
    pub confirmations: u32,
}

impl From<&LocalCorrectionProposal> for ProposalView {
    fn from(proposal: &LocalCorrectionProposal) -> Self {
        Self {
            segment_key: proposal.segment_key.clone(),
            segment_id: proposal.segment_id.clone(),
            value: proposal.value,
            unit: proposal.unit.as_str().to_string(),
            state: match proposal.state {
                ProposalState::Queued => "queued",
                ProposalState::Sent => "sent",
            }
            .to_string(),
            correction_id: proposal.correction_id.clone(),
            confirmations: proposal.confirmations,
        }
    }
}

/// What `getNearby` can be asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NearbyCategory {
    /// Reports from drivers: traffic, ice, accidents, ...
    Hazards,
    /// Static traffic signs.
    Signs,
    /// Speed cameras — only while the server, the network configuration and
    /// the host app all allow the camera namespace; otherwise never.
    Cameras,
}

impl NearbyCategory {
    pub const ALL: [NearbyCategory; 3] = [
        NearbyCategory::Hazards,
        NearbyCategory::Signs,
        NearbyCategory::Cameras,
    ];
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NearbyItem {
    #[serde(rename_all = "camelCase")]
    Hazard {
        id: String,
        /// The hazard type as the server names it (`"ice"`, `"accident"`, ...).
        hazard_type: String,
        lat: f64,
        lng: f64,
        distance_meters: f64,
        expires_at: Option<String>,
        confirm_count: u32,
        deny_count: u32,
        /// Submitted from this device and not delivered to a server yet.
        pending: bool,
    },
    #[serde(rename_all = "camelCase")]
    Sign {
        id: String,
        sign_type: String,
        lat: f64,
        lng: f64,
        distance_meters: f64,
    },
    #[serde(rename_all = "camelCase")]
    Camera {
        id: String,
        camera_type: String,
        lat: f64,
        lng: f64,
        distance_meters: f64,
    },
    /// A coarse area in which cameras of some kinds exist — all a country at
    /// level `zones` lets through. There is deliberately no position of a
    /// single camera: draw `outline` as an area, not a pin.
    #[serde(rename_all = "camelCase")]
    CameraZone {
        id: String,
        /// The H3 index of the cell.
        cell: String,
        resolution: u8,
        /// The cell's outline as `[lng, lat]` positions (the outer ring).
        outline: Vec<[f64; 2]>,
        /// The kinds of camera present, sorted.
        camera_types: Vec<String>,
        /// `0` when the position is inside the zone.
        distance_meters: f64,
    },
}

impl NearbyItem {
    pub fn distance_meters(&self) -> f64 {
        match self {
            NearbyItem::Hazard {
                distance_meters, ..
            }
            | NearbyItem::Sign {
                distance_meters, ..
            }
            | NearbyItem::Camera {
                distance_meters, ..
            }
            | NearbyItem::CameraZone {
                distance_meters, ..
            } => *distance_meters,
        }
    }
}

/// What one sync cycle did.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// Another sync was already running; this call did nothing.
    pub skipped: bool,
    /// Every part worked.
    pub ok: bool,
    /// Error code of the static-data part, if it failed.
    pub static_data_error: Option<String>,
    /// Error code of the reports/delta part, if it failed.
    pub dynamic_data_error: Option<String>,
    /// Queued writes the server accepted this time.
    pub submitted: usize,
    /// Queued writes a server refused for good (they are dropped).
    pub rejected: usize,
    /// Still waiting to be sent.
    pub pending_writes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickResult {
    /// A sync ran (the interval had passed, or the position moved to other tiles).
    pub synced: bool,
    pub report: Option<SyncReport>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionUpdate {
    /// The tiles watched now.
    pub tiles: Vec<String>,
    /// They differ from before, so the next `tick` syncs.
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// `"never"` (no sync has run), `"online"` (the last one worked) or
    /// `"offline"` (it did not).
    pub connection: String,
    pub last_synced_at_unix_ms: Option<i64>,
    pub pending_writes: usize,
    pub subscribed_tiles: Vec<String>,
    /// The server's version of the static data, from its configuration.
    pub static_data_version: Option<u64>,
    pub last_error_code: Option<String>,
    pub last_error_message: Option<String>,
    /// Space the local store takes, if it can tell.
    pub storage_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeView {
    pub node_id: String,
    pub address: String,
    /// `"probation"`, `"active"` or `"trusted"`, as the directory says.
    pub tier: String,
    pub backed_off: bool,
}

impl NodeView {
    pub(crate) fn from_server(server: &KnownServer, now_unix_ms: i64) -> Self {
        Self {
            node_id: server.node_id.clone(),
            address: server.address.clone(),
            tier: format!("{:?}", server.tier).to_lowercase(),
            backed_off: server.is_backed_off(now_unix_ms),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatusView {
    pub known_nodes: Vec<NodeView>,
    /// Known and not backed off.
    pub active_nodes: Vec<String>,
    /// The servers used right now.
    pub current_nodes: Vec<String>,
    pub directory_generated_at: Option<String>,
    /// Version of the verified signed network configuration, if there is one.
    pub config_version: Option<u64>,
    /// Whether the camera namespace is on (server, network and host app agree).
    pub camera_namespace_enabled: bool,
    #[serde(flatten)]
    pub online: NetworkStatus,
}

/// What the camera policy of the network allows right now, and the notice a
/// host app shows before it lets a user switch cameras on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraPolicyView {
    /// The host app's own switch (the `cameraNamespaceEnabled` option): off
    /// unless the host turned it on — the equivalent of the user's
    /// "show speed cameras" checkbox.
    pub host_enabled: bool,
    /// Cameras (or zones) are shown by `getNearby` right now: the host
    /// switch is on and the policy lets something through.
    pub active: bool,
    /// The emergency brake is released. `false`: every country is off.
    pub enabled: bool,
    /// The most any country allows: `off` shows nothing, `zones` only zones,
    /// `full` individual cameras too.
    pub max_level: CameraLevel,
    /// The level of every country not in `by_country`.
    pub default_level: CameraLevel,
    /// ISO 3166-1 alpha-2 → level, the strictest reading of the node's
    /// policy and the verified network policy.
    pub by_country: BTreeMap<String, CameraLevel>,
    /// The H3 resolution zones are cut at, once the node said.
    pub zone_resolution: Option<u8>,
    /// Changes whenever the node's policy changes.
    pub version: Option<String>,
    /// The legal notice, by language. Show it once when the user first
    /// switches cameras on, and again when `notice.version` grows.
    pub notice: CameraNotice,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPlanView {
    pub partitions_total: usize,
    pub partitions_pending: usize,
    /// Size of the JSON of everything (an upper bound of what it takes on
    /// disk: the database is smaller).
    pub bytes_total: u64,
    pub bytes_pending: u64,
}
