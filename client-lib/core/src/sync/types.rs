//! Mirrors the JSON shapes returned by the sync-related endpoints
//! (`server/docs/api.md` "Sync"/"Static data packages"/"Client config",
//! `server/src/db/queries/*.ts`) field-for-field via `serde(rename)` — same
//! convention as `discovery::types`, so these structs deserialize the
//! server's JSON with no translation layer to get wrong.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::crypto::SignedEnvelope;

/// The 11-value hazard-type enum (`server/src/config/constants.ts`'s
/// `HAZARD_TYPES` — order is documented there as fixed, append-only).
/// `FixedSpeedCamera` is a valid label here (it appears in event payloads
/// and the camera-namespace type lists) even though it's never the `type`
/// of an actual `hazard_reports` row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HazardType {
    Traffic,
    Ice,
    Accident,
    Construction,
    Breakdown,
    Obstacle,
    FixedSpeedCamera,
    MobileSpeedCamera,
    TrailerCamera,
    RedLightCamera,
    DistanceControl,
}

/// A GeoJSON `Point`/`LineString` as the server's `ST_AsGeoJSON` produces it
/// — `coordinates` are always `[lng, lat]` (GeoJSON order), matching every
/// `ST_MakePoint(lng, lat, ...)` call server-side.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Geometry {
    Point { coordinates: [f64; 2] },
    LineString { coordinates: Vec<[f64; 2]> },
}

