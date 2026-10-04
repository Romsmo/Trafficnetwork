//! The country-based camera policy, as far as a client can honour it
//! (`server/docs/camera-country-policy.md` is the wire contract this mirrors).
//!
//! The server decides, per camera, which country it is in and what that
//! country allows (`off`, `zones`, `full`) — it stores one country set per
//! camera and projects every answer through one delivery layer, so a client
//! receives only what its camera's country permits: individual cameras, or
//! *zones* (cells of a coarse fixed grid, never a coordinate finer than the
//! cell). A client has no country boundaries and so cannot re-derive that
//! decision per item; what it can and does do:
//!
//! * read the effective policy from `GET /v1/config` (`cameraPolicy`), take
//!   the *stricter* of that and the verified signed network configuration,
//!   and show nothing at all while the emergency brake is on or every level
//!   is `off` ([`effective_camera_policy`]);
//! * show zones as areas and individual cameras only as long as some country
//!   is at `full`;
//! * remove what it stored locally when the policy gets stricter than the one
//!   it stored the data under, and have the packages that held it fetched
//!   again ([`purge_camera_data`]);
//! * hand the host app the level and the legal notice
//!   ([`EffectiveCameraPolicy`], [`CameraNotice`]).
//!
//! Nothing here releases anything: a missing, malformed or unknown value is
//! read as `off`.

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use h3o::{CellIndex, LatLng, Resolution};
use serde::{Deserialize, Serialize};

use super::types::{ClientConfig, HazardType, NetworkConfigPayload};
use crate::storage::{Store, StoreError};

/// How much of a camera a country allows. `Off < Zones < Full`: a smaller
/// level is a stricter one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CameraLevel {
    /// Nothing is delivered.
    Off,
    /// Only coarse zones, never an individual camera.
    Zones,
    /// Individual cameras, like any other category.
    Full,
}

impl CameraLevel {
    /// Reads the wire text. Anything that is not exactly `zones` or `full`
    /// (an empty string, a level a newer server invented) is `Off`.
    pub fn from_wire(text: &str) -> CameraLevel {
        match text.trim().to_ascii_lowercase().as_str() {
            "full" => CameraLevel::Full,
            "zones" => CameraLevel::Zones,
            _ => CameraLevel::Off,
        }
    }
}

/// The short legal notice a host app shows before it lets a user switch the
/// camera display on: `text` is keyed by language (`de`, `en`, …).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CameraNotice {
    /// Grows whenever the wording changes — a host that remembers the version
    /// a user has seen can show the notice again exactly then.
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub text: BTreeMap<String, String>,
}

impl CameraNotice {
    /// The wording the library falls back to when the server sends none. It
    /// is a pointer to the law, not a legal assessment.
    pub fn built_in() -> CameraNotice {
        let mut text = BTreeMap::new();
        text.insert(
            "de".to_string(),
            "Hinweis: Die Nutzung von Blitzer-Daten während der Fahrt ist in mehreren Ländern \
             verboten — in Deutschland auch für Beifahrer, in der Schweiz sind selbst bloße \
             Hinweise unzulässig. Nutze die Anzeige nur, wenn du nicht fährst, und informiere \
             dich über die Regeln des Landes, in dem du unterwegs bist."
                .to_string(),
        );
        text.insert(
            "en".to_string(),
            "Notice: Using speed-camera data while driving is forbidden in several countries — \
             in Germany also for passengers, and in Switzerland even mere hints are unlawful. \
             Use the display only when you are not driving, and check the rules of the country \
             you are in."
                .to_string(),
        );
        CameraNotice { version: 0, text }
    }
}

