//! The offline area: which part of the static data a device keeps, how much room it may take, and what is let go
//! of first (docs/offline-storage.md).
//!
//! The server cuts its static data into H3 tiles (`staticDataPartitionH3Resolution`, 4 by default: ≈ 1,770 km² each)
//! and names every tile's package in the manifest. Fetching *all* of Europe puts ≈ 4 GB on a device (measured:
//! 13.6 M objects, ≈ 300 B each), so the device chooses:
//!
//! * **auto** (default): the home region, the surroundings of the current position with a buffer, and the regions
//!   driven through lately — a few hundred megabytes, following the driver;
//! * **regions**: countries or regions picked from `GET /v1/static-data/regions`;
//! * **all**: everything the manifest lists (the previous behaviour).
//!
//! Everything in this module is pure: it decides from what it is given and touches nothing, so the decisions are
//! testable without a store or a network. The engine ([`super::engine`]) carries them out.

use std::collections::{BTreeSet, HashMap};
use std::str::FromStr;

use h3o::{CellIndex, LatLng};
use serde::{Deserialize, Serialize};

use crate::storage::{PartitionRecord, Store, StoreError};

use super::types::{Geometry, SpeedLimitSegment};

/// What the device keeps of the static data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OfflineMode {
    /// Home region, surroundings of the current position, regions lately driven through.
    Auto,
    /// Exactly the chosen countries/regions.
    Regions,
    /// Everything the server lists.
    All,
}

/// How the automatic area is cut, in tiles of the server's partition resolution: a *radius* in tiles around a
/// position (0 = that tile alone, 1 = it and its six neighbours, 2 = nineteen tiles …). With the default
/// resolution 4 a tile is ≈ 22 km across, so radius 2 ≈ ±50 km.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoRegionPolicy {
    /// Around the home position — never let go of.
    pub home_radius_tiles: u32,
    /// Around where the device is now (the buffer that keeps lookups local while driving).
    pub current_radius_tiles: u32,
    /// How many of the most recently driven-through places are kept besides.
    pub recent_places: u32,
    /// Around each of them.
    pub recent_radius_tiles: u32,
}

impl Default for AutoRegionPolicy {
    fn default() -> Self {
        Self {
            home_radius_tiles: 3,
            current_radius_tiles: 2,
            recent_places: 4,
            recent_radius_tiles: 1,
        }
    }
}

/// Everything the host app can set about the offline area. Persisted by the library (store setting `offline`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OfflineSettings {
    pub mode: OfflineMode,
    /// Region ids (`GET /v1/static-data/regions`) for [`OfflineMode::Regions`].
    pub regions: Vec<String>,
    pub auto: AutoRegionPolicy,
    /// Where home is, `(lat, lng)`. Unset until the host app says, or the first position it reports.
    pub home: Option<(f64, f64)>,
    /// What the offline data may take on the device, in bytes (as the store measures, estimated before download).
    /// `None` = no limit.
    pub max_bytes: Option<u64>,
    /// Do not download more than the tile of the current position over a metered connection (default on).
    pub wifi_only: bool,
}

impl Default for OfflineSettings {
    fn default() -> Self {
        Self {
            mode: OfflineMode::Auto,
            regions: Vec::new(),
            auto: AutoRegionPolicy::default(),
            home: None,
            max_bytes: None,
            wifi_only: true,
        }
    }
}

const SETTINGS_KEY: &str = "offline";
const VISITED_KEY: &str = "offline.visited";

pub fn load_settings(store: &dyn Store) -> OfflineSettings {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_settings(store: &dyn Store, settings: &OfflineSettings) -> Result<(), StoreError> {
    let text = serde_json::to_string(settings).map_err(|e| Box::new(e) as StoreError)?;
    store.set_setting(SETTINGS_KEY, &text)
}

/// A place the device was in, remembered by its tile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VisitedTile {
    pub tile: String,
    pub at_unix_ms: i64,
}