impl Geometry {
    /// `(lat, lng)` for a `Point` geometry — `None` for anything else (or if
    /// the coordinate order were ever wrong, which is exactly the class of
    /// bug this accessor exists to keep from leaking past a single call site).
    pub fn as_lat_lng(&self) -> Option<(f64, f64)> {
        match self {
            Geometry::Point { coordinates } => Some((coordinates[1], coordinates[0])),
            Geometry::LineString { .. } => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpeedLimitSegment {
    pub id: String,
    pub geometry: Geometry,
    #[serde(rename = "speedLimit")]
    pub speed_limit: f64,
    #[serde(rename = "speedLimitUnit")]
    pub speed_limit_unit: String,
    pub source: String,
    #[serde(rename = "sourceLicense")]
    pub source_license: Option<String>,
    #[serde(rename = "importedAt")]
    pub imported_at: String,
    #[serde(rename = "lastConfirmedAt")]
    pub last_confirmed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StaticSign {
    pub id: String,
    pub position: Geometry,
    #[serde(rename = "signType")]
    pub sign_type: String,
    pub source: String,
    #[serde(rename = "sourceLicense")]
    pub source_license: Option<String>,
    #[serde(rename = "importedAt")]
    pub imported_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixedSpeedCamera {
    pub id: String,
    /// Stamped `"fixedSpeedCamera"` by the server, not a stored column — see
    /// `FixedSpeedCameraApi`'s doc comment in `db/queries/fixed-speed-cameras.ts`.
    #[serde(rename = "type")]
    pub camera_type: HazardType,
    pub position: Geometry,
    pub status: String,
    #[serde(rename = "removedAt")]
    pub removed_at: Option<String>,
    pub source: String,
    #[serde(rename = "sourceLicense")]
    pub source_license: Option<String>,
    #[serde(rename = "importedAt")]
    pub imported_at: String,
    #[serde(rename = "lastConfirmedAt")]
    pub last_confirmed_at: Option<String>,
    #[serde(rename = "removalReportCount")]
    pub removal_report_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HazardReport {
    pub id: String,
    #[serde(rename = "type")]
    pub hazard_type: HazardType,
    pub position: Geometry,
    #[serde(rename = "regionTile")]
    pub region_tile: String,
    #[serde(rename = "reportedAt")]
    pub reported_at: String,
    #[serde(rename = "reporterId")]
    pub reporter_id: String,
    #[serde(rename = "speedKmh")]
    pub speed_kmh: Option<f64>,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
    pub status: String,
    pub source: String,
    #[serde(rename = "sourceLicense")]
    pub source_license: Option<String>,
    #[serde(rename = "confirmCount")]
    pub confirm_count: u32,
    #[serde(rename = "denyCount")]
    pub deny_count: u32,
}

/// `GET /v1/snapshot` response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotResult {
    #[serde(rename = "snapshotSequence")]
    pub snapshot_sequence: u64,
    #[serde(rename = "speedLimitSegments")]
    pub speed_limit_segments: Vec<SpeedLimitSegment>,
    #[serde(rename = "staticSigns")]
    pub static_signs: Vec<StaticSign>,
    #[serde(rename = "hazardReports")]
    pub hazard_reports: Vec<HazardReport>,
    #[serde(rename = "fixedSpeedCameras")]
    pub fixed_speed_cameras: Vec<FixedSpeedCamera>,
}

/// One `event_log` row as `GET /v1/delta` (and the WebSocket push) return it
/// — `payload` stays `serde_json::Value` since its shape depends on
/// `entityType` (a full `HazardReportApi`, `FixedSpeedCameraApi`, ...), and
/// the sync engine dispatches on `entity_type`/`event_type` before decoding it
/// further, exactly like the server treats it as `jsonb` rather than a typed
/// column (`server/docs/schema.md`'s `event_log` section).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventLogEntry {
    pub sequence: u64,
    #[serde(rename = "occurredAt")]
    pub occurred_at: String,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(rename = "entityType")]
    pub entity_type: String,
    #[serde(rename = "entityId")]
    pub entity_id: String,
    pub payload: serde_json::Value,
    #[serde(rename = "regionTile")]
    pub region_tile: Option<String>,
    pub source: String,
}

/// `GET /v1/delta` response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeltaPage {
    pub events: Vec<EventLogEntry>,
    #[serde(rename = "nextSince")]
    pub next_since: Option<u64>,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartitionSummary {
    pub tile: String,
    pub hash: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

/// `GET /v1/static-data/manifest` response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaticDataManifest {
    #[serde(rename = "staticDataVersion")]
    pub static_data_version: u64,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    pub partitions: Vec<PartitionSummary>,
}

/// `GET /v1/static-data/partitions/:tile` response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartitionContent {
    pub tile: String,
    #[serde(rename = "speedLimitSegments")]
    pub speed_limit_segments: Vec<SpeedLimitSegment>,
    #[serde(rename = "staticSigns")]
    pub static_signs: Vec<StaticSign>,
    #[serde(rename = "fixedSpeedCameras")]
    pub fixed_speed_cameras: Vec<FixedSpeedCamera>,
}

/// The network-wide config a root-key holder signs offline
/// (`server/src/modules/network/config.ts`'s `NetworkConfigPayload`) — the
/// payload of `ClientConfig.network_config`, once independently re-verified
/// against the network root key (never taken on the server's word alone,
/// see [`effective_camera_namespace_enabled`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NetworkConfigPayload {
    pub version: u64,
    #[serde(rename = "blitzerEnabled")]
    pub blitzer_enabled: bool,
    #[serde(rename = "eventLogRetentionDaysDynamic")]
    pub event_log_retention_days_dynamic: u32,
    #[serde(rename = "eventLogRetentionDaysStatic")]
    pub event_log_retention_days_static: u32,
    #[serde(rename = "minVersion")]
    pub min_version: String,
    #[serde(rename = "excludedNodeIds")]
    pub excluded_node_ids: Vec<String>,
    #[serde(rename = "directoryKeyId")]
    pub directory_key_id: Option<String>,
    #[serde(rename = "importKeyId")]
    pub import_key_id: Option<String>,
    #[serde(rename = "issuedAt")]
    pub issued_at: String,
}

/// `GET /v1/config` response — the curated subset of server tunables a
/// client-lib instance mirrors locally, per `server/docs/api.md`'s "Client
/// config" section, so local expiry calculation ([`crate::sync::expiry`])
/// and camera-namespace filtering never drift from the server's own rules.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientConfig {
    #[serde(rename = "regionTileH3Resolution")]
    pub region_tile_h3_resolution: u8,
    #[serde(rename = "staticDataPartitionH3Resolution")]
    pub static_data_partition_h3_resolution: u8,
    #[serde(rename = "speedCameraNamespaceEnabled")]
    pub speed_camera_namespace_enabled: bool,
    #[serde(rename = "cameraNamespaceHazardTypes")]
    pub camera_namespace_hazard_types: Vec<HazardType>,
    #[serde(rename = "duplicateMergeRadiusMeters")]
    pub duplicate_merge_radius_meters: f64,
    #[serde(rename = "speedLimitLookupMaxDistanceMeters")]
    pub speed_limit_lookup_max_distance_meters: f64,
    /// Keyed by every `HazardType` except `FixedSpeedCamera` (the server
    /// computes it only for `REPORTABLE_HAZARD_TYPES`) — see
    /// [`crate::sync::expiry`] for how the sync engine uses this instead of
    /// duplicating the server's short/medium/construction band constants.
    #[serde(rename = "hazardExpiryMsByType")]
    pub hazard_expiry_ms_by_type: HashMap<HazardType, i64>,
    #[serde(rename = "reportRateLimitMax")]
    pub report_rate_limit_max: u32,
    #[serde(rename = "reportRateLimitWindowMinutes")]
    pub report_rate_limit_window_minutes: u32,
    #[serde(rename = "cameraRemovalThreshold")]
    pub camera_removal_threshold: u32,
    #[serde(rename = "staticDataVersion")]
    pub static_data_version: u64,
    #[serde(rename = "federationEnabled")]
    pub federation_enabled: bool,
    #[serde(rename = "networkConfig")]
    pub network_config: Option<SignedEnvelope<NetworkConfigPayload>>,
}