/// `cameraPolicy` of `GET /v1/config`. Every field defaults to the strictest
/// reading, so an object of an unexpected shape never opens anything.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CameraPolicyConfig {
    /// Changes whenever the node's effective policy changes.
    #[serde(default)]
    pub version: String,
    /// The emergency brake is released (`false`: every country is off).
    #[serde(rename = "namespaceEnabled", default)]
    pub namespace_enabled: bool,
    /// The level of every country not in `by_country`.
    #[serde(rename = "defaultLevel", default)]
    pub default_level: String,
    /// The node's *effective* levels (network policy, local caps and brake
    /// already applied), ISO 3166-1 alpha-2 → level text.
    #[serde(rename = "byCountry", default)]
    pub by_country: BTreeMap<String, String>,
    /// The H3 resolution zones are cut at on this node.
    #[serde(rename = "zoneResolution", default)]
    pub zone_resolution: Option<u8>,
    #[serde(default)]
    pub notice: Option<CameraNotice>,
}

/// What a client works with: the brake, the level of the countries not listed
/// and the levels of those that are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectiveCameraPolicy {
    /// `false`: the emergency brake is on, every country is `off`.
    pub enabled: bool,
    #[serde(rename = "defaultLevel")]
    pub default_level: CameraLevel,
    #[serde(rename = "byCountry")]
    pub by_country: BTreeMap<String, CameraLevel>,
}

impl EffectiveCameraPolicy {
    /// Nothing is allowed anywhere.
    pub fn off() -> Self {
        EffectiveCameraPolicy {
            enabled: false,
            default_level: CameraLevel::Off,
            by_country: BTreeMap::new(),
        }
    }

    /// Individual cameras everywhere — what a server that predates the
    /// country policy means by "the camera namespace is on".
    pub fn unrestricted() -> Self {
        EffectiveCameraPolicy {
            enabled: true,
            default_level: CameraLevel::Full,
            by_country: BTreeMap::new(),
        }
    }

    fn base_level(&self) -> CameraLevel {
        if self.enabled {
            self.default_level
        } else {
            CameraLevel::Off
        }
    }

    /// The level of one country (ISO 3166-1 alpha-2).
    pub fn level_of(&self, country: &str) -> CameraLevel {
        if !self.enabled {
            return CameraLevel::Off;
        }
        self.by_country
            .get(&country.to_ascii_uppercase())
            .copied()
            .unwrap_or(self.default_level)
    }

    /// The most a client may show anywhere: `Off` shows nothing, `Zones`
    /// only zones, `Full` individual cameras too.
    pub fn max_level(&self) -> CameraLevel {
        if !self.enabled {
            return CameraLevel::Off;
        }
        self.by_country
            .values()
            .copied()
            .fold(self.default_level, CameraLevel::max)
    }

    /// Whether this policy lets less through than `before` did, anywhere —
    /// the brake coming on, or any country (or the default) getting a
    /// smaller level.
    pub fn is_stricter_than(&self, before: &EffectiveCameraPolicy) -> bool {
        if self.base_level() < before.base_level() {
            return true;
        }
        self.by_country
            .keys()
            .chain(before.by_country.keys())
            .any(|country| self.level_of(country) < before.level_of(country))
    }
}

/// The policy a client works with, from the node's `GET /v1/config` and the
/// signed network configuration **if** its signature verified (pass `None`
/// otherwise). Always the strictest reading:
///
/// * a server without `cameraPolicy` has one switch for everything;
/// * the node's brake (`namespaceEnabled`, `speedCameraNamespaceEnabled`) and
///   the network's (`blitzerEnabled`) must all be released;
/// * a country the signed network policy lists is at most that level, however
///   generous the node's own claim.
pub fn effective_camera_policy(
    config: &ClientConfig,
    verified_network: Option<&NetworkConfigPayload>,
) -> EffectiveCameraPolicy {
    let network_brake_released = verified_network.is_none_or(|network| network.blitzer_enabled);
    let Some(node) = &config.camera_policy else {
        return if config.speed_camera_namespace_enabled && network_brake_released {
            EffectiveCameraPolicy::unrestricted()
        } else {
            EffectiveCameraPolicy::off()
        };
    };
    if !(node.namespace_enabled && config.speed_camera_namespace_enabled && network_brake_released)
    {
        return EffectiveCameraPolicy::off();
    }
    let default_level = CameraLevel::from_wire(&node.default_level);
    let mut by_country: BTreeMap<String, CameraLevel> = node
        .by_country
        .iter()
        .map(|(country, level)| (country.to_ascii_uppercase(), CameraLevel::from_wire(level)))
        .collect();
    if let Some(signed) = verified_network.and_then(|n| n.camera_policy_by_country.as_ref()) {
        for (country, level) in signed {
            let country = country.to_ascii_uppercase();
            let signed_level = CameraLevel::from_wire(level);
            let node_level = by_country.get(&country).copied().unwrap_or(default_level);
            by_country.insert(country, node_level.min(signed_level));
        }
    }
    EffectiveCameraPolicy {
        enabled: true,
        default_level,
        by_country,
    }
}

