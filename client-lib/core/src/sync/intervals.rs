//! A speed limit for a stretch of road, named by two points on it (server 1.1.0,
//! `server/docs/road-network.md`).
//!
//! The visitor picks the two ends of the stretch on the map; the device never needs a road, a direction or a segment. Everything
//! a device can compute without road data is here:
//!
//! * the reference `ivl:<lat>,<lng>:<lat>,<lng>` — the two points as integer 1e-5 degrees (about 1.1 m), the smaller pair first
//!   (a stretch has no direction). The signed vote names this reference; every server resolves it against its own roads and
//!   derives the same stretch of road from it. The same function as the server's `roads/geo.ts`, checked against vectors.
//! * which of the device's own proposals answers for a position (the straight line between the two points, with a tolerance —
//!   the road's own shape is the server's to find).
//!
//! The road itself (which way it runs between the points, its name, its shape) is found by the server:
//! `POST /v1/roads/resolve` (see `sync::roads`) tells it for a preview before anything is proposed.

use crate::storage::{LocalCorrectionProposal, Store, StoreError};

use super::matching::{distance_to_line_string_meters, haversine_distance_meters};

/// Two picked points closer than this name no stretch (the server refuses them as `INTERVAL_TOO_SHORT`).
pub const MIN_INTERVAL_METERS: f64 = 10.0;
/// A device's own proposal answers for positions this close to the straight line between its two points.
pub const OWN_PROPOSAL_RADIUS_METERS: f64 = 30.0;

/// A picked point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IntervalPoint {
    pub lat: f64,
    pub lng: f64,
}

impl IntervalPoint {
    pub fn is_valid(&self) -> bool {
        self.lat.is_finite()
            && self.lng.is_finite()
            && self.lat.abs() <= 90.0
            && self.lng.abs() <= 180.0
            && !(self.lat == 0.0 && self.lng == 0.0)
    }
}

/// `Math.round(degrees * 1e5)` as the server computes it (JavaScript rounds halves up, which is not `f64::round`).
fn quantise5(degrees: f64) -> i64 {
    (degrees * 1e5 + 0.5).floor() as i64
}

/// The reference a stretch is named by, or `None` when a point is not a position.
pub fn interval_ref(a: IntervalPoint, b: IntervalPoint) -> Option<String> {
    if !a.is_valid() || !b.is_valid() {
        return None;
    }
    let pa = (quantise5(a.lat), quantise5(a.lng));
    let pb = (quantise5(b.lat), quantise5(b.lng));
    let (first, second) = if pa.0 < pb.0 || (pa.0 == pb.0 && pa.1 <= pb.1) {
        (pa, pb)
    } else {
        (pb, pa)
    };
    Some(format!(
        "ivl:{},{}:{},{}",
        first.0, first.1, second.0, second.1
    ))
}

fn parse_number(text: &str, max_digits: usize) -> Option<i64> {
    let digits = text.strip_prefix('-').unwrap_or(text);
    if digits.is_empty() || digits.len() > max_digits || !digits.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    text.parse().ok()
}

/// The two end points a reference names, or `None` when it is not a well-formed `ivl:` reference.
pub fn parse_ref(reference: &str) -> Option<(IntervalPoint, IntervalPoint)> {
    let rest = reference.strip_prefix("ivl:")?;
    let (first, second) = rest.split_once(':')?;
    let point = |pair: &str| -> Option<IntervalPoint> {
        let (lat, lng) = pair.split_once(',')?;
        let lat = parse_number(lat, 8)?;
        let lng = parse_number(lng, 9)?;
        if lat.abs() > 9_000_000 || lng.abs() > 18_000_000 {
            return None;
        }
        Some(IntervalPoint {
            lat: lat as f64 / 1e5,
            lng: lng as f64 / 1e5,
        })
    };
    Some((point(first)?, point(second)?))
}

/// The straight-line distance between two points, in metres.
pub fn straight_meters(a: IntervalPoint, b: IntervalPoint) -> f64 {
    haversine_distance_meters(a.lat, a.lng, b.lat, b.lng)
}

