//! Position → region tiles. The server tiles the world with H3 cells
//! (`h3-js`, resolution 7 by default, `regionTileH3Resolution` in
//! `GET /v1/config`) and identifies a tile by the cell's lower-case hex
//! string; the client has to compute exactly the same cells, so the tests
//! below check `h3o` against vectors made with `h3-js` itself.

use h3o::{CellIndex, LatLng, Resolution};

/// The tile resolution until the server's configuration says otherwise.
pub const DEFAULT_REGION_RESOLUTION: u8 = 7;

fn cell_at(lat: f64, lng: f64, resolution: u8) -> Option<CellIndex> {
    let resolution = Resolution::try_from(resolution).ok()?;
    let position = LatLng::new(lat, lng).ok()?;
    Some(position.to_cell(resolution))
}

fn tile_id(cell: CellIndex) -> String {
    format!("{:x}", u64::from(cell))
}

/// The tile containing a position, or `None` for coordinates that are not a
/// position at all (NaN, infinite) or a resolution H3 does not have.
pub fn tile_at(lat: f64, lng: f64, resolution: u8) -> Option<String> {
    cell_at(lat, lng, resolution).map(tile_id)
}

/// The tile of a position and its neighbours out to `ring` steps (0 = the
/// tile alone, 1 = seven tiles, 2 = nineteen), sorted and without repeats.
/// Empty for an invalid position.
pub fn tiles_around(lat: f64, lng: f64, resolution: u8, ring: u32) -> Vec<String> {
    let Some(cell) = cell_at(lat, lng, resolution) else {
        return Vec::new();
    };
    let mut tiles: Vec<String> = cell
        .grid_disk::<Vec<CellIndex>>(ring)
        .into_iter()
        .map(tile_id)
        .collect();
    tiles.sort();
    tiles.dedup();
    tiles
}

/// How far around a position to watch: one ring normally, two at motorway
/// speed (a resolution-7 tile is about 2.4 km across; at 100 km/h the edge
/// of one ring is under two minutes away).
pub fn ring_for_speed(speed_kmh: Option<f64>) -> u32 {
    match speed_kmh {
        Some(speed) if speed >= 100.0 => 2,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `(lat, lng, resolution 7, resolution 4, resolution 2)`, all made with
    /// `h3-js`' `latLngToCell` (version 4, the one the server uses).
    const VECTORS: &[(f64, f64, &str, &str, &str)] = &[
        (52.52, 13.405, "871f1d489ffffff", "841f1d5ffffffff", "821f1ffffffffff"),
        (48.137, 11.575, "871f8d7a4ffffff", "841f8d7ffffffff", "821f8ffffffffff"),
        (0.0, 0.0, "87754e64dffffff", "84754a9ffffffff", "82754ffffffffff"),
        (-33.8688, 151.2093, "87be0e35cffffff", "84be0e3ffffffff", "82be0ffffffffff"),
        (64.1466, -21.9426, "87075dd4bffffff", "84075ddffffffff", "82075ffffffffff"),
        (35.6762, 139.6503, "872f5a363ffffff", "842f5a3ffffffff", "822f5ffffffffff"),
        (51.5074, -0.1278, "87195da49ffffff", "84194adffffffff", "82194ffffffffff"),
        (-54.8, -68.3, "87df45175ffffff", "84df451ffffffff", "82df47fffffffff"),
    ];

    #[test]
    fn tiles_match_h3_js_at_every_resolution_the_server_uses() {
        for (lat, lng, res7, res4, res2) in VECTORS {
            assert_eq!(tile_at(*lat, *lng, 7).as_deref(), Some(*res7), "{lat},{lng} at 7");
            assert_eq!(tile_at(*lat, *lng, 4).as_deref(), Some(*res4), "{lat},{lng} at 4");
            assert_eq!(tile_at(*lat, *lng, 2).as_deref(), Some(*res2), "{lat},{lng} at 2");
        }
    }

    #[test]
    fn a_ring_of_one_is_the_seven_tiles_h3_js_lists() {
        let expected = [
            "871f1d488ffffff",
            "871f1d489ffffff",
            "871f1d48bffffff",
            "871f1d48dffffff",
            "871f1d4d4ffffff",
            "871f1d4d6ffffff",
            "871f1d4f2ffffff",
        ];
        assert_eq!(tiles_around(52.52, 13.405, 7, 1), expected);
        assert_eq!(tiles_around(52.52, 13.405, 7, 0), ["871f1d489ffffff"]);
        assert_eq!(tiles_around(52.52, 13.405, 7, 2).len(), 19);
    }

    #[test]
    fn coordinates_that_are_not_a_position_give_no_tiles() {
        assert_eq!(tile_at(f64::NAN, 13.0, 7), None);
        assert!(tiles_around(f64::INFINITY, 13.0, 7, 1).is_empty());
        assert_eq!(tile_at(52.5, 13.4, 99), None);
    }

    #[test]
    fn the_ring_grows_at_motorway_speed() {
        assert_eq!(ring_for_speed(None), 1);
        assert_eq!(ring_for_speed(Some(50.0)), 1);
        assert_eq!(ring_for_speed(Some(130.0)), 2);
    }
}