pub fn load_visited(store: &dyn Store) -> Vec<VisitedTile> {
    store
        .get_setting(VISITED_KEY)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Adds a tile to the history (newest first, no repeats, bounded). Returns whether the history changed.
pub fn note_visit(
    history: &mut Vec<VisitedTile>,
    tile: &str,
    now_unix_ms: i64,
    keep: usize,
) -> bool {
    if history.first().is_some_and(|v| v.tile == tile) {
        return false;
    }
    history.retain(|v| v.tile != tile);
    history.insert(
        0,
        VisitedTile {
            tile: tile.to_string(),
            at_unix_ms: now_unix_ms,
        },
    );
    history.truncate(keep.max(1));
    true
}

pub fn save_visited(store: &dyn Store, history: &[VisitedTile]) -> Result<(), StoreError> {
    let text = serde_json::to_string(history).map_err(|e| Box::new(e) as StoreError)?;
    store.set_setting(VISITED_KEY, &text)
}

fn parse_cell(tile: &str) -> Option<CellIndex> {
    let raw = u64::from_str_radix(tile, 16).ok()?;
    CellIndex::try_from(raw).ok()
}

fn cell_id(cell: CellIndex) -> String {
    format!("{:x}", u64::from(cell))
}

/// The tile and its neighbours out to `radius` steps.
pub fn tile_disk(tile: &str, radius: u32) -> Vec<String> {
    match parse_cell(tile) {
        Some(cell) => cell
            .grid_disk::<Vec<CellIndex>>(radius)
            .into_iter()
            .map(cell_id)
            .collect(),
        None => Vec::new(),
    }
}

/// The tile (at `resolution`) of a position.
pub fn tile_of(lat: f64, lng: f64, resolution: u8) -> Option<String> {
    let position = LatLng::new(lat, lng).ok()?;
    let resolution = h3o::Resolution::try_from(resolution).ok()?;
    Some(cell_id(position.to_cell(resolution)))
}

/// What the automatic area asks for, with the reason each tile is in it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AutoSelection {
    /// The tile of the current position and its ring: wanted first, even over a metered connection.
    pub current: BTreeSet<String>,
    /// The home area: never evicted.
    pub home: BTreeSet<String>,
    /// The recently driven-through places.
    pub recent: BTreeSet<String>,
}

impl AutoSelection {
    pub fn all(&self) -> BTreeSet<String> {
        self.current
            .iter()
            .chain(&self.home)
            .chain(&self.recent)
            .cloned()
            .collect()
    }
}

/// The automatic area from the policy, the home position, the current position and the history.
pub fn auto_selection(
    policy: &AutoRegionPolicy,
    resolution: u8,
    home: Option<(f64, f64)>,
    current: Option<(f64, f64)>,
    visited: &[VisitedTile],
) -> AutoSelection {
    let mut selection = AutoSelection::default();
    if let Some(tile) = current.and_then(|(lat, lng)| tile_of(lat, lng, resolution)) {
        selection
            .current
            .extend(tile_disk(&tile, policy.current_radius_tiles));
    }
    if let Some(tile) = home.and_then(|(lat, lng)| tile_of(lat, lng, resolution)) {
        selection
            .home
            .extend(tile_disk(&tile, policy.home_radius_tiles));
    }
    for visit in visited.iter().take(policy.recent_places as usize) {
        // a history entry from another resolution names no tile of this one
        if parse_cell(&visit.tile).is_some_and(|c| u8::from(c.resolution()) == resolution) {
            selection
                .recent
                .extend(tile_disk(&visit.tile, policy.recent_radius_tiles));
        }
    }
    selection
}

/// Bounding box `(west, south, east, north)` of a tile.
pub fn tile_bbox(tile: &str) -> Option<(f64, f64, f64, f64)> {
    let cell = parse_cell(tile)?;
    let mut bbox = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for vertex in cell.boundary().iter() {
        let (lat, lng) = (vertex.lat(), vertex.lng());
        bbox.0 = bbox.0.min(lng);
        bbox.1 = bbox.1.min(lat);
        bbox.2 = bbox.2.max(lng);
        bbox.3 = bbox.3.max(lat);
    }
    Some(bbox)
}

