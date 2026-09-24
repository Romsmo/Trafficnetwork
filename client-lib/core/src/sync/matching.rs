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

use crate::storage::{LocalCorrectionProposal, Store, StoreError};

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

/// Where a speed limit comes from — what a host app shows next to the
/// number, so a community value is never mistaken for the import's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeedLimitOrigin {
    /// From the import source.
    Imported,
    /// This device's own proposal, not (yet) confirmed by anyone else.
    /// `confirmations` is the server's count once it accepted the proposal
    /// (it includes this device), `0` while the proposal is still queued.
    LocallyProposed { confirmations: u32 },
    /// A community correction the server has applied: enough distinct
    /// devices agreed. `needs_review` means the import changed to yet
    /// another value after it was proposed.
    CommunityCorrected {
        confirmations: u32,
        needs_review: bool,
    },
}

/// `speed_limit` is the value in effect; the fields after `distance_meters`
/// are additive — where it comes from, and the import's own value (which is
/// never lost, so a reverted correction falls back to it).
#[derive(Debug, Clone, PartialEq)]
pub struct NearestSpeedLimit {
    pub segment_id: String,
    pub speed_limit: f64,
    pub speed_limit_unit: String,
    pub distance_meters: f64,
    pub origin: SpeedLimitOrigin,
    pub imported_speed_limit: Option<f64>,
    /// Cross-server identity of the segment; what a correction names.
    pub segment_key: Option<String>,
}

/// The value in effect for a segment, where it comes from, and the imported
/// value. Precedence: a community-confirmed correction (it came from several
/// devices) beats this device's own proposal, which beats the import.
fn effective_limit(
    segment: &SpeedLimitSegment,
    proposals: &[LocalCorrectionProposal],
) -> (f64, SpeedLimitOrigin, Option<f64>) {
    if segment.corrected_by.as_deref() == Some("community") {
        let (confirmations, needs_review) = segment
            .correction
            .as_ref()
            .map(|c| (c.confirmations, c.needs_review))
            .unwrap_or((0, false));
        let origin = SpeedLimitOrigin::CommunityCorrected {
            confirmations,
            needs_review,
        };
        return (segment.speed_limit, origin, segment.imported_speed_limit);
    }
    let own_proposal = segment.segment_key.as_ref().and_then(|key| {
        proposals
            .iter()
            .find(|p| &p.segment_key == key && p.unit.as_str() == segment.speed_limit_unit)
    });
    match own_proposal {
        Some(proposal) => {
            let origin = SpeedLimitOrigin::LocallyProposed {
                confirmations: proposal.confirmations,
            };
            (f64::from(proposal.value), origin, Some(segment.speed_limit))
        }
        None => (
            segment.speed_limit,
            SpeedLimitOrigin::Imported,
            Some(segment.speed_limit),
        ),
    }
}

/// Mirrors `findNearestSpeedLimit`'s contract server-side
/// (`server/src/db/queries/speed-limit-segments.ts`): nearest segment
/// within `max_distance_meters`, or `None` if nothing is close enough.
/// Ignores this device's own correction proposals — see
/// [`nearest_speed_limit_with_proposals`] / [`speed_limit_at`].
pub fn nearest_speed_limit(
    lat: f64,
    lng: f64,
    segments: &[SpeedLimitSegment],
    max_distance_meters: f64,
) -> Option<NearestSpeedLimit> {
    nearest_speed_limit_with_proposals(lat, lng, segments, &[], max_distance_meters)
}

/// [`nearest_speed_limit`], with this device's own not-yet-confirmed
/// correction proposals applied as an overlay (they never change the
/// segments themselves).
pub fn nearest_speed_limit_with_proposals(
    lat: f64,
    lng: f64,
    segments: &[SpeedLimitSegment],
    proposals: &[LocalCorrectionProposal],
    max_distance_meters: f64,
) -> Option<NearestSpeedLimit> {
    let mut best: Option<(&SpeedLimitSegment, f64)> = None;
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
        let is_closer = best.map(|(_, d)| distance < d).unwrap_or(true);
        if is_closer {
            best = Some((segment, distance));
        }
    }
    let (segment, distance) = best?;
    let (speed_limit, origin, imported_speed_limit) = effective_limit(segment, proposals);
    Some(NearestSpeedLimit {
        segment_id: segment.id.clone(),
        speed_limit,
        speed_limit_unit: segment.speed_limit_unit.clone(),
        distance_meters: distance,
        origin,
        imported_speed_limit,
        segment_key: segment.segment_key.clone(),
    })
}

