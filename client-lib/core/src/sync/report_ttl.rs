//! How long a report may be asked to live, from the server's own rules.
//!
//! A server from 1.1.0 on publishes, per hazard type, the default duration and the bounds of the duration a
//! reporter may ask for (`GET /v1/config` → `reportExpiry`, server/docs/report-expiry.md). The library mirrors
//! them so an out-of-range request fails *before* it is queued — with the numbers that apply — and so the host
//! app can offer exactly the choices that will be accepted. A server that predates the feature has no such key:
//! the duration is then not sent at all and the host app is told that the default applies.

use serde::{Deserialize, Serialize};

use super::types::{ClientConfig, HazardType};

/// Default and bounds of one hazard type, in seconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpiryRule {
    #[serde(rename = "defaultSeconds")]
    pub default_seconds: u32,
    #[serde(rename = "minSeconds")]
    pub min_seconds: u32,
    #[serde(rename = "maxSeconds")]
    pub max_seconds: u32,
}

/// What a host app needs to build its duration choice for one hazard type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ReportLimits {
    /// `false`: the server does not take a requested duration (an older server, or a type that never expires). A
    /// duration passed to `submit_report` is then ignored, and `default_seconds` is what applies.
    pub supported: bool,
    #[serde(rename = "defaultSeconds")]
    pub default_seconds: Option<u32>,
    #[serde(rename = "minSeconds")]
    pub min_seconds: Option<u32>,
    #[serde(rename = "maxSeconds")]
    pub max_seconds: Option<u32>,
}

/// The limits for a type from the cached configuration. Without `reportExpiry` the default is still known (from
/// `hazardExpiryMsByType`), the bounds are not, and `supported` is false.
pub fn limits_for(hazard_type: HazardType, config: Option<&ClientConfig>) -> ReportLimits {
    let Some(config) = config else {
        return ReportLimits {
            supported: false,
            default_seconds: None,
            min_seconds: None,
            max_seconds: None,
        };
    };
    if let Some(rule) = config.report_expiry.get(&hazard_type) {
        return ReportLimits {
            supported: true,
            default_seconds: Some(rule.default_seconds),
            min_seconds: Some(rule.min_seconds),
            max_seconds: Some(rule.max_seconds),
        };
    }
    let default_seconds = config
        .hazard_expiry_ms_by_type
        .get(&hazard_type)
        .and_then(|ms| u32::try_from(ms / 1000).ok());
    ReportLimits {
        supported: false,
        default_seconds,
        min_seconds: None,
        max_seconds: None,
    }
}

/// Why a requested duration cannot be queued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TtlOutOfRange {
    pub requested_seconds: u32,
    pub default_seconds: u32,
    pub min_seconds: u32,
    pub max_seconds: u32,
}

/// What a requested duration comes to for this server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtlDecision {
    /// Nothing requested: the server's default applies.
    Default,
    /// Requested and inside the bounds: it goes into the request (and the signature).
    Requested(u32),
    /// Requested, but this server does not take one: left out, the default applies. The host app is told.
    NotSupported,
}

/// Checks a requested duration against the cached rules. `Err` carries the numbers that apply.
pub fn check_ttl(
    hazard_type: HazardType,
    requested: Option<u32>,
    config: Option<&ClientConfig>,
) -> Result<TtlDecision, TtlOutOfRange> {
    let Some(requested) = requested else {
        return Ok(TtlDecision::Default);
    };
    let Some(rule) = config.and_then(|c| c.report_expiry.get(&hazard_type)) else {
        return Ok(TtlDecision::NotSupported);
    };
    if requested < rule.min_seconds || requested > rule.max_seconds {
        return Err(TtlOutOfRange {
            requested_seconds: requested,
            default_seconds: rule.default_seconds,
            min_seconds: rule.min_seconds,
            max_seconds: rule.max_seconds,
        });
    }
    Ok(TtlDecision::Requested(requested))
}