fn bbox_contains_box(outer: (f64, f64, f64, f64), inner: (f64, f64, f64, f64)) -> bool {
    inner.0 >= outer.0 && inner.1 >= outer.1 && inner.2 <= outer.2 && inner.3 <= outer.3
}

fn bbox_contains_point(bbox: (f64, f64, f64, f64), lat: f64, lng: f64) -> bool {
    lng >= bbox.0 && lng <= bbox.2 && lat >= bbox.1 && lat <= bbox.3
}

fn segment_box(segment: &SpeedLimitSegment) -> Option<(f64, f64, f64, f64)> {
    let Geometry::LineString { coordinates } = &segment.geometry else {
        return None;
    };
    let first = coordinates.first()?;
    let mut bbox = (first[0], first[1], first[0], first[1]);
    for c in coordinates {
        bbox.0 = bbox.0.min(c[0]);
        bbox.1 = bbox.1.min(c[1]);
        bbox.2 = bbox.2.max(c[0]);
        bbox.3 = bbox.3.max(c[1]);
    }
    Some(bbox)
}

/// Lets go of one stored package: its entities and its record. An entity that is also in a stored neighbouring
/// tile (a road that crosses the border) stays, and so does one that reaches out of the tile into an unstored
/// neighbour — over-keeping a few border objects is the safe error; dropping one a stored tile still needs would
/// leave a hole no sync would refill (that tile's hash has not changed). Returns how many entities were removed.
pub fn remove_partition(store: &dyn Store, tile: &str) -> Result<usize, StoreError> {
    let Some(cell) = parse_cell(tile) else {
        store.remove_partition_record(tile)?;
        return Ok(0);
    };
    let Some(own) = tile_bbox(tile) else {
        store.remove_partition_record(tile)?;
        return Ok(0);
    };
    // The boxes of the stored neighbouring tiles: what an entity of this tile may also belong to.
    let mut neighbour_boxes = Vec::new();
    for neighbour in cell.grid_disk::<Vec<CellIndex>>(2) {
        let id = cell_id(neighbour);
        if id == tile {
            continue;
        }
        if store.get_partition_hash(&id)?.is_some() {
            if let Some(bbox) = tile_bbox(&id) {
                neighbour_boxes.push(bbox);
            }
        }
    }
    let in_a_neighbour_box = |lat: f64, lng: f64| {
        neighbour_boxes
            .iter()
            .any(|b| bbox_contains_point(*b, lat, lng))
    };

    let centre = LatLng::from(cell);
    // The farthest vertex from the centre, with margin: the radius that surely holds the tile.
    let radius = cell
        .boundary()
        .iter()
        .map(|v| {
            super::matching::haversine_distance_meters(centre.lat(), centre.lng(), v.lat(), v.lng())
        })
        .fold(0.0_f64, f64::max)
        * 1.1
        + 100.0;

    let mut removed = 0;
    for segment in store.speed_limit_segments_near(centre.lat(), centre.lng(), radius)? {
        let Some(bbox) = segment_box(&segment) else {
            continue;
        };
        // wholly inside this tile's box and not touching the area of a stored neighbour
        let touches_neighbour = neighbour_boxes
            .iter()
            .any(|b| !(bbox.2 < b.0 || bbox.0 > b.2 || bbox.3 < b.1 || bbox.1 > b.3));
        if bbox_contains_box(own, bbox) && !touches_neighbour {
            store.remove_static_entity("speedLimitSegment", &segment.id)?;
            removed += 1;
        }
    }
    for sign in store.static_signs_near(centre.lat(), centre.lng(), radius)? {
        let Some((lat, lng)) = sign.position.as_lat_lng() else {
            continue;
        };
        if bbox_contains_point(own, lat, lng) && !in_a_neighbour_box(lat, lng) {
            store.remove_static_entity("staticSign", &sign.id)?;
            removed += 1;
        }
    }
    for camera in store.fixed_speed_cameras()? {
        let Some((lat, lng)) = camera.position.as_lat_lng() else {
            continue;
        };
        if bbox_contains_point(own, lat, lng) && !in_a_neighbour_box(lat, lng) {
            store.remove_static_entity("fixedSpeedCamera", &camera.id)?;
            removed += 1;
        }
    }
    store.remove_partition_record(tile)?;
    Ok(removed)
}