/// The speed limit at a position, straight from the local store — the
/// synced segments plus this device's own correction proposals. Never
/// touches the network, and asks the store only for the segments near the
/// position ([`Store::speed_limit_segments_near`]), so with a spatial index
/// the cost does not grow with the size of the dataset.
pub fn speed_limit_at(
    store: &dyn Store,
    lat: f64,
    lng: f64,
    max_distance_meters: f64,
) -> Result<Option<NearestSpeedLimit>, StoreError> {
    let nearby = store.speed_limit_segments_near(lat, lng, max_distance_meters)?;
    let proposals = store.local_proposals()?;
    Ok(nearest_speed_limit_with_proposals(
        lat,
        lng,
        &nearby,
        &proposals,
        max_distance_meters,
    ))
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
    use crate::storage::ProposalState;
    use crate::sync::types::{HazardType, SegmentCorrection, SpeedLimitUnit};

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
            segment_key: None,
            corrected_by: None,
            imported_speed_limit: None,
            correction: None,
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

    fn keyed_segment(id: &str, key: &str, speed_limit: f64) -> SpeedLimitSegment {
        let mut segment = straight_segment(id, speed_limit);
        segment.segment_key = Some(key.to_string());
        segment
    }

    fn corrected(mut segment: SpeedLimitSegment, imported: f64) -> SpeedLimitSegment {
        segment.corrected_by = Some("community".to_string());
        segment.imported_speed_limit = Some(imported);
        segment.correction = Some(SegmentCorrection {
            id: "c1".to_string(),
            confirmations: 3,
            denials: 1,
            applied_at: None,
            needs_review: true,
        });
        segment
    }

    fn own_proposal(key: &str, value: u32, confirmations: u32) -> LocalCorrectionProposal {
        LocalCorrectionProposal {
            segment_key: key.to_string(),
            segment_id: "seg".to_string(),
            value,
            unit: SpeedLimitUnit::Kmh,
            reason: None,
            state: ProposalState::Sent,
            correction_id: Some("c1".to_string()),
            confirmations,
            proposed_at_unix_ms: 0,
        }
    }

    #[test]
    fn an_untouched_segment_is_imported() {
        let segments = vec![straight_segment("s1", 50.0)];

        let result = nearest_speed_limit(52.0, 13.005, &segments, 100.0).unwrap();

        assert_eq!(result.origin, SpeedLimitOrigin::Imported);
        assert_eq!(result.imported_speed_limit, Some(50.0));
    }

    #[test]
    fn a_community_correction_reports_its_origin_counts_and_the_imported_value() {
        let segments = vec![corrected(keyed_segment("s1", "keyA", 30.0), 50.0)];

        let result = nearest_speed_limit(52.0, 13.005, &segments, 100.0).unwrap();

        assert_eq!(result.speed_limit, 30.0);
        assert_eq!(
            result.origin,
            SpeedLimitOrigin::CommunityCorrected {
                confirmations: 3,
                needs_review: true
            }
        );
        assert_eq!(result.imported_speed_limit, Some(50.0));
        assert_eq!(result.segment_key.as_deref(), Some("keyA"));
    }

    #[test]
    fn an_own_unconfirmed_proposal_applies_locally_and_keeps_the_import_visible() {
        let segments = vec![keyed_segment("s1", "keyA", 50.0)];
        let proposals = vec![own_proposal("keyA", 30, 1)];

        let result =
            nearest_speed_limit_with_proposals(52.0, 13.005, &segments, &proposals, 100.0).unwrap();

        assert_eq!(result.speed_limit, 30.0);
        assert_eq!(
            result.origin,
            SpeedLimitOrigin::LocallyProposed { confirmations: 1 }
        );
        assert_eq!(result.imported_speed_limit, Some(50.0));
        assert_eq!(segments[0].speed_limit, 50.0);
    }

    #[test]
    fn a_community_correction_outranks_an_own_proposal_for_another_value() {
        let segments = vec![corrected(keyed_segment("s1", "keyA", 30.0), 50.0)];
        let proposals = vec![own_proposal("keyA", 70, 1)];

        let result =
            nearest_speed_limit_with_proposals(52.0, 13.005, &segments, &proposals, 100.0).unwrap();

        assert_eq!(result.speed_limit, 30.0);
        assert!(matches!(
            result.origin,
            SpeedLimitOrigin::CommunityCorrected { .. }
        ));
    }

    #[test]
    fn a_proposal_for_another_segment_or_unit_is_ignored() {
        let segments = vec![keyed_segment("s1", "keyA", 50.0)];
        let mut mph = own_proposal("keyA", 30, 0);
        mph.unit = SpeedLimitUnit::Mph;
        let proposals = vec![own_proposal("keyB", 30, 0), mph];

        let result =
            nearest_speed_limit_with_proposals(52.0, 13.005, &segments, &proposals, 100.0).unwrap();

        assert_eq!(result.speed_limit, 50.0);
        assert_eq!(result.origin, SpeedLimitOrigin::Imported);
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