/// The camera namespace is AND-gated, never OR-gated (`server/docs/api.md`
/// "Signed network configuration": "Das Netzwerk kann nur einschränken, nie
/// gewähren") — mirrored client-side so a client never trusts a local flag
/// the network config has turned off, nor a network config claiming "on"
/// against a server that has it off locally. `verified_network_config` must
/// already have passed [`crate::crypto::verify_signed_envelope`] against a
/// trusted network root key — this function does not verify anything itself.
pub fn effective_camera_namespace_enabled(
    config: &ClientConfig,
    verified_network_config: Option<&NetworkConfigPayload>,
) -> bool {
    match verified_network_config {
        Some(network) => config.speed_camera_namespace_enabled && network.blitzer_enabled,
        None => config.speed_camera_namespace_enabled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_a_snapshot_shaped_like_the_server_docs() {
        let json = serde_json::json!({
            "snapshotSequence": 42,
            "speedLimitSegments": [
                {
                    "id": "seg1",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[13.0, 52.0], [13.1, 52.1]]
                    },
                    "speedLimit": 50,
                    "speedLimitUnit": "kmh",
                    "source": "osm",
                    "sourceLicense": "ODbL",
                    "importedAt": "2026-01-01T00:00:00Z",
                    "lastConfirmedAt": null
                }
            ],
            "staticSigns": [],
            "hazardReports": [
                {
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
                }
            ],
            "fixedSpeedCameras": []
        });
        let snapshot: SnapshotResult = serde_json::from_value(json).unwrap();
        assert_eq!(snapshot.snapshot_sequence, 42);
        assert_eq!(snapshot.speed_limit_segments.len(), 1);
        assert_eq!(snapshot.hazard_reports[0].hazard_type, HazardType::Ice);
        assert_eq!(
            snapshot.hazard_reports[0].position.as_lat_lng(),
            Some((52.5, 13.4))
        );
    }

    #[test]
    fn deserializes_a_delta_page() {
        let json = serde_json::json!({
            "events": [
                {
                    "sequence": 1,
                    "occurredAt": "2026-01-01T00:00:00Z",
                    "type": "ReportCreated",
                    "entityType": "hazardReport",
                    "entityId": "hr1",
                    "payload": {},
                    "regionTile": "tile1",
                    "source": "community"
                }
            ],
            "nextSince": 2,
            "hasMore": false
        });
        let page: DeltaPage = serde_json::from_value(json).unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.next_since, Some(2));
        assert!(!page.has_more);
    }

    #[test]
    fn hazard_type_is_usable_as_a_map_key_keyed_by_its_camel_case_json_name() {
        let json = serde_json::json!({
            "traffic": 900_000,
            "mobileSpeedCamera": 300_000,
            "construction": 2_592_000_000i64
        });
        let map: HashMap<HazardType, i64> = serde_json::from_value(json).unwrap();
        assert_eq!(map.get(&HazardType::Traffic), Some(&900_000));
        assert_eq!(map.get(&HazardType::MobileSpeedCamera), Some(&300_000));
        assert_eq!(map.get(&HazardType::Construction), Some(&2_592_000_000));
    }

    #[test]
    fn camera_namespace_is_and_gated_never_or_gated() {
        let mut config = base_config();
        config.speed_camera_namespace_enabled = true;
        let network_off = NetworkConfigPayload {
            blitzer_enabled: false,
            ..base_network_config()
        };
        assert!(!effective_camera_namespace_enabled(
            &config,
            Some(&network_off)
        ));

        config.speed_camera_namespace_enabled = false;
        let network_on = NetworkConfigPayload {
            blitzer_enabled: true,
            ..base_network_config()
        };
        assert!(!effective_camera_namespace_enabled(
            &config,
            Some(&network_on)
        ));

        config.speed_camera_namespace_enabled = true;
        assert!(effective_camera_namespace_enabled(&config, None));
    }

    fn base_config() -> ClientConfig {
        ClientConfig {
            region_tile_h3_resolution: 7,
            static_data_partition_h3_resolution: 2,
            speed_camera_namespace_enabled: false,
            camera_namespace_hazard_types: vec![],
            duplicate_merge_radius_meters: 50.0,
            speed_limit_lookup_max_distance_meters: 30.0,
            hazard_expiry_ms_by_type: HashMap::new(),
            report_rate_limit_max: 10,
            report_rate_limit_window_minutes: 10,
            camera_removal_threshold: 3,
            static_data_version: 1,
            federation_enabled: false,
            network_config: None,
        }
    }

    fn base_network_config() -> NetworkConfigPayload {
        NetworkConfigPayload {
            version: 1,
            blitzer_enabled: false,
            event_log_retention_days_dynamic: 3,
            event_log_retention_days_static: 30,
            min_version: "0.1.0".to_string(),
            excluded_node_ids: vec![],
            directory_key_id: None,
            import_key_id: None,
            issued_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }
}