// ------------------------------------------------------------------- zones

/// The outline of a zone: a GeoJSON `Polygon`, `[lng, lat]` positions, the
/// outer ring first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZoneBoundary {
    #[serde(rename = "type", default)]
    pub kind: String,
    pub coordinates: Vec<Vec<[f64; 2]>>,
}

/// A coarse area in which cameras of some kinds exist — all a client learns
/// about the cameras of a country at level `zones`. There is deliberately no
/// position, id, count or time of a single camera in it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CameraZone {
    /// Derived from the cell, identical on every node.
    pub id: String,
    /// The H3 index of the cell.
    pub cell: String,
    pub resolution: u8,
    pub boundary: ZoneBoundary,
    /// Sorted; the kinds of camera present in the cell.
    #[serde(rename = "cameraTypes", default)]
    pub camera_types: Vec<String>,
    /// `"removed"` only inside events.
    #[serde(default = "active_status")]
    pub status: String,
}

fn active_status() -> String {
    "active".to_string()
}

const METERS_PER_DEGREE: f64 = 111_320.0;

impl CameraZone {
    /// `0` for a point inside the zone, otherwise the distance in metres to
    /// its nearest edge (a flat projection around the point — the zones are a
    /// few kilometres across). Infinite for a zone without a usable outline.
    pub fn distance_meters(&self, lat: f64, lng: f64) -> f64 {
        let Some(ring) = self.boundary.coordinates.first() else {
            return f64::INFINITY;
        };
        if ring.len() < 3 {
            return f64::INFINITY;
        }
        if point_in_ring(ring, lat, lng) {
            return 0.0;
        }
        let cos_lat = lat.to_radians().cos().abs().max(0.01);
        let to_xy = |p: &[f64; 2]| {
            (
                (p[0] - lng) * METERS_PER_DEGREE * cos_lat,
                (p[1] - lat) * METERS_PER_DEGREE,
            )
        };
        let mut nearest = f64::INFINITY;
        for index in 0..ring.len() {
            let a = to_xy(&ring[index]);
            let b = to_xy(&ring[(index + 1) % ring.len()]);
            nearest = nearest.min(distance_to_segment_from_origin(a, b));
        }
        nearest
    }

    /// The zone's outline as `[lng, lat]` positions (the outer ring).
    pub fn outline(&self) -> Vec<[f64; 2]> {
        self.boundary
            .coordinates
            .first()
            .cloned()
            .unwrap_or_default()
    }

    /// The same zone with the camera kinds of `other` added — packages hold
    /// the persistent devices only, snapshots and events also the live
    /// reports of the cell, so a client keeps the union (the server says so).
    pub fn united_with(&self, other: &CameraZone) -> CameraZone {
        let types: BTreeSet<String> = self
            .camera_types
            .iter()
            .chain(other.camera_types.iter())
            .cloned()
            .collect();
        CameraZone {
            camera_types: types.into_iter().collect(),
            ..other.clone()
        }
    }
}

