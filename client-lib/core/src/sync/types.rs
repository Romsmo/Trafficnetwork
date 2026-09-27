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
    /// A type this build does not know — a newer server may add hazard types
    /// (the list is append-only). Decoding it as this instead of failing
    /// keeps a sync working when the server is ahead of the library: one new
    /// value in a snapshot or in `GET /v1/config` must not make the whole
    /// response unreadable. Never sent to a server.
    #[serde(other)]
    Unknown,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeedLimitUnit {
    Kmh,
    Mph,
}

impl SpeedLimitUnit {
    pub fn as_str(self) -> &'static str {
        match self {
            SpeedLimitUnit::Kmh => "kmh",
            SpeedLimitUnit::Mph => "mph",
        }
    }
}

/// Why a correction is proposed (`CORRECTION_REASONS` in
/// `server/src/config/constants.ts`) — optional on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CorrectionReason {
    WrongValue,
    LimitLifted,
    SignMissingOrNew,
    Other,
}

/// Set on a segment whose `speedLimit` is a community correction
/// (`server/docs/api.md`, "Speed-limit corrections"). Counts inside a static
/// package are "as of the last change of the effective value" — the live
/// numbers come from `GET /v1/speed-limit-corrections`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SegmentCorrection {
    pub id: String,
    pub confirmations: u32,
    pub denials: u32,
    #[serde(rename = "appliedAt")]
    pub applied_at: Option<String>,
    #[serde(rename = "needsReview")]
    pub needs_review: bool,
}

/// `speed_limit` is always the *effective* value — the server already folds a
/// community correction in — so a client that ignores the four additive
/// fields below still shows corrected limits. They are all absent on a server
/// that predates corrections.
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
    /// Content-derived identity, stable across servers (`server/docs/
    /// speed-limit-corrections.md` D1) — what a device-signed vote
    /// references, since `id` is a random per-server row id.
    #[serde(rename = "segmentKey")]
    pub segment_key: Option<String>,
    /// `Some("community")` when `speed_limit` is a correction.
    #[serde(rename = "correctedBy")]
    pub corrected_by: Option<String>,
    /// The value from the import source, only while it is being overridden.
    #[serde(rename = "importedSpeedLimit")]
    pub imported_speed_limit: Option<f64>,
    pub correction: Option<SegmentCorrection>,
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
    /// SHA-256 (hex) of the package's JSON exactly as delivered, before any
    /// transfer compression — checked against what arrives.
    pub hash: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    /// Where exactly this content lives (`/v1/static-data/packages/<tile>/<hash>`),
    /// on servers that offer it — a URL that can only ever answer with the
    /// content the hash names. Absent on older servers.
    #[serde(default)]
    pub path: Option<String>,
}

/// `GET /v1/static-data/manifest` response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaticDataManifest {
    #[serde(rename = "staticDataVersion")]
    pub static_data_version: u64,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
    /// The H3 resolution the tiles are cut at. Absent on a server that
    /// predates the Europe-scale packages (then the client cannot tell and
    /// does not check). Tile ids at different resolutions never match, so a
    /// change makes the stored packages useless — see
    /// [`crate::sync::SyncEngine::sync_static_data`].
    #[serde(rename = "partitionResolution", default)]
    pub partition_resolution: Option<u8>,
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
    /// Absent on a server that predates community corrections — read that as
    /// "not offered". Parsed leniently: an add-on section of an unexpected
    /// shape becomes `None` instead of failing the whole config fetch that
    /// every sync depends on.
    #[serde(rename = "communityCorrections")]
    #[serde(default, deserialize_with = "lenient_option")]
    pub community_corrections: Option<CommunityCorrectionsConfig>,
}

