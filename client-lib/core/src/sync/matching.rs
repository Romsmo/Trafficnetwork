//! Local map-matching: nearest speed-limit segment and nearby hazard
//! reports, computed entirely against already-synced local data
//! (`storage::Store::all_entities`) — no network call, matching the
//! original P2 concept's "local-first" requirement (`docs/concept.md`).
//!
//! Distance is computed with a flat-earth projection centered on the query
//! point rather than full spherical point-to-segment geometry — accurate
//! enough at the scale this is used for (tens of meters,
//! `speed_limit_lookup_max_distance_meters`/`duplicate_merge_radius_meters`
//! from `GET /v1/config`), and there's no closed-form "closest point on a
//! great-circle segment" simple enough to be worth the complexity at this
//! scale (the server itself uses the equivalent PostGIS planar/geodesic
//! split for the same reason — see `server/docs/schema.md`'s geometry note).

use super::expiry::is_expired;
use super::types::{Geometry, HazardReport, SpeedLimitSegment};

const EARTH_RADIUS_M: f64 = 6_371_000.0;

pub fn haversine_distance_meters(lat1: f64, lng1: f64, lat2: f64, lng2: f64) -> f64 {
    let (lat1r, lat2r) = (lat1.to_radians(), lat2.to_radians());
    let dlat = (lat2 - lat1).to_radians();
    let dlng = (lng2 - lng1).to_radians();
    let a = (dlat / 2.0).sin().powi(2) + lat1r.cos() * lat2r.cos() * (dlng / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());
    EARTH_RADIUS_M * c
}

/// Projects a point to a local meter-scale plane centered on `(origin_lat,
/// origin_lng)`, so an exact point-to-segment projection can use ordinary
/// 2D geometry.
fn to_local_meters(lat: f64, lng: f64, origin_lat: f64, origin_lng: f64) -> (f64, f64) {
    let x = (lng - origin_lng).to_radians() * origin_lat.to_radians().cos() * EARTH_RADIUS_M;
    let y = (lat - origin_lat).to_radians() * EARTH_RADIUS_M;
    (x, y)
}