/// This device's own proposal for a stretch of road that runs by a position: the proposal whose two points lie around it
/// (within [`OWN_PROPOSAL_RADIUS_METERS`] of the line between them), the nearest if there are several.
pub fn own_interval_proposal(
    store: &dyn Store,
    lat: f64,
    lng: f64,
) -> Result<Option<LocalCorrectionProposal>, StoreError> {
    let mut best: Option<(f64, LocalCorrectionProposal)> = None;
    for proposal in store.local_proposals()? {
        let Some((a, b)) = parse_ref(&proposal.segment_key) else {
            continue;
        };
        let line = [[a.lng, a.lat], [b.lng, b.lat]];
        let Some(distance) = distance_to_line_string_meters(lat, lng, &line) else {
            continue;
        };
        if distance <= OWN_PROPOSAL_RADIUS_METERS
            && best.as_ref().is_none_or(|(d, _)| distance < *d)
        {
            best = Some((distance, proposal));
        }
    }
    Ok(best.map(|(_, proposal)| proposal))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(lat: f64, lng: f64) -> IntervalPoint {
        IntervalPoint { lat, lng }
    }

    /// Vectors made with the server's `intervalRef` (`server/src/modules/roads/geo.ts`).
    #[test]
    fn the_reference_is_the_one_the_server_computes() {
        assert_eq!(
            interval_ref(p(50.1, 9.1), p(50.1, 9.104)).unwrap(),
            "ivl:5010000,910000:5010000,910400"
        );
        // negative numbers and halves round the way JavaScript's Math.round does (up)
        assert_eq!(
            interval_ref(p(-33.868_815, 151.209_295), p(-33.868_805, 151.209_395)).unwrap(),
            "ivl:-3386881,15120930:-3386880,15120940"
        );
        assert_eq!(quantise5(-0.000_005), 0); // -0.5 -> -0 (JavaScript: Math.round(-0.5) === -0)
        assert_eq!(quantise5(0.000_005), 1);
    }

    #[test]
    fn a_stretch_has_no_direction() {
        let a = p(50.1, 9.1);
        let b = p(50.1005, 9.104);
        assert_eq!(interval_ref(a, b), interval_ref(b, a));
        // the smaller latitude first, then the smaller longitude
        assert!(interval_ref(b, a).unwrap().starts_with("ivl:5010000,"));
        assert_eq!(
            interval_ref(p(50.1, 9.104), p(50.1, 9.1)).unwrap(),
            "ivl:5010000,910000:5010000,910400"
        );
    }

    #[test]
    fn two_taps_within_a_metre_name_the_same_stretch() {
        let a = interval_ref(p(50.1, 9.1), p(50.1, 9.104)).unwrap();
        let b = interval_ref(p(50.100_003, 9.100_002), p(50.099_998, 9.104_004)).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn a_reference_round_trips_and_malformed_ones_are_refused() {
        let reference = interval_ref(p(50.1, 9.1), p(50.101, 9.104)).unwrap();
        let (a, b) = parse_ref(&reference).unwrap();
        assert!((a.lat - 50.1).abs() < 1e-9 && (a.lng - 9.1).abs() < 1e-9);
        assert!((b.lat - 50.101).abs() < 1e-9 && (b.lng - 9.104).abs() < 1e-9);
        for bad in [
            "ivl:5010000,910000",
            "ivl:5010000,910000:5010100",
            "ivl:5010000,91x000:5010100,910400",
            "ivl:5010000,9100000000:5010100,910400",
            "ivl:9000001,910000:5010100,910400",
            "gap:8a2a1072b59ffff:1",
            "ivl:",
        ] {
            assert!(parse_ref(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn points_that_are_not_positions_name_no_stretch() {
        assert!(interval_ref(p(f64::NAN, 9.1), p(50.1, 9.1)).is_none());
        assert!(interval_ref(p(50.1, 9.1), p(91.0, 9.1)).is_none());
        assert!(interval_ref(p(0.0, 0.0), p(50.1, 9.1)).is_none());
    }

    #[test]
    fn the_length_is_the_straight_line() {
        let metres = straight_meters(p(50.1, 9.1), p(50.1, 9.104));
        assert!((metres - 286.0).abs() < 3.0, "{metres}");
    }
}
