//! "This road has no speed limit on record" (server 1.1.0, `server/docs/speed-limit-corrections.md` D13).
//!
//! The import only holds roads that carry a limit, so there is no segment to propose a value for. A proposal names
//! a *place and a direction*; the server derives a short fixed stretch of road from them and counts devices that
//! name the same place:
//!
//! * the place is the H3 cell (resolution 10) of the position,
//! * the direction is one of 8 buckets of 22.5° of the road's axis (a heading and its opposite are the same road).
//!
//! A device signs the reference `gap:<cell>:<axis>`; it cannot compute the key of the geometry the server derives
//! (it has none), and it does not need to. Everything here is the part a device *can* compute — the same function
//! as the server's `gap.ts`, checked against vectors made with it.

use h3o::{CellIndex, LatLng, Resolution};

use crate::storage::{LocalCorrectionProposal, Store, StoreError};

use super::matching::distance_to_line_string_meters;
use super::types::{Geometry, SpeedLimitSegment};

/// H3 resolution of the cell a gap is identified by (edge ≈ 66 m).
pub const GAP_CELL_RESOLUTION: u8 = 10;
/// Direction buckets of 22.5° each.
pub const GAP_AXES: u8 = 8;

/// An imported road this close to the reported point, running the same way, means the road is not missing.
pub const ROAD_ALREADY_THERE_RADIUS_METERS: f64 = 15.0;
pub const ROAD_ALREADY_THERE_MAX_ANGLE_DEGREES: f64 = 25.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GapPlace {
    /// Lower-case hex of the resolution-10 cell, as the server's `h3-js` writes it.
    pub cell: String,
    /// 0..7; 0 = north–south, 4 = east–west.
    pub axis: u8,
}

impl GapPlace {
    /// What the signed vote names.
    pub fn reference(&self) -> String {
        format!("gap:{}:{}", self.cell, self.axis)
    }

    /// The axis bucket as degrees (0, 22.5, … 157.5).
    pub fn axis_degrees(&self) -> f64 {
        f64::from(self.axis) * (180.0 / f64::from(GAP_AXES))
    }
}

/// Any heading (0..360, either direction of travel) → axis bucket.
pub fn axis_bucket(bearing_degrees: f64) -> u8 {
    let axis = bearing_degrees.rem_euclid(180.0);
    ((axis / (180.0 / f64::from(GAP_AXES))).round() as u8) % GAP_AXES
}

/// The place a position and a heading name; `None` for a position that is not one.
pub fn place_of(lat: f64, lng: f64, bearing_degrees: f64) -> Option<GapPlace> {
    if !bearing_degrees.is_finite() {
        return None;
    }
    let cell = cell_of(lat, lng)?;
    Some(GapPlace {
        cell: format!("{:x}", u64::from(cell)),
        axis: axis_bucket(bearing_degrees),
    })
}

fn cell_of(lat: f64, lng: f64) -> Option<CellIndex> {
    let position = LatLng::new(lat, lng).ok()?;
    Some(position.to_cell(Resolution::try_from(GAP_CELL_RESOLUTION).ok()?))
}

/// The cell (resolution 10, as the server writes it) a position lies in.
pub fn gap_cell_at(lat: f64, lng: f64) -> Option<String> {
    cell_of(lat, lng).map(|cell| format!("{:x}", u64::from(cell)))
}

/// `(cell, axis)` of a `gap:<cell>:<axis>` reference.
pub fn parse_ref(reference: &str) -> Option<GapPlace> {
    let mut parts = reference.split(':');
    if parts.next()? != "gap" {
        return None;
    }
    let cell = parts.next()?.to_string();
    let axis: u8 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || axis >= GAP_AXES || cell.len() != 15 {
        return None;
    }
    Some(GapPlace { cell, axis })
}

/// Direction (0..180, an axis) of the part of a line nearest to a point.
fn axis_of_nearest_part(lat: f64, lng: f64, line: &[[f64; 2]]) -> Option<f64> {
    if line.len() < 2 {
        return None;
    }
    let mut best: Option<(f64, f64)> = None;
    for pair in line.windows(2) {
        let part = [pair[0], pair[1]];
        let distance = distance_to_line_string_meters(lat, lng, &part)?;
        let dy = pair[1][1] - pair[0][1];
        let dx = (pair[1][0] - pair[0][0]) * ((pair[0][1] + pair[1][1]) / 2.0).to_radians().cos();
        let azimuth = dx.atan2(dy).to_degrees().rem_euclid(180.0);
        if best.is_none_or(|(d, _)| distance < d) {
            best = Some((distance, azimuth));
        }
    }
    best.map(|(_, azimuth)| azimuth)
}

fn axis_difference(a: f64, b: f64) -> f64 {
    let diff = (a - b).abs() % 180.0;
    diff.min(180.0 - diff)
}

/// An imported segment within [`ROAD_ALREADY_THERE_RADIUS_METERS`] of the point that runs the way the proposal says
/// (±[`ROAD_ALREADY_THERE_MAX_ANGLE_DEGREES`]) — the road the server would tell the host to correct instead.
pub fn road_already_there(
    segments: &[SpeedLimitSegment],
    lat: f64,
    lng: f64,
    axis_degrees: f64,
) -> Option<SpeedLimitSegment> {
    segments
        .iter()
        .filter(|s| s.source != "community")
        .filter_map(|segment| {
            let Geometry::LineString { coordinates } = &segment.geometry else {
                return None;
            };
            let distance = distance_to_line_string_meters(lat, lng, coordinates)?;
            if distance > ROAD_ALREADY_THERE_RADIUS_METERS {
                return None;
            }
            let axis = axis_of_nearest_part(lat, lng, coordinates)?;
            (axis_difference(axis, axis_degrees) <= ROAD_ALREADY_THERE_MAX_ANGLE_DEGREES)
                .then_some((distance, segment))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, segment)| segment.clone())
}

