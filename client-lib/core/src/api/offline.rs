//! The offline area through the public API (docs/offline-storage.md): what is kept on the device, what it costs,
//! how to change it, and whether a position is covered.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::platform::HttpRequest;
use crate::sync::offline::{
    load_settings, load_visited, note_visit, save_settings, save_visited, tile_of,
    AutoRegionPolicy, DeferReason, OfflineMode, OfflineSettings, DEVICE_BYTES_PER_JSON_BYTE,
};
use crate::sync::StaticSyncRequest;

use super::client::TrafficNetworkClient;
use super::error::{code, ApiError};

/// How many driven-through places are remembered at most.
const VISITED_KEPT: usize = 24;
/// A lookup in the same tile is noted as a use at most this often.
const USE_NOTE_INTERVAL_MS: i64 = 10 * 60 * 1000;

/// One entry of `GET /v1/static-data/regions`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ServerRegion {
    pub id: String,
    pub country: Option<String>,
    pub tile_count: u64,
    pub size_bytes: u64,
    pub gzip_bytes: u64,
    pub brotli_bytes: u64,
    #[serde(default)]
    pub complete: bool,
    pub bbox: [f64; 4],
    pub tiles: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegionsBody {
    static_data_version: u64,
    regions: Vec<ServerRegion>,
}