fn distance_to_segment_meters(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (abx, aby) = (bx - ax, by - ay);
    let len_sq = abx * abx + aby * aby;
    let t = if len_sq > 0.0 {
        (((px - ax) * abx + (py - ay) * aby) / len_sq).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (cx, cy) = (ax + t * abx, ay + t * aby);
    ((px - cx).powi(2) + (py - cy).powi(2)).sqrt()
}

/// `None` for a degenerate (fewer than 2 points) line — never for "too
/// far", which is the caller's job to decide against a max-distance cutoff.
pub fn distance_to_line_string_meters(lat: f64, lng: f64, line: &[[f64; 2]]) -> Option<f64> {
    if line.len() < 2 {
        return None;
    }
    let mut min_distance = f64::MAX;
    for pair in line.windows(2) {
        let (ax, ay) = to_local_meters(pair[0][1], pair[0][0], lat, lng);
        let (bx, by) = to_local_meters(pair[1][1], pair[1][0], lat, lng);
        let d = distance_to_segment_meters(0.0, 0.0, ax, ay, bx, by);
        if d < min_distance {
            min_distance = d;
        }
    }
    Some(min_distance)
}

#[derive(Debug, Clone, PartialEq)]
pub struct NearestSpeedLimit {
    pub segment_id: String,
    pub speed_limit: f64,
    pub speed_limit_unit: String,
    pub distance_meters: f64,
}

/// Mirrors `findNearestSpeedLimit`'s contract server-side
/// (`server/src/db/queries/speed-limit-segments.ts`): nearest segment
/// within `max_distance_meters`, or `None` if nothing is close enough.
pub fn nearest_speed_limit(
    lat: f64,
    lng: f64,
    segments: &[SpeedLimitSegment],
    max_distance_meters: f64,
) -> Option<NearestSpeedLimit> {
    let mut best: Option<NearestSpeedLimit> = None;
    for segment in segments {
        let coordinates = match &segment.geometry {
            Geometry::LineString { coordinates } => coordinates,
            Geometry::Point { .. } => continue,
        };
        let distance = match distance_to_line_string_meters(lat, lng, coordinates) {
            Some(d) => d,
            None => continue,
        };
        if distance > max_distance_meters {
            continue;
        }
        let is_closer = best
            .as_ref()
            .map(|b| distance < b.distance_meters)
            .unwrap_or(true);
        if is_closer {
            best = Some(NearestSpeedLimit {
                segment_id: segment.id.clone(),
                speed_limit: segment.speed_limit,
                speed_limit_unit: segment.speed_limit_unit.clone(),
                distance_meters: distance,
            });
        }
    }
    best
}

#[derive(Debug, Clone, PartialEq)]
pub struct NearbyHazardReport {
    pub report: HazardReport,
    pub distance_meters: f64,
}

/// Active, not-yet-expired ([`is_expired`]) reports within `radius_meters`,
/// nearest first.
pub fn nearby_hazard_reports(
    lat: f64,
    lng: f64,
    reports: &[HazardReport],
    radius_meters: f64,
    now_unix_ms: i64,
) -> Vec<NearbyHazardReport> {
    let mut results: Vec<NearbyHazardReport> = reports
        .iter()
        .filter(|r| r.status == "active" && !is_expired(r, now_unix_ms))
        .filter_map(|r| {
            let (report_lat, report_lng) = r.position.as_lat_lng()?;
            let distance = haversine_distance_meters(lat, lng, report_lat, report_lng);
            if distance <= radius_meters {
                Some(NearbyHazardReport {
                    report: r.clone(),
                    distance_meters: distance,
                })
            } else {
                None
            }
        })
        .collect();
    results.sort_by(|a, b| a.distance_meters.total_cmp(&b.distance_meters));
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::types::HazardType;

    #[test]
    fn haversine_distance_is_zero_for_the_same_point() {
        assert_eq!(haversine_distance_meters(52.5, 13.4, 52.5, 13.4), 0.0);
    }

    #[test]
    fn haversine_distance_is_roughly_symmetric() {
        let a_to_b = haversine_distance_meters(52.5, 13.4, 52.51, 13.41);
        let b_to_a = haversine_distance_meters(52.51, 13.41, 52.5, 13.4);
        assert!((a_to_b - b_to_a).abs() < 0.001);
        assert!(a_to_b > 0.0);
    }

    fn straight_segment(id: &str, speed_limit: f64) -> SpeedLimitSegment {
        SpeedLimitSegment {
            id: id.to_string(),
            geometry: Geometry::LineString {
                coordinates: vec![[13.0, 52.0], [13.01, 52.0]],
            },
            speed_limit,
            speed_limit_unit: "kmh".to_string(),
            source: "osm".to_string(),
            source_license: None,
            imported_at: "2026-01-01T00:00:00Z".to_string(),
            last_confirmed_at: None,
        }
    }

    #[test]
    fn finds_the_nearest_segment_within_range() {
        let near = straight_segment("near", 50.0);
        let mut far = straight_segment("far", 30.0);
        far.geometry = Geometry::LineString {
            coordinates: vec![[14.0, 53.0], [14.01, 53.0]],
        };
        let segments = vec![far, near];

        let result = nearest_speed_limit(52.0, 13.005, &segments, 100.0).unwrap();
        assert_eq!(result.segment_id, "near");
        assert_eq!(result.speed_limit, 50.0);
    }

    #[test]
    fn returns_none_when_nothing_is_within_max_distance() {
        let segment = straight_segment("seg1", 50.0);
        let result = nearest_speed_limit(53.0, 14.0, &[segment], 100.0);
        assert!(result.is_none());
    }

    fn sample_report(id: &str, status: &str, expires_at: &str) -> HazardReport {
        HazardReport {
            id: id.to_string(),
            hazard_type: HazardType::Ice,
            position: Geometry::Point {
                coordinates: [13.0, 52.0],
            },
            region_tile: "tile1".to_string(),
            reported_at: "2026-01-01T00:00:00Z".to_string(),
            reporter_id: "r1".to_string(),
            speed_kmh: None,
            expires_at: expires_at.to_string(),
            status: status.to_string(),
            source: "community".to_string(),
            source_license: None,
            confirm_count: 0,
            deny_count: 0,
        }
    }

    #[test]
    fn nearby_hazard_reports_excludes_expired_and_inactive_and_sorts_by_distance() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:10:00Z")
            .unwrap()
            .timestamp_millis();
        let near = sample_report("near", "active", "2026-01-01T00:20:00Z");
        let mut far = sample_report("far", "active", "2026-01-01T00:20:00Z");
        far.position = Geometry::Point {
            coordinates: [13.05, 52.05],
        };
        let expired = sample_report("expired", "active", "2026-01-01T00:05:00Z");
        let removed = sample_report("removed", "removed", "2026-01-01T00:20:00Z");

        let results =
            nearby_hazard_reports(52.0, 13.0, &[far, expired, removed, near], 10_000.0, now);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].report.id, "near");
        assert_eq!(results[1].report.id, "far");
        assert!(results[0].distance_meters < results[1].distance_meters);
    }
}