fn lenient_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValueRange {
    pub min: u32,
    pub max: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValueRanges {
    pub kmh: ValueRange,
    pub mph: ValueRange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CorrectionRateLimit {
    pub max: u32,
    #[serde(rename = "windowMinutes")]
    pub window_minutes: u32,
}

/// `communityCorrections` of `GET /v1/config` (`server/docs/api.md`, K-A
/// addition): the limits a client mirrors so it can reject implausible input
/// before sending it, and the switch that hides the whole feature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommunityCorrectionsConfig {
    pub enabled: bool,
    #[serde(rename = "confirmationsRequired")]
    pub confirmations_required: u32,
    #[serde(rename = "valueRange")]
    pub value_range: ValueRanges,
    #[serde(rename = "valueStep")]
    pub value_step: u32,
    #[serde(rename = "rateLimit")]
    pub rate_limit: CorrectionRateLimit,
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
    fn a_hazard_type_this_build_does_not_know_decodes_as_unknown() {
        // A newer server may append hazard types; one of them must not make a
        // whole snapshot or config response unreadable.
        let single: HazardType = serde_json::from_str("\"averageSpeedCheck\"").unwrap();
        assert_eq!(single, HazardType::Unknown);

        let list: Vec<HazardType> = serde_json::from_str("[\"ice\", \"somethingNew\"]").unwrap();
        assert_eq!(list, vec![HazardType::Ice, HazardType::Unknown]);

        let map: HashMap<HazardType, i64> =
            serde_json::from_str("{\"traffic\": 900000, \"somethingNew\": 1}").unwrap();
        assert_eq!(map.get(&HazardType::Traffic), Some(&900_000));
        assert_eq!(map.get(&HazardType::Unknown), Some(&1));
    }

    #[test]
    fn a_manifest_from_an_older_server_has_no_resolution_and_a_newer_one_has_more_fields() {
        let old: StaticDataManifest = serde_json::from_value(serde_json::json!({
            "staticDataVersion": 1,
            "generatedAt": "2026-01-01T00:00:00Z",
            "partitions": [{ "tile": "t", "hash": "h", "sizeBytes": 10 }]
        }))
        .unwrap();
        assert_eq!(old.partition_resolution, None);
        assert_eq!(old.partitions[0].path, None);

        let new: StaticDataManifest = serde_json::from_value(serde_json::json!({
            "staticDataVersion": 2,
            "partitionResolution": 4,
            "generatedAt": "2026-01-01T00:00:00Z",
            "partitions": [{
                "tile": "t", "hash": "h", "sizeBytes": 10,
                "gzipBytes": 3, "brotliBytes": 2, "path": "/v1/static-data/packages/t/h"
            }]
        }))
        .unwrap();
        assert_eq!(new.partition_resolution, Some(4));
        assert_eq!(
            new.partitions[0].path.as_deref(),
            Some("/v1/static-data/packages/t/h")
        );
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

    #[test]
    fn a_segment_parses_with_and_without_the_correction_fields() {
        let geometry = serde_json::json!({
            "type": "LineString",
            "coordinates": [[13.0, 52.0], [13.1, 52.1]]
        });
        let older_server = serde_json::json!({
            "id": "s1",
            "geometry": geometry,
            "speedLimit": 50,
            "speedLimitUnit": "kmh",
            "source": "osm",
            "sourceLicense": null,
            "importedAt": "2026-01-01T00:00:00Z",
            "lastConfirmedAt": null
        });
        let segment: SpeedLimitSegment = serde_json::from_value(older_server).unwrap();
        assert_eq!(segment.segment_key, None);
        assert_eq!(segment.corrected_by, None);
        assert_eq!(segment.correction, None);

        let corrected = serde_json::json!({
            "id": "s1",
            "geometry": geometry,
            "speedLimit": 30,
            "speedLimitUnit": "kmh",
            "source": "osm",
            "sourceLicense": null,
            "importedAt": "2026-01-01T00:00:00Z",
            "lastConfirmedAt": null,
            "segmentKey": "0123456789abcdef0123456789abcdef",
            "correctedBy": "community",
            "importedSpeedLimit": 50,
            "correction": {
                "id": "c1",
                "confirmations": 3,
                "denials": 1,
                "appliedAt": "2026-09-24T12:00:00.000Z",
                "needsReview": false
            }
        });
        let segment: SpeedLimitSegment = serde_json::from_value(corrected).unwrap();
        assert_eq!(segment.corrected_by.as_deref(), Some("community"));
        assert_eq!(segment.imported_speed_limit, Some(50.0));
        let correction = segment.correction.unwrap();
        assert_eq!(correction.confirmations, 3);
        assert_eq!(correction.denials, 1);
        assert!(!correction.needs_review);
    }

    #[test]
    fn community_corrections_config_is_optional_and_never_breaks_the_config_parse() {
        let mut json = serde_json::to_value(base_config()).unwrap();

        json.as_object_mut().unwrap().remove("communityCorrections");
        let absent: ClientConfig = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(absent.community_corrections, None);

        json["communityCorrections"] = serde_json::json!({
            "enabled": true,
            "confirmationsRequired": 3,
            "valueRange": { "kmh": { "min": 5, "max": 150 }, "mph": { "min": 5, "max": 85 } },
            "valueStep": 5,
            "rateLimit": { "max": 5, "windowMinutes": 60 }
        });
        let present: ClientConfig = serde_json::from_value(json.clone()).unwrap();
        let corrections = present.community_corrections.unwrap();
        assert!(corrections.enabled);
        assert_eq!(corrections.value_range.mph.max, 85);
        assert_eq!(corrections.value_step, 5);

        json["communityCorrections"] = serde_json::json!({ "enabled": false });
        let malformed: ClientConfig = serde_json::from_value(json).unwrap();
        assert_eq!(malformed.community_corrections, None);
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
            community_corrections: None,
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