/// A queued report is signed when it is *sent*, and the server counts its duration from that signature. What is
/// left of the duration the reporter asked for is therefore what is sent, so a report made offline does not
/// live longer than it was meant to. `None` when nothing is left (it has ended while waiting): not worth sending.
pub fn remaining_seconds(requested: u32, created_at_unix_ms: i64, now_unix_ms: i64) -> Option<u32> {
    let elapsed = (now_unix_ms.saturating_sub(created_at_unix_ms)).max(0) / 1000;
    let remaining = i64::from(requested) - elapsed;
    // Less than a minute is not a report worth a round trip.
    (remaining >= 60).then(|| u32::try_from(remaining).unwrap_or(requested))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(
        rules: &[(HazardType, ExpiryRule)],
        defaults_ms: &[(HazardType, i64)],
    ) -> ClientConfig {
        let mut config = crate::sync::types::ClientConfig::for_tests();
        config.report_expiry = rules.iter().copied().collect::<HashMap<_, _>>();
        config.hazard_expiry_ms_by_type = defaults_ms.iter().copied().collect::<HashMap<_, _>>();
        config
    }

    const MOBILE: ExpiryRule = ExpiryRule {
        default_seconds: 10_800,
        min_seconds: 600,
        max_seconds: 43_200,
    };

    #[test]
    fn limits_come_from_the_servers_rules() {
        let cfg = config(&[(HazardType::MobileSpeedCamera, MOBILE)], &[]);
        let limits = limits_for(HazardType::MobileSpeedCamera, Some(&cfg));
        assert!(limits.supported);
        assert_eq!(limits.default_seconds, Some(10_800));
        assert_eq!(limits.min_seconds, Some(600));
        assert_eq!(limits.max_seconds, Some(43_200));
    }

    #[test]
    fn an_older_server_has_a_default_but_no_bounds_and_says_it_is_not_supported() {
        let cfg = config(&[], &[(HazardType::Traffic, 1_500_000)]);
        let limits = limits_for(HazardType::Traffic, Some(&cfg));
        assert!(!limits.supported);
        assert_eq!(limits.default_seconds, Some(1_500));
        assert_eq!(limits.min_seconds, None);
    }

    #[test]
    fn without_a_fetched_config_nothing_is_known() {
        let limits = limits_for(HazardType::Traffic, None);
        assert!(!limits.supported);
        assert_eq!(limits.default_seconds, None);
    }

    #[test]
    fn a_duration_inside_the_bounds_is_requested_and_the_bounds_themselves_are_fine() {
        let cfg = config(&[(HazardType::MobileSpeedCamera, MOBILE)], &[]);
        for seconds in [600, 7_200, 43_200] {
            assert_eq!(
                check_ttl(HazardType::MobileSpeedCamera, Some(seconds), Some(&cfg)),
                Ok(TtlDecision::Requested(seconds))
            );
        }
    }

    #[test]
    fn outside_the_bounds_fails_with_the_numbers_that_apply() {
        let cfg = config(&[(HazardType::MobileSpeedCamera, MOBILE)], &[]);
        for seconds in [0, 599, 43_201] {
            let err =
                check_ttl(HazardType::MobileSpeedCamera, Some(seconds), Some(&cfg)).unwrap_err();
            assert_eq!(err.requested_seconds, seconds);
            assert_eq!(
                (err.min_seconds, err.max_seconds, err.default_seconds),
                (600, 43_200, 10_800)
            );
        }
    }

    #[test]
    fn nothing_requested_is_the_default_and_an_unsupporting_server_leaves_the_field_out() {
        let cfg = config(&[(HazardType::MobileSpeedCamera, MOBILE)], &[]);
        assert_eq!(
            check_ttl(HazardType::MobileSpeedCamera, None, Some(&cfg)),
            Ok(TtlDecision::Default)
        );
        let older = config(&[], &[]);
        assert_eq!(
            check_ttl(HazardType::Traffic, Some(900), Some(&older)),
            Ok(TtlDecision::NotSupported)
        );
        assert_eq!(
            check_ttl(HazardType::Traffic, Some(900), None),
            Ok(TtlDecision::NotSupported)
        );
    }

    #[test]
    fn what_is_sent_is_what_is_left_of_the_request() {
        let created = 1_000_000;
        // 2 h asked for, 30 minutes spent waiting for a connection
        assert_eq!(
            remaining_seconds(7_200, created, created + 1_800_000),
            Some(5_400)
        );
        // made just now
        assert_eq!(remaining_seconds(7_200, created, created), Some(7_200));
        // the clock went backwards: never more than was asked for
        assert_eq!(
            remaining_seconds(7_200, created, created - 10_000),
            Some(7_200)
        );
        // ended while waiting
        assert_eq!(remaining_seconds(600, created, created + 600_000), None);
        assert_eq!(remaining_seconds(600, created, created + 541_000), None);
    }
}