// ---------------------------------------------------------------- planning a download

/// Rough ratio of what a package occupies in the device database to its size as JSON: measured on the Europe
/// data, 299 B per object in SQLite against 443 B per row of JSON (`client-lib/docs/bootstrap-measurements.md`,
/// `server/docs/europe-scale.md`).
pub const DEVICE_BYTES_PER_JSON_BYTE: f64 = 0.7;

pub fn estimated_device_bytes(json_bytes: u64) -> u64 {
    (json_bytes as f64 * DEVICE_BYTES_PER_JSON_BYTE).round() as u64
}

/// One package the manifest offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfferedTile {
    pub tile: String,
    pub hash: String,
    pub size_bytes: u64,
}

/// Why a package was not fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeferReason {
    /// Over a metered connection, and only the tile of the current position is let through.
    Metered,
    /// It would not fit under the limit, and nothing that may be let go of is left to make room.
    StorageLimit,
}

/// What a sync of the static data is to do, decided before anything is fetched.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StaticPlan {
    /// Stored packages to let go of now (outside the wanted set, in explicit-region/all modes).
    pub remove: Vec<String>,
    /// In the order they are to be fetched; each says which stored tiles to evict first to make room.
    pub fetch: Vec<PlannedFetch>,
    /// Wanted and not fetched, with the reason.
    pub deferred: Vec<(String, DeferReason)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFetch {
    pub tile: String,
    pub evict_first: Vec<String>,
}

/// Inputs of [`plan_static_sync`].
pub struct PlanInput<'a> {
    pub offered: &'a [OfferedTile],
    pub stored: &'a [PartitionRecord],
    /// `None` = everything offered is wanted.
    pub wanted: Option<&'a BTreeSet<String>>,
    /// Tiles never evicted and never removed (the home area).
    pub protected: &'a BTreeSet<String>,
    /// Tiles let through even over a metered connection, and fetched first.
    pub urgent: &'a BTreeSet<String>,
    /// The order of the rest: earlier first.
    pub priority: &'a [String],
    pub max_device_bytes: Option<u64>,
    pub metered_blocks: bool,
    /// Remove stored tiles that are not wanted straight away (explicit regions / all), rather than only when room
    /// is needed (auto: they are a cache of recent places).
    pub prune_unwanted: bool,
}