/// A region as a host app shows it: what it is, what it costs, whether it is chosen and how much of it is here.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionView {
    pub id: String,
    /// ISO 3166-1 alpha-2, or `null` for a coarse area (a server without country boundaries).
    pub country: Option<String>,
    pub tile_count: u64,
    /// What it takes on the wire (brotli, the best the server offers) and as JSON, and a device estimate.
    pub download_bytes: u64,
    pub size_bytes: u64,
    pub estimated_device_bytes: u64,
    /// `false`: the server has not built every compressed copy yet, the byte counts are lower bounds.
    pub complete: bool,
    /// `[west, south, east, north]`.
    pub bbox: [f64; 4],
    /// Chosen by the host app (mode `regions`), or covered by the mode (`all`).
    pub selected: bool,
    /// How many of its tiles are stored here.
    pub stored_tiles: u64,
    /// `"none"`, `"partial"` or `"complete"`.
    pub state: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoragePlanView {
    pub mode: OfflineMode,
    /// Automatic mode and the device knows neither where it is nor where home is: the host app has to ask for a
    /// region or a country (`setOfflineRegions`) or give a position.
    pub needs_location: bool,
    pub offered_tiles: usize,
    pub offered_bytes: u64,
    /// What a sync would fetch now (tiles, JSON bytes, estimated bytes on the device).
    pub to_fetch_tiles: usize,
    pub to_fetch_bytes: u64,
    pub to_fetch_device_bytes: u64,
    /// Let go of at once / kept as a cache until room is needed.
    pub to_remove_tiles: usize,
    pub cached_unwanted_tiles: usize,
    /// Wanted but not fetched: `metered` (held back on a metered connection) or `storageLimit` (does not fit).
    pub deferred_tiles: usize,
    pub deferred_for_limit: usize,
    pub deferred_for_metered: usize,
    pub max_bytes: Option<u64>,
    /// With the limit and what a sync would fetch.
    pub fits: bool,
    pub stored_tiles: usize,
    pub stored_device_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsageView {
    pub stored_tiles: usize,
    /// What the store occupies, as it can tell (the whole database file for SQLite).
    pub store_bytes: Option<u64>,
    /// The sum of the stored packages' sizes as JSON, and the estimate for the device.
    pub stored_json_bytes: u64,
    pub estimated_device_bytes: u64,
    pub max_bytes: Option<u64>,
    /// The packages, least recently used first.
    pub tiles: Vec<TileUsageView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileUsageView {
    pub tile: String,
    pub size_bytes: u64,
    pub last_used_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageView {
    /// The offline data answers for this position.
    pub covered: bool,
    pub tile: Option<String>,
    /// `"stored"`, `"wanted"` (chosen, not here yet) or `"outside"`.
    pub state: &'static str,
    /// A lookup here goes to the server (`lookupSpeedLimit` does it itself).
    pub uses_network: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OfflineSettingsPatch {
    pub mode: Option<OfflineMode>,
    pub regions: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoPolicyPatch {
    pub home_radius_tiles: Option<u32>,
    pub current_radius_tiles: Option<u32>,
    pub recent_places: Option<u32>,
    pub recent_radius_tiles: Option<u32>,
    pub home_lat: Option<f64>,
    pub home_lng: Option<f64>,
}

impl TrafficNetworkClient {
    // ------------------------------------------------------------ settings

    /// What the offline area is set to.
    pub fn get_offline_settings(&self) -> Result<OfflineSettings, ApiError> {
        self.check_open()?;
        Ok(load_settings(&*self.store))
    }

    /// Chooses what is kept: `auto` (default), `regions` (with the ids from `listOfflineRegions`) or `all`.
    /// Takes effect with the next sync (`tick`/`sync`); what is no longer wanted is let go of then.
    pub fn set_offline_regions(
        &self,
        patch: &OfflineSettingsPatch,
    ) -> Result<OfflineSettings, ApiError> {
        self.check_open()?;
        let mut settings = load_settings(&*self.store);
        if let Some(mode) = patch.mode {
            settings.mode = mode;
        }
        if let Some(regions) = &patch.regions {
            settings.regions = regions.clone();
            if patch.mode.is_none() && !regions.is_empty() {
                settings.mode = OfflineMode::Regions;
            }
        }
        save_settings(&*self.store, &settings)?;
        self.state().sync_due = true;
        Ok(settings)
    }

    /// How the automatic area is cut, and where home is.
    pub fn set_auto_region_policy(
        &self,
        patch: &AutoPolicyPatch,
    ) -> Result<OfflineSettings, ApiError> {
        self.check_open()?;
        let mut settings = load_settings(&*self.store);
        let mut policy: AutoRegionPolicy = settings.auto;
        if let Some(v) = patch.home_radius_tiles {
            policy.home_radius_tiles = v.min(10);
        }
        if let Some(v) = patch.current_radius_tiles {
            policy.current_radius_tiles = v.min(10);
        }
        if let Some(v) = patch.recent_places {
            policy.recent_places = v.min(VISITED_KEPT as u32);
        }
        if let Some(v) = patch.recent_radius_tiles {
            policy.recent_radius_tiles = v.min(10);
        }
        settings.auto = policy;
        match (patch.home_lat, patch.home_lng) {
            (Some(lat), Some(lng)) => {
                super::client::check_position_public(lat, lng)?;
                settings.home = Some((lat, lng));
            }
            (None, None) => {}
            _ => return Err(ApiError::invalid("give homeLat and homeLng together")),
        }
        save_settings(&*self.store, &settings)?;
        self.state().sync_due = true;
        Ok(settings)
    }

    /// The most the offline data may take on the device (`max_bytes`, `None` = no limit) and whether downloads
    /// other than the tile of the current position wait for an unmetered connection (see
    /// [`set_connection_metered`](Self::set_connection_metered)).
    pub fn set_storage_limits(
        &self,
        max_bytes: Option<Option<u64>>,
        wifi_only: Option<bool>,
    ) -> Result<OfflineSettings, ApiError> {
        self.check_open()?;
        let mut settings = load_settings(&*self.store);
        if let Some(max_bytes) = max_bytes {
            settings.max_bytes = max_bytes;
        }
        if let Some(wifi_only) = wifi_only {
            settings.wifi_only = wifi_only;
        }
        save_settings(&*self.store, &settings)?;
        self.state().sync_due = true;
        Ok(settings)
    }

    /// The host app knows what kind of connection it is on; the library cannot tell. Metered + `wifiOnly` (the
    /// default) holds back every download except the tile of the current position.
    pub fn set_connection_metered(&self, metered: bool) {
        let mut state = self.state();
        let changed = state.metered != metered;
        state.metered = metered;
        if changed && !metered {
            state.sync_due = true;
        }
    }

    // ------------------------------------------------------------ what a sync is told

    /// The request the static-data part of a sync is made with: settings, position, history, chosen regions.
    pub(super) async fn static_request(&self, token: &str) -> StaticSyncRequest {
        let settings = load_settings(&*self.store);
        let (current, metered) = {
            let state = self.state();
            (state.last_position, state.metered)
        };
        let region_tiles = if settings.mode == OfflineMode::Regions {
            match self.regions_cached_or_fetch(token).await {
                Ok(regions) => regions
                    .iter()
                    .filter(|r| settings.regions.contains(&r.id))
                    .flat_map(|r| r.tiles.iter().cloned())
                    .collect(),
                // Not known: keep what is there instead of acting on a guess (see `regions_unavailable`).
                Err(_) => BTreeSet::new(),
            }
        } else {
            BTreeSet::new()
        };
        StaticSyncRequest {
            settings,
            current,
            visited: load_visited(&*self.store),
            region_tiles,
            metered,
        }
    }

    // ------------------------------------------------------------ position bookkeeping

    /// Remembers where the device is: the automatic area follows it. Home is the first position seen, until the
    /// host app names one. Cheap; writes only when something changed.
    pub(super) fn note_position(&self, lat: f64, lng: f64) {
        let resolution = self
            .cached_config()
            .map(|c| c.static_data_partition_h3_resolution)
            .or_else(|| self.store.static_partition_resolution().ok().flatten())
            .unwrap_or(4);
        let now = self.now();
        let tile = tile_of(lat, lng, resolution);
        let (moved_tile, note_use) = {
            let mut state = self.state();
            state.last_position = Some((lat, lng));
            let moved = state.last_position_tile != tile;
            let note = moved || now - state.last_use_noted_ms >= USE_NOTE_INTERVAL_MS;
            if moved {
                state.last_position_tile = tile.clone();
            }
            if note {
                state.last_use_noted_ms = now;
            }
            (moved, note)
        };
        let Some(tile) = tile else { return };
        if moved_tile {
            // The next sync should look at what is wanted around the new place.
            self.state().sync_due = true;
            let mut history = load_visited(&*self.store);
            if note_visit(&mut history, &tile, now, VISITED_KEPT) {
                let _ = save_visited(&*self.store, &history);
            }
            let mut settings = load_settings(&*self.store);
            if settings.home.is_none() {
                settings.home = Some((lat, lng));
                let _ = save_settings(&*self.store, &settings);
            }
        }
        if note_use {
            let _ = self.store.record_partition_use(&[tile], now);
        }
    }

    // ------------------------------------------------------------ regions

    async fn regions_cached_or_fetch(&self, token: &str) -> Result<Vec<ServerRegion>, ApiError> {
        let version = self.cached_config().map(|c| c.static_data_version);
        if let Some((cached_version, regions)) = self.state().regions.clone() {
            if Some(cached_version) == version {
                return Ok(regions);
            }
        }
        let result = self
            .discovery
            .request_with_failover(|server| {
                let url = format!(
                    "{}/v1/static-data/regions",
                    server.address.trim_end_matches('/')
                );
                HttpRequest::get(url).with_header("Authorization", format!("Bearer {token}"))
            })
            .await
            .map_err(ApiError::from)?;
        let (_, response) = result;
        if response.status == 404 {
            return Err(ApiError::new(
                code::NOT_OFFERED,
                "this server does not list offline regions (it predates server 1.1.0)",
            ));
        }
        if !response.is_success() {
            return Err(ApiError::new(
                code::NETWORK,
                format!("regions: HTTP {}", response.status),
            ));
        }
        let body: RegionsBody = response
            .json()
            .ok()
            .and_then(|v| serde_json::from_value(v).ok())
            .ok_or_else(|| ApiError::new(code::NETWORK, "regions: unexpected answer"))?;
        self.state().regions = Some((
            version.unwrap_or(body.static_data_version),
            body.regions.clone(),
        ));
        Ok(body.regions)
    }

    /// The countries/regions the server offers, with sizes, what is chosen and how much is stored here. Needs the
    /// network (and a server from 1.1.0 on: `notOffered` otherwise).
    pub async fn list_offline_regions(&self) -> Result<Vec<RegionView>, ApiError> {
        self.check_open()?;
        let token = self.ensure_token().await?;
        let regions = self.regions_cached_or_fetch(&token).await?;
        let settings = load_settings(&*self.store);
        let stored: BTreeSet<String> = self
            .store
            .partition_records()?
            .into_iter()
            .map(|r| r.tile)
            .collect();
        Ok(regions
            .into_iter()
            .map(|r| {
                let stored_tiles = r.tiles.iter().filter(|t| stored.contains(*t)).count() as u64;
                let state = if stored_tiles == 0 {
                    "none"
                } else if stored_tiles >= r.tile_count {
                    "complete"
                } else {
                    "partial"
                };
                let selected = match settings.mode {
                    OfflineMode::All => true,
                    OfflineMode::Regions => settings.regions.contains(&r.id),
                    OfflineMode::Auto => false,
                };
                RegionView {
                    download_bytes: if r.brotli_bytes > 0 {
                        r.brotli_bytes
                    } else {
                        r.gzip_bytes
                    },
                    estimated_device_bytes: (r.size_bytes as f64 * DEVICE_BYTES_PER_JSON_BYTE)
                        .round() as u64,
                    id: r.id,
                    country: r.country,
                    tile_count: r.tile_count,
                    size_bytes: r.size_bytes,
                    complete: r.complete,
                    bbox: r.bbox,
                    selected,
                    stored_tiles,
                    state,
                }
            })
            .collect())
    }

    // ------------------------------------------------------------ plan, usage, coverage

    /// What the offline area would do on the next sync, before it does it: how much to fetch (JSON bytes and
    /// the estimate for the device), what to let go of, what does not fit or waits for an unmetered connection.
    /// Costs one manifest request.
    pub async fn get_storage_plan(&self) -> Result<StoragePlanView, ApiError> {
        self.check_open()?;
        let token = self.ensure_token().await?;
        let request = self.static_request(&token).await;
        let plan = self.engine.plan_static_sync_for(&token, &request).await?;
        let records = self.store.partition_records()?;
        let stored_device: u64 = records
            .iter()
            .map(|r| (r.size_bytes as f64 * DEVICE_BYTES_PER_JSON_BYTE).round() as u64)
            .sum();
        let to_fetch_device_bytes =
            (plan.bytes_to_fetch as f64 * DEVICE_BYTES_PER_JSON_BYTE).round() as u64;
        let removed_device: u64 = records
            .iter()
            .filter(|r| plan.remove_tiles.contains(&r.tile) || plan.evict_tiles.contains(&r.tile))
            .map(|r| (r.size_bytes as f64 * DEVICE_BYTES_PER_JSON_BYTE).round() as u64)
            .sum();
        let after = stored_device.saturating_sub(removed_device) + to_fetch_device_bytes;
        let for_limit = plan
            .deferred
            .iter()
            .filter(|(_, why)| *why == DeferReason::StorageLimit)
            .count();
        let for_metered = plan.deferred.len() - for_limit;
        let cached_unwanted = records
            .iter()
            .filter(|r| {
                !plan.remove_tiles.contains(&r.tile)
                    && request.settings.mode == OfflineMode::Auto
                    && !self.is_wanted_hint(&request, &r.tile)
            })
            .count();
        Ok(StoragePlanView {
            mode: request.settings.mode,
            needs_location: plan.needs_location,
            offered_tiles: plan.offered_tiles,
            offered_bytes: plan.offered_bytes,
            to_fetch_tiles: plan.fetch_tiles.len(),
            to_fetch_bytes: plan.bytes_to_fetch,
            to_fetch_device_bytes,
            to_remove_tiles: plan.remove_tiles.len(),
            cached_unwanted_tiles: cached_unwanted,
            deferred_tiles: plan.deferred.len(),
            deferred_for_limit: for_limit,
            deferred_for_metered: for_metered,
            max_bytes: request.settings.max_bytes,
            fits: request
                .settings
                .max_bytes
                .is_none_or(|limit| after <= limit)
                && for_limit == 0,
            stored_tiles: records.len(),
            stored_device_bytes: self.store.storage_bytes(),
        })
    }

    /// A rough "is this tile in the wanted area": only used for the cache count of the plan view.
    fn is_wanted_hint(&self, request: &StaticSyncRequest, tile: &str) -> bool {
        let resolution = self
            .cached_config()
            .map(|c| c.static_data_partition_h3_resolution)
            .unwrap_or(4);
        let auto = crate::sync::offline::auto_selection(
            &request.settings.auto,
            resolution,
            request.settings.home,
            request.current,
            &request.visited,
        );
        auto.all().contains(tile)
    }

    /// What is stored and what it takes. No network.
    pub fn get_storage_usage(&self) -> Result<StorageUsageView, ApiError> {
        self.check_open()?;
        let mut records = self.store.partition_records()?;
        records.sort_by(|a, b| {
            a.last_used_unix_ms
                .cmp(&b.last_used_unix_ms)
                .then_with(|| a.tile.cmp(&b.tile))
        });
        let json: u64 = records.iter().map(|r| r.size_bytes).sum();
        Ok(StorageUsageView {
            stored_tiles: records.len(),
            store_bytes: self.store.storage_bytes(),
            stored_json_bytes: json,
            estimated_device_bytes: (json as f64 * DEVICE_BYTES_PER_JSON_BYTE).round() as u64,
            max_bytes: load_settings(&*self.store).max_bytes,
            tiles: records
                .into_iter()
                .map(|r| TileUsageView {
                    tile: r.tile,
                    size_bytes: r.size_bytes,
                    last_used_unix_ms: (r.last_used_unix_ms > 0).then_some(r.last_used_unix_ms),
                })
                .collect(),
        })
    }

    /// Whether the offline data answers for a position: `stored`, `wanted` (chosen — in the area as it is cut now —
    /// but not here yet) or `outside` (a lookup there goes to the server). No network.
    pub fn get_coverage(&self, lat: f64, lng: f64) -> Result<CoverageView, ApiError> {
        self.check_open()?;
        super::client::check_position_public(lat, lng)?;
        let resolution = self
            .cached_config()
            .map(|c| c.static_data_partition_h3_resolution)
            .or_else(|| self.store.static_partition_resolution().ok().flatten())
            .unwrap_or(4);
        let Some(tile) = tile_of(lat, lng, resolution) else {
            return Ok(CoverageView {
                covered: false,
                tile: None,
                state: "outside",
                uses_network: true,
            });
        };
        if self.store.get_partition_hash(&tile)?.is_some() {
            return Ok(CoverageView {
                covered: true,
                tile: Some(tile),
                state: "stored",
                uses_network: false,
            });
        }
        let settings = load_settings(&*self.store);
        let wanted = match settings.mode {
            OfflineMode::All => true,
            OfflineMode::Regions => false, // which tiles the regions hold is the server's to say
            OfflineMode::Auto => {
                let visited = load_visited(&*self.store);
                // What the automatic area holds *now*: around where the device last said it was, not around
                // the place asked about (that would call every place "wanted").
                let current = self.state().last_position;
                let auto = crate::sync::offline::auto_selection(
                    &settings.auto,
                    resolution,
                    settings.home,
                    current,
                    &visited,
                );
                auto.all().contains(&tile)
            }
        };
        Ok(CoverageView {
            covered: false,
            tile: Some(tile),
            state: if wanted { "wanted" } else { "outside" },
            uses_network: true,
        })
    }
}