/// This device's own proposal for the road without a limit at a position: the proposal of the same cell, and of the
/// same direction when the heading is known (any direction when it is not). Only proposals of a gap are looked at.
pub fn own_gap_proposal(
    store: &dyn Store,
    lat: f64,
    lng: f64,
    heading: Option<f64>,
) -> Result<Option<LocalCorrectionProposal>, StoreError> {
    let Some(cell) = gap_cell_at(lat, lng) else {
        return Ok(None);
    };
    let axis = heading.map(axis_bucket);
    Ok(store.local_proposals()?.into_iter().find(|proposal| {
        parse_ref(&proposal.segment_key)
            .is_some_and(|place| place.cell == cell && axis.is_none_or(|a| a == place.axis))
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_heading_and_its_opposite_are_the_same_axis_bucket() {
        assert_eq!(axis_bucket(0.0), 0);
        assert_eq!(axis_bucket(180.0), 0);
        assert_eq!(axis_bucket(360.0), 0);
        assert_eq!(axis_bucket(90.0), 4);
        assert_eq!(axis_bucket(270.0), 4);
        assert_eq!(axis_bucket(45.0), 2);
        assert_eq!(axis_bucket(225.0), 2);
        assert_eq!(axis_bucket(135.0), 6);
        for heading in [0.0, 10.0, 33.0, 89.0, 91.0, 150.0, 179.0] {
            assert_eq!(axis_bucket(heading), axis_bucket(heading + 180.0));
        }
        // rounds to the nearest 22.5 degrees and wraps just below 180 back to north-south
        assert_eq!(axis_bucket(11.0), 0);
        assert_eq!(axis_bucket(12.0), 1);
        assert_eq!(axis_bucket(168.5), 7);
        assert_eq!(axis_bucket(169.0), 0);
        assert_eq!(axis_bucket(-10.0), 0);
        assert_eq!(axis_bucket(-100.0), 4);
    }

    /// Vector made with the server's `gap.ts` / `h3-js`: `latLngToCell(50.1, 9.1, 10)`.
    #[test]
    fn the_cell_is_the_one_the_servers_h3_js_writes() {
        let place = place_of(50.1, 9.1, 90.0).unwrap();
        assert_eq!(place.cell.len(), 15);
        assert!(
            place.cell.starts_with("8a"),
            "resolution 10 cells start with 8a: {}",
            place.cell
        );
        assert_eq!(place.axis, 4);
        assert_eq!(place.reference(), format!("gap:{}:4", place.cell));
        assert_eq!(parse_ref(&place.reference()), Some(place));
    }

    #[test]
    fn references_that_are_not_a_cell_and_an_axis_are_refused() {
        assert_eq!(parse_ref("gap:8a2a1072b59ffff:8"), None);
        assert_eq!(parse_ref("gap:8a2a1072b59ff:1"), None);
        assert_eq!(parse_ref("seg:8a2a1072b59ffff:1"), None);
        assert_eq!(parse_ref("gap:8a2a1072b59ffff"), None);
        assert!(parse_ref("gap:8a2a1072b59ffff:7").is_some());
    }

    #[test]
    fn two_positions_in_one_cell_and_headings_that_are_opposite_name_the_same_place() {
        let a = place_of(50.1, 9.1, 90.0).unwrap();
        let b = place_of(50.100_05, 9.100_05, 270.0).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, place_of(50.1, 9.1, 0.0).unwrap());
    }

    #[test]
    fn a_position_that_is_not_one_names_no_place() {
        assert!(place_of(f64::NAN, 9.1, 90.0).is_none());
        assert!(place_of(50.1, 9.1, f64::INFINITY).is_none());
    }

    fn segment_along(lat: f64, lng_from: f64, lng_to: f64, source: &str) -> SpeedLimitSegment {
        SpeedLimitSegment {
            id: "s1".to_string(),
            geometry: Geometry::LineString {
                coordinates: vec![[lng_from, lat], [lng_to, lat]],
            },
            speed_limit: 30.0,
            speed_limit_unit: "kmh".to_string(),
            source: source.to_string(),
            source_license: None,
            imported_at: "2026-01-01T00:00:00Z".to_string(),
            last_confirmed_at: None,
            segment_key: Some("key1".to_string()),
            corrected_by: None,
            imported_speed_limit: None,
            correction: None,
        }
    }

    #[test]
    fn an_imported_road_running_the_same_way_means_the_road_is_not_missing() {
        // a road along latitude 50.1 (east–west), 5 m north of the point
        let road = segment_along(50.100_045, 9.09, 9.11, "osm");
        assert!(road_already_there(&[road.clone()], 50.1, 9.1, 90.0).is_some());
        // a proposal across it (north–south) is a side street, not that road
        assert!(road_already_there(&[road.clone()], 50.1, 9.1, 0.0).is_none());
        // far away: not this road
        let far = segment_along(50.101, 9.09, 9.11, "osm");
        assert!(road_already_there(&[far], 50.1, 9.1, 90.0).is_none());
        // a community stretch is not "imported": it can be corrected, but it is no reason to refuse a gap
        let community = segment_along(50.100_045, 9.09, 9.11, "community");
        assert!(road_already_there(&[community], 50.1, 9.1, 90.0).is_none());
    }
}