/// Decides what to remove, fetch and defer — pure.
pub fn plan_static_sync(input: &PlanInput<'_>) -> StaticPlan {
    let mut plan = StaticPlan::default();
    let stored: HashMap<&str, &PartitionRecord> =
        input.stored.iter().map(|r| (r.tile.as_str(), r)).collect();
    let is_wanted = |tile: &str| input.wanted.is_none_or(|w| w.contains(tile));

    // Unwanted packages that are stored: let go of now, or keep as a cache until room is needed.
    let mut cache: Vec<&PartitionRecord> = Vec::new();
    for record in input.stored {
        if is_wanted(&record.tile) || input.protected.contains(&record.tile) {
            continue;
        }
        if input.prune_unwanted {
            plan.remove.push(record.tile.clone());
        } else {
            cache.push(record);
        }
    }
    // Longest unused goes first.
    cache.sort_by(|a, b| {
        a.last_used_unix_ms
            .cmp(&b.last_used_unix_ms)
            .then_with(|| a.tile.cmp(&b.tile))
    });
    let mut cache: Vec<&PartitionRecord> = cache;

    // What has to be fetched: wanted, and not stored with this hash.
    let rank = |tile: &str| -> (u8, usize) {
        if input.urgent.contains(tile) {
            (0, 0)
        } else {
            match input.priority.iter().position(|t| t == tile) {
                Some(index) => (1, index),
                None => (2, 0),
            }
        }
    };
    let mut wanted_offers: Vec<&OfferedTile> = input
        .offered
        .iter()
        .filter(|o| is_wanted(&o.tile))
        .filter(|o| stored.get(o.tile.as_str()).is_none_or(|r| r.hash != o.hash))
        .collect();
    wanted_offers.sort_by(|a, b| {
        rank(&a.tile)
            .cmp(&rank(&b.tile))
            .then_with(|| a.tile.cmp(&b.tile))
    });

    // Device bytes in use after the removals above.
    let removed: BTreeSet<&str> = plan.remove.iter().map(String::as_str).collect();
    let mut used: u64 = input
        .stored
        .iter()
        .filter(|r| !removed.contains(r.tile.as_str()))
        .map(|r| estimated_device_bytes(r.size_bytes))
        .sum();

    for offer in wanted_offers {
        let urgent = input.urgent.contains(&offer.tile);
        if input.metered_blocks && !urgent {
            plan.deferred
                .push((offer.tile.clone(), DeferReason::Metered));
            continue;
        }
        let need = estimated_device_bytes(offer.size_bytes);
        // A package replacing a stored one frees that one's space.
        let replaced = stored
            .get(offer.tile.as_str())
            .map(|r| estimated_device_bytes(r.size_bytes.max(1)))
            .unwrap_or(0);
        let mut evict_first = Vec::new();
        if let Some(limit) = input.max_device_bytes {
            let base = used.saturating_sub(replaced);
            let mut after = base + need;
            // Work out what would have to go; it only goes if that is enough - evicting and still not fitting
            // would throw data away for nothing.
            let mut freed = 0u64;
            let mut taken = 0usize;
            while after > limit && taken < cache.len() {
                let victim = cache[taken];
                let size = estimated_device_bytes(victim.size_bytes);
                freed += size;
                after = after.saturating_sub(size);
                evict_first.push(victim.tile.clone());
                taken += 1;
            }
            if after > limit {
                plan.deferred
                    .push((offer.tile.clone(), DeferReason::StorageLimit));
                continue;
            }
            cache.drain(..taken);
            used = used.saturating_sub(freed);
        }
        used = used.saturating_sub(replaced) + need;
        plan.fetch.push(PlannedFetch {
            tile: offer.tile.clone(),
            evict_first,
        });
    }
    plan
}

// ---------------------------------------------------------------- helpers shared with the host-facing view

/// For a position: which stored tile it is in, if any.
pub fn stored_tile_at(
    store: &dyn Store,
    lat: f64,
    lng: f64,
    resolution: u8,
) -> Result<Option<String>, StoreError> {
    let Some(tile) = tile_of(lat, lng, resolution) else {
        return Ok(None);
    };
    Ok(store.get_partition_hash(&tile)?.map(|_| tile))
}