/// Ray casting on `[lng, lat]` positions.
fn point_in_ring(ring: &[[f64; 2]], lat: f64, lng: f64) -> bool {
    let mut inside = false;
    let mut previous = ring.len() - 1;
    for current in 0..ring.len() {
        let (xi, yi) = (ring[current][0], ring[current][1]);
        let (xj, yj) = (ring[previous][0], ring[previous][1]);
        if (yi > lat) != (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        previous = current;
    }
    inside
}

/// Distance from the origin to the segment `a`–`b`.
fn distance_to_segment_from_origin(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let length_squared = dx * dx + dy * dy;
    let t = if length_squared == 0.0 {
        0.0
    } else {
        (-(a.0 * dx + a.1 * dy) / length_squared).clamp(0.0, 1.0)
    };
    let (x, y) = (a.0 + t * dx, a.1 + t * dy);
    (x * x + y * y).sqrt()
}

// ------------------------------------------------------------------- purge

fn tile_of_position(lat: f64, lng: f64, resolution: u8) -> Option<String> {
    let resolution = Resolution::try_from(resolution).ok()?;
    let position = LatLng::new(lat, lng).ok()?;
    Some(format!("{:x}", u64::from(position.to_cell(resolution))))
}

fn parent_tile_of_cell(cell: &str, resolution: u8) -> Option<String> {
    let cell = CellIndex::from_str(cell).ok()?;
    let resolution = Resolution::try_from(resolution).ok()?;
    let parent = cell.parent(resolution)?;
    Some(format!("{:x}", u64::from(parent)))
}

/// Removes every camera the client holds — the persistent cameras, the zones
/// and the stored reports of camera types — and blanks the recorded hash of
/// each static package that held cameras or zones, so the next sync fetches
/// exactly those packages again (they were rebuilt under the new policy).
/// Returns how many items were removed.
///
/// Used when the policy got stricter than the one the data was stored under:
/// the client cannot tell which country a stored camera is in, and a package
/// that was rebuilt without a camera does not remove it from the store
/// (packages only add), so what was stored is dropped as a whole and
/// re-learned under the new rules. Reports reappear with the next change or
/// snapshot.
pub fn purge_camera_data(
    store: &dyn Store,
    camera_hazard_types: &[HazardType],
) -> Result<usize, StoreError> {
    let resolution = store.static_partition_resolution()?;
    let cameras = store.fixed_speed_cameras()?;
    let zones = store.camera_zones()?;
    let mut tiles: BTreeSet<String> = BTreeSet::new();
    let mut removed = 0;

    for camera in &cameras {
        if let (Some(resolution), Some((lat, lng))) = (resolution, camera.position.as_lat_lng()) {
            if let Some(tile) = tile_of_position(lat, lng, resolution) {
                tiles.insert(tile);
            }
        }
        store.remove_static_entity("fixedSpeedCamera", &camera.id)?;
        removed += 1;
    }
    for zone in &zones {
        if let Some(resolution) = resolution {
            if let Some(tile) = parent_tile_of_cell(&zone.cell, resolution) {
                tiles.insert(tile);
            }
        }
        store.remove_static_entity("cameraZone", &zone.id)?;
        removed += 1;
    }
    for tile in &tiles {
        store.set_partition_hash(tile, "")?;
    }
    for report in store.hazard_reports()? {
        if camera_hazard_types.contains(&report.hazard_type) || is_camera_hazard(report.hazard_type)
        {
            store.remove_hazard_report(&report.id)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// The five camera kinds, whatever a server's `cameraNamespaceHazardTypes`
/// says (it only ever lists these, but a purge must not depend on that).
fn is_camera_hazard(hazard_type: HazardType) -> bool {
    matches!(
        hazard_type,
        HazardType::FixedSpeedCamera
            | HazardType::MobileSpeedCamera
            | HazardType::TrailerCamera
            | HazardType::RedLightCamera
            | HazardType::DistanceControl
    )
}

#[cfg(test)]
#[path = "camera_policy_tests.rs"]
mod tests;
