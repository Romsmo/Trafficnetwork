//! Local expiry calculation, mirroring `server/src/config/constants.ts`'s
//! `hazardExpiryMs` — but reading the already-fetched
//! `ClientConfig.hazard_expiry_ms_by_type` (`GET /v1/config`) rather than
//! duplicating the server's short/medium/construction band constants, so
//! client and server can never drift (`server/docs/api.md`'s "Client
//! config" section: "so client and server never diverge").

use super::types::{ClientConfig, HazardReport, HazardType};

/// `None` only for `FixedSpeedCamera` — the one hazard type with no expiry
/// band at all (it lives in its own table with no automatic expiry, see
/// `server/docs/schema.md`); the server's config endpoint only computes
/// `hazardExpiryMsByType` for `REPORTABLE_HAZARD_TYPES`.
pub fn expiry_ms_for(hazard_type: HazardType, config: &ClientConfig) -> Option<i64> {
    config.hazard_expiry_ms_by_type.get(&hazard_type).copied()
}

/// The `expiresAt` a freshly created (or `stillThere`-confirmed) report
/// should carry — always `now + ttl`, never `reportedAt + ttl`, matching
/// the server's own confirmation semantics ("resets expiresAt to now + this
/// duration rather than adding a fixed increment", `server/docs/api.md`).
pub fn expires_at_unix_ms(
    hazard_type: HazardType,
    now_unix_ms: i64,
    config: &ClientConfig,
) -> Option<i64> {
    expiry_ms_for(hazard_type, config).map(|ttl| now_unix_ms + ttl)
}

/// A report is expired once `now` has passed its `expiresAt` — used for
/// local reads (`getSpeedLimitAt`/`getNearby`-style lookups) so a client
/// doesn't have to wait for a server-pushed `ReportExpired` delta event to
/// stop showing something that's already past its TTL.
pub fn is_expired(report: &HazardReport, now_unix_ms: i64) -> bool {
    match chrono::DateTime::parse_from_rfc3339(&report.expires_at) {
        Ok(dt) => dt.timestamp_millis() <= now_unix_ms,
        // An unparseable expiresAt is treated as already expired rather
        // than trusted indefinitely — the safer failure direction for
        // hazard data (a stale warning lingering is worse than one
        // disappearing a little early).
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::types::Geometry;
    use std::collections::HashMap;

    fn config_with(entries: &[(HazardType, i64)]) -> ClientConfig {
        ClientConfig {
            region_tile_h3_resolution: 7,
            static_data_partition_h3_resolution: 2,
            speed_camera_namespace_enabled: false,
            camera_namespace_hazard_types: vec![],
            duplicate_merge_radius_meters: 50.0,
            speed_limit_lookup_max_distance_meters: 30.0,
            hazard_expiry_ms_by_type: entries.iter().copied().collect::<HashMap<_, _>>(),
            report_rate_limit_max: 10,
            report_rate_limit_window_minutes: 10,
            camera_removal_threshold: 3,
            static_data_version: 1,
            federation_enabled: false,
            network_config: None,
        }
    }

    fn sample_report(expires_at: &str) -> HazardReport {
        HazardReport {
            id: "hr1".to_string(),
            hazard_type: HazardType::Ice,
            position: Geometry::Point {
                coordinates: [13.4, 52.5],
            },
            region_tile: "tile1".to_string(),
            reported_at: "2026-01-01T00:00:00Z".to_string(),
            reporter_id: "r1".to_string(),
            speed_kmh: None,
            expires_at: expires_at.to_string(),
            status: "active".to_string(),
            source: "community".to_string(),
            source_license: None,
            confirm_count: 0,
            deny_count: 0,
        }
    }

    #[test]
    fn fixed_speed_camera_has_no_expiry_band() {
        let config = config_with(&[(HazardType::Ice, 900_000)]);
        assert_eq!(expiry_ms_for(HazardType::FixedSpeedCamera, &config), None);
    }

    #[test]
    fn expires_at_is_now_plus_ttl_not_reported_at_plus_ttl() {
        let config = config_with(&[(HazardType::Ice, 900_000)]);
        let now = 10_000_000_i64;
        assert_eq!(
            expires_at_unix_ms(HazardType::Ice, now, &config),
            Some(now + 900_000)
        );
    }

    #[test]
    fn a_report_past_its_expires_at_is_expired() {
        let report = sample_report("2026-01-01T00:20:00Z");
        let past = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:19:00Z")
            .unwrap()
            .timestamp_millis();
        let future = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:21:00Z")
            .unwrap()
            .timestamp_millis();
        assert!(!is_expired(&report, past));
        assert!(is_expired(&report, future));
    }

    #[test]
    fn an_unparseable_expires_at_is_treated_as_expired() {
        let report = sample_report("not-a-timestamp");
        assert!(is_expired(&report, 0));
    }
}