impl FromStr for OfflineMode {
    type Err = ();
    fn from_str(text: &str) -> Result<Self, ()> {
        match text {
            "auto" => Ok(OfflineMode::Auto),
            "regions" => Ok(OfflineMode::Regions),
            "all" => Ok(OfflineMode::All),
            _ => Err(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RES: u8 = 4;

    fn tile(lat: f64, lng: f64) -> String {
        tile_of(lat, lng, RES).unwrap()
    }

    fn record(tile: &str, size: u64, used: i64) -> PartitionRecord {
        PartitionRecord {
            tile: tile.to_string(),
            hash: "h".to_string(),
            size_bytes: size,
            last_used_unix_ms: used,
        }
    }

    fn offer(tile: &str, size: u64) -> OfferedTile {
        OfferedTile {
            tile: tile.to_string(),
            hash: "h".to_string(),
            size_bytes: size,
        }
    }

    #[test]
    fn the_automatic_area_is_home_plus_here_plus_recent_places() {
        let home = (52.52, 13.405);
        let here = (48.137, 11.575);
        let visited = vec![
            VisitedTile {
                tile: tile(50.11, 8.68),
                at_unix_ms: 3,
            },
            VisitedTile {
                tile: tile(53.55, 9.99),
                at_unix_ms: 2,
            },
        ];
        let policy = AutoRegionPolicy {
            home_radius_tiles: 1,
            current_radius_tiles: 1,
            recent_places: 1,
            recent_radius_tiles: 0,
        };
        let selection = auto_selection(&policy, RES, Some(home), Some(here), &visited);
        assert_eq!(selection.home.len(), 7);
        assert_eq!(selection.current.len(), 7);
        assert_eq!(
            selection.recent.len(),
            1,
            "only the newest recent place is kept"
        );
        assert!(selection.recent.contains(&tile(50.11, 8.68)));
        assert!(selection.home.contains(&tile(52.52, 13.405)));
        assert!(selection.current.contains(&tile(48.137, 11.575)));
        assert_eq!(selection.all().len(), 15);
    }

    #[test]
    fn nothing_is_asked_for_that_is_not_known() {
        let selection = auto_selection(&AutoRegionPolicy::default(), RES, None, None, &[]);
        assert!(selection.all().is_empty());
        // a history entry from another resolution names no tile of this one
        let other = VisitedTile {
            tile: tile_of(48.0, 11.0, 7).unwrap(),
            at_unix_ms: 1,
        };
        let selection = auto_selection(&AutoRegionPolicy::default(), RES, None, None, &[other]);
        assert!(selection.recent.is_empty());
    }

    #[test]
    fn the_history_is_newest_first_without_repeats_and_bounded() {
        let mut history = Vec::new();
        assert!(note_visit(&mut history, "a", 1, 3));
        assert!(note_visit(&mut history, "b", 2, 3));
        assert!(
            !note_visit(&mut history, "b", 3, 3),
            "the same place again changes nothing"
        );
        assert!(note_visit(&mut history, "a", 4, 3));
        assert_eq!(
            history.iter().map(|v| v.tile.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        note_visit(&mut history, "c", 5, 3);
        note_visit(&mut history, "d", 6, 3);
        assert_eq!(
            history.iter().map(|v| v.tile.as_str()).collect::<Vec<_>>(),
            ["d", "c", "a"]
        );
    }

    #[test]
    fn everything_offered_is_fetched_when_nothing_is_selected_and_there_is_no_limit() {
        let offered = vec![offer("a", 100), offer("b", 200)];
        let none = BTreeSet::new();
        let plan = plan_static_sync(&PlanInput {
            offered: &offered,
            stored: &[],
            wanted: None,
            protected: &none,
            urgent: &none,
            priority: &[],
            max_device_bytes: None,
            metered_blocks: false,
            prune_unwanted: false,
        });
        assert_eq!(
            plan.fetch
                .iter()
                .map(|f| f.tile.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(plan.remove.is_empty() && plan.deferred.is_empty());
    }

    #[test]
    fn only_wanted_tiles_are_fetched_urgent_first_then_by_priority() {
        let offered = vec![offer("a", 1), offer("b", 1), offer("c", 1), offer("d", 1)];
        let wanted: BTreeSet<String> = ["a", "c", "d"].iter().map(|s| s.to_string()).collect();
        let urgent: BTreeSet<String> = ["d"].iter().map(|s| s.to_string()).collect();
        let none = BTreeSet::new();
        let priority = vec!["c".to_string(), "a".to_string()];
        let plan = plan_static_sync(&PlanInput {
            offered: &offered,
            stored: &[],
            wanted: Some(&wanted),
            protected: &none,
            urgent: &urgent,
            priority: &priority,
            max_device_bytes: None,
            metered_blocks: false,
            prune_unwanted: false,
        });
        assert_eq!(
            plan.fetch
                .iter()
                .map(|f| f.tile.as_str())
                .collect::<Vec<_>>(),
            ["d", "c", "a"]
        );
    }

    #[test]
    fn unchanged_stored_packages_are_not_fetched_again_and_changed_ones_are() {
        let offered = vec![
            offer("a", 10),
            OfferedTile {
                tile: "b".to_string(),
                hash: "new".to_string(),
                size_bytes: 10,
            },
        ];
        let stored = vec![record("a", 10, 0), record("b", 10, 0)];
        let none = BTreeSet::new();
        let plan = plan_static_sync(&PlanInput {
            offered: &offered,
            stored: &stored,
            wanted: None,
            protected: &none,
            urgent: &none,
            priority: &[],
            max_device_bytes: None,
            metered_blocks: false,
            prune_unwanted: false,
        });
        assert_eq!(
            plan.fetch
                .iter()
                .map(|f| f.tile.as_str())
                .collect::<Vec<_>>(),
            ["b"]
        );
    }

    #[test]
    fn explicit_regions_let_go_of_what_is_no_longer_chosen_but_never_of_the_home_area() {
        let offered = vec![offer("keep", 10)];
        let stored = vec![
            record("keep", 10, 0),
            record("gone", 10, 0),
            record("home", 10, 0),
        ];
        let wanted: BTreeSet<String> = ["keep"].iter().map(|s| s.to_string()).collect();
        let protected: BTreeSet<String> = ["home"].iter().map(|s| s.to_string()).collect();
        let none = BTreeSet::new();
        let plan = plan_static_sync(&PlanInput {
            offered: &offered,
            stored: &stored,
            wanted: Some(&wanted),
            protected: &protected,
            urgent: &none,
            priority: &[],
            max_device_bytes: None,
            metered_blocks: false,
            prune_unwanted: true,
        });
        assert_eq!(plan.remove, vec!["gone".to_string()]);
    }

    #[test]
    fn in_auto_mode_unwanted_packages_stay_as_a_cache_until_room_is_needed_oldest_use_first() {
        // limit 100 device bytes = ~143 json bytes; stored: two cached tiles of 70 json bytes each (49 device)
        let offered = vec![offer("new", 100)];
        let stored = vec![
            record("cold", 70, 10),
            record("warm", 70, 900),
            record("home", 1, 0),
        ];
        let wanted: BTreeSet<String> = ["new"].iter().map(|s| s.to_string()).collect();
        let protected: BTreeSet<String> = ["home"].iter().map(|s| s.to_string()).collect();
        let none = BTreeSet::new();
        let plan = plan_static_sync(&PlanInput {
            offered: &offered,
            stored: &stored,
            wanted: Some(&wanted),
            protected: &protected,
            urgent: &none,
            priority: &[],
            max_device_bytes: Some(100),
            metered_blocks: false,
            prune_unwanted: false,
        });
        assert!(
            plan.remove.is_empty(),
            "nothing is dropped just because it is unwanted"
        );
        assert_eq!(plan.fetch.len(), 1);
        assert_eq!(plan.fetch[0].tile, "new");
        // 49 + 49 + 1 + 70 = 169 > 100: the coldest goes first; 120 > 100: the next goes too; 71 fits
        assert_eq!(
            plan.fetch[0].evict_first,
            vec!["cold".to_string(), "warm".to_string()]
        );
    }

    #[test]
    fn a_package_that_does_not_fit_even_after_every_eviction_is_deferred_for_the_limit() {
        let offered = vec![offer("big", 10_000)];
        let stored = vec![record("home", 100, 0)];
        let wanted: BTreeSet<String> = ["big"].iter().map(|s| s.to_string()).collect();
        let protected: BTreeSet<String> = ["home"].iter().map(|s| s.to_string()).collect();
        let none = BTreeSet::new();
        let plan = plan_static_sync(&PlanInput {
            offered: &offered,
            stored: &stored,
            wanted: Some(&wanted),
            protected: &protected,
            urgent: &none,
            priority: &[],
            max_device_bytes: Some(1_000),
            metered_blocks: false,
            prune_unwanted: false,
        });
        assert!(
            plan.fetch.is_empty(),
            "nothing is evicted for a package that cannot fit anyway"
        );
        assert_eq!(
            plan.deferred,
            vec![("big".to_string(), DeferReason::StorageLimit)]
        );
    }

    #[test]
    fn a_metered_connection_lets_only_the_urgent_tile_through() {
        let offered = vec![offer("here", 10), offer("else", 10)];
        let urgent: BTreeSet<String> = ["here"].iter().map(|s| s.to_string()).collect();
        let none = BTreeSet::new();
        let plan = plan_static_sync(&PlanInput {
            offered: &offered,
            stored: &[],
            wanted: None,
            protected: &none,
            urgent: &urgent,
            priority: &[],
            max_device_bytes: None,
            metered_blocks: true,
            prune_unwanted: false,
        });
        assert_eq!(
            plan.fetch
                .iter()
                .map(|f| f.tile.as_str())
                .collect::<Vec<_>>(),
            ["here"]
        );
        assert_eq!(
            plan.deferred,
            vec![("else".to_string(), DeferReason::Metered)]
        );
    }

    // ------------------------------------------------ letting go of a package
    use crate::storage::{InMemoryStore, StoredEntities};
    use crate::sync::types::StaticSign;

    fn centre_of(tile: &str) -> (f64, f64) {
        let c = LatLng::from(parse_cell(tile).unwrap());
        (c.lat(), c.lng())
    }

    fn line(id: &str, from: (f64, f64), to: (f64, f64)) -> SpeedLimitSegment {
        SpeedLimitSegment {
            id: id.to_string(),
            geometry: Geometry::LineString {
                coordinates: vec![[from.1, from.0], [to.1, to.0]],
            },
            speed_limit: 50.0,
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

    fn sign_at(id: &str, at: (f64, f64)) -> StaticSign {
        StaticSign {
            id: id.to_string(),
            position: Geometry::Point {
                coordinates: [at.1, at.0],
            },
            sign_type: "DE:274".to_string(),
            source: "osm".to_string(),
            source_license: None,
            imported_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn letting_go_of_a_package_keeps_what_a_stored_neighbour_still_needs() {
        let a = tile(52.52, 13.405);
        let b = tile_disk(&a, 1).into_iter().find(|t| *t != a).unwrap();
        let (ca, cb) = (centre_of(&a), centre_of(&b));
        let near_a = (ca.0 + 0.0005, ca.1 + 0.0005);

        let store = InMemoryStore::new();
        let data = StoredEntities {
            speed_limit_segments: vec![
                line("only_a", ca, near_a),
                line("only_b", cb, (cb.0 + 0.0005, cb.1 + 0.0005)),
                line("a_to_b", ca, cb),
            ],
            static_signs: vec![sign_at("sign_a", ca), sign_at("sign_b", cb)],
            ..StoredEntities::default()
        };
        store.upsert_static_partition(&a, "ha", &data).unwrap();
        store
            .upsert_static_partition(&b, "hb", &StoredEntities::default())
            .unwrap();

        let removed = remove_partition(&store, &a).unwrap();

        let left = store.all_entities().unwrap();
        let segments: Vec<_> = left
            .speed_limit_segments
            .iter()
            .map(|s| s.id.as_str())
            .collect();
        assert!(
            !segments.contains(&"only_a"),
            "inside the package, nowhere else: gone"
        );
        assert!(segments.contains(&"only_b"), "not this package: kept");
        assert!(
            segments.contains(&"a_to_b"),
            "reaches into a stored neighbour: kept"
        );
        let signs: Vec<_> = left.static_signs.iter().map(|s| s.id.as_str()).collect();
        assert!(!signs.contains(&"sign_a"));
        assert!(signs.contains(&"sign_b"));
        assert_eq!(removed, 2);
        assert_eq!(store.get_partition_hash(&a).unwrap(), None);
        assert!(store.get_partition_hash(&b).unwrap().is_some());
    }

    #[test]
    fn a_segment_reaching_into_an_unstored_neighbour_is_kept_too() {
        let a = tile(52.52, 13.405);
        let b = tile_disk(&a, 1).into_iter().find(|t| *t != a).unwrap();
        let (ca, cb) = (centre_of(&a), centre_of(&b));
        let store = InMemoryStore::new();
        let data = StoredEntities {
            speed_limit_segments: vec![line("a_to_b", ca, cb)],
            ..StoredEntities::default()
        };
        store.upsert_static_partition(&a, "ha", &data).unwrap();
        // b is not stored: the road leaves the box of a, so it is not wholly inside it - kept (the safe error)
        remove_partition(&store, &a).unwrap();
        assert_eq!(store.all_entities().unwrap().speed_limit_segments.len(), 1);
    }

    #[test]
    fn the_device_estimate_follows_the_measured_ratio() {
        assert_eq!(estimated_device_bytes(1_000), 700);
        assert_eq!(estimated_device_bytes(0), 0);
    }
}
