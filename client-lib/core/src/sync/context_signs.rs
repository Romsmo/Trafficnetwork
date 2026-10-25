//! Context signs, client side (server 1.4.0; the design is `server/docs/context-signs.md`).
//!
//! Traffic signs that apply on a stretch of road, with a direction and a validity in time, entered by people and confirmed by other
//! devices. This module is everything except the arithmetic of "what applies here" (that is [`super::context_sign_eval`]):
//!
//! * the entries as the server delivers them, and the **offline copy** of them — per H3 tile, in the store's settings, refreshed by
//!   [`sync_context_signs`] for the tiles the device has packages for and the tiles around it (a few KB per tile);
//! * [`resolve_context_sign`] — online only: which stretch of road the picked points mean, and which entries are the same or similar;
//! * [`queue_context_sign_proposal`] and [`queue_context_sign_vote`] — **queued** like every other write, signed with the device key
//!   when they are sent ([`flush_context_sign_write`]), so they survive being offline and a restart.
//!
//! The entries are not part of the static-data packages (that would change their fingerprint and force a rebuild on every node);
//! they have a small interface of their own, `GET /v1/context-signs/tiles`, with a version that is unchanged while nothing changed.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::crypto::{sign_envelope, Ed25519KeyPair};
use crate::discovery::{DiscoveryError, DiscoveryService};
use crate::platform::{Clock, HttpRequest, HttpResponse};
use crate::storage::{PendingWrite, Store, StoreError, WriteKind};

use super::intervals::IntervalPoint;
use super::writebuffer::{local_write_id, unix_ms_to_rfc3339, FlushOutcome, WriteBufferError};

/// The store setting the offline copy lives in.
pub const SETTINGS_KEY: &str = "contextSigns.v1";
/// The server's largest accepted `tiles` list.
const MAX_TILES_PER_REQUEST: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    /// Only while driving along the stretch as stored (first vertex to last).
    Along,
    /// Both ways.
    Both,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeWindow {
    /// ISO weekdays, 1 = Monday ... 7 = Sunday.
    pub days: Vec<u8>,
    /// Local wall-clock "HH:MM"; `from > to` crosses midnight and belongs to the day it starts on.
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Period {
    pub from: String,
    /// `null`: until revoked.
    pub to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Validity {
    #[serde(default = "one")]
    pub v: u8,
    /// IANA zone the windows and dates are read in.
    pub tz: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<Vec<TimeWindow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period: Option<Period>,
}

fn one() -> u8 {
    1
}

/// An entry as the server delivers it (`GET /v1/context-signs`, `.../tiles`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSignEntry {
    /// The key votes and signatures refer to: a hash of the entry's content.
    pub id: String,
    pub sign_type: String,
    /// `[lng, lat]` vertices in the direction of travel the sign applies in.
    pub geometry: Vec<[f64; 2]>,
    pub direction: Direction,
    pub validity: Validity,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub length_m: f64,
    pub status: String,
    #[serde(default)]
    pub confirmed: bool,
    #[serde(default)]
    pub confirmations: u32,
    #[serde(default)]
    pub denials: u32,
    #[serde(default)]
    pub last_confirmed_at: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
}

impl ContextSignEntry {
    /// The descriptor a device signs for this entry: exactly what defines it (its hash is `id`).
    pub fn descriptor(&self) -> Value {
        json!({
            "v": 1,
            "signType": self.sign_type,
            "geometry": self.geometry,
            "direction": self.direction,
            "validity": self.validity,
            "value": self.value,
            "unit": self.unit,
        })
    }
}

// ---------------------------------------------------------------- errors

#[derive(Debug, Clone, PartialEq)]
pub enum ContextSignError {
    /// The server does not offer context signs (an older server, or the operator switched them off).
    NotOffered,
    /// The server refused with a code of its own (`NO_ROAD_FOUND`, `UNKNOWN_SIGN`, ...).
    Refused {
        status: u16,
        code: String,
        message: String,
    },
    Transport(String),
    /// A local storage failure.
    Store(String),
    /// The local store is out of space.
    StorageFull,
    /// The request itself is not acceptable (checked before anything is sent).
    Invalid(String),
}

impl From<DiscoveryError> for ContextSignError {
    fn from(error: DiscoveryError) -> Self {
        ContextSignError::Transport(error.to_string())
    }
}

impl From<StoreError> for ContextSignError {
    fn from(error: StoreError) -> Self {
        if crate::storage::is_storage_full(&error) {
            ContextSignError::StorageFull
        } else {
            ContextSignError::Store(error.to_string())
        }
    }
}

fn refusal(response: &HttpResponse) -> ContextSignError {
    let body = response.json().ok();
    let error = body.as_ref().and_then(|v| v.get("error"));
    let text = |key: &str| {
        error
            .and_then(|e| e.get(key))
            .and_then(|c| c.as_str())
            .map(str::to_string)
    };
    ContextSignError::Refused {
        status: response.status,
        code: text("code").unwrap_or_else(|| format!("HTTP_{}", response.status)),
        message: text("message").unwrap_or_else(|| format!("HTTP {}", response.status)),
    }
}

// ---------------------------------------------------------------- the offline copy

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct StoredTile {
    /// The server's version of the delivered set when this tile was fetched.
    version: u64,
    entries: Vec<ContextSignEntry>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct StoredData {
    tiles: BTreeMap<String, StoredTile>,
}

fn load(store: &dyn Store) -> StoredData {
    store
        .get_setting(SETTINGS_KEY)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(store: &dyn Store, data: &StoredData) -> Result<(), StoreError> {
    if data.tiles.is_empty() {
        return store.set_setting(SETTINGS_KEY, "{\"tiles\":{}}");
    }
    let text = serde_json::to_string(data).map_err(|e| StoreError::from(e.to_string()))?;
    store.set_setting(SETTINGS_KEY, &text)
}

/// Every entry held, once each (an entry that touches several tiles is stored with each).
pub fn stored_entries(store: &dyn Store) -> Vec<ContextSignEntry> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for tile in load(store).tiles.into_values() {
        for entry in tile.entries {
            if seen.insert(entry.id.clone()) {
                out.push(entry);
            }
        }
    }
    out
}

/// The tiles the offline copy holds.
pub fn stored_tiles(store: &dyn Store) -> BTreeSet<String> {
    load(store).tiles.into_keys().collect()
}

pub fn find_stored_entry(store: &dyn Store, id: &str) -> Option<ContextSignEntry> {
    stored_entries(store).into_iter().find(|e| e.id == id)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct ContextSignSyncOutcome {
    /// Tiles held after the sync.
    pub tiles: usize,
    /// Entries held after the sync.
    pub entries: usize,
    /// Something was downloaded or dropped.
    pub changed: bool,
    /// The server answered that it has no context signs; the copy was emptied.
    pub not_offered: bool,
}

#[derive(Debug, Deserialize)]
struct TilesAnswer {
    version: u64,
    #[serde(default)]
    unchanged: bool,
    #[serde(default)]
    tiles: Vec<TileAnswer>,
}

#[derive(Debug, Deserialize)]
struct TileAnswer {
    tile: String,
    #[serde(default)]
    entries: Vec<Value>,
}

/// Brings the offline copy in line with the server for the `wanted` tiles: tiles nobody wants any more are let go, tiles that are
/// new or whose version moved are downloaded. While the server's version is the one held the answer is a few bytes.
pub async fn sync_context_signs(
    store: &dyn Store,
    discovery: &DiscoveryService,
    bearer_token: &str,
    wanted: &BTreeSet<String>,
) -> Result<ContextSignSyncOutcome, ContextSignError> {
    let before = load(store);
    let mut data = before.clone();
    data.tiles.retain(|tile, _| wanted.contains(tile));

    let wanted: Vec<&String> = wanted.iter().collect();
    for chunk in wanted.chunks(MAX_TILES_PER_REQUEST) {
        let joined = chunk
            .iter()
            .map(|t| t.as_str())
            .collect::<Vec<_>>()
            .join(",");
        // "unchanged since version v" only means something if every tile of the request is held at v
        let held: Vec<u64> = chunk
            .iter()
            .filter_map(|t| data.tiles.get(t.as_str()).map(|t| t.version))
            .collect();
        let since = (held.len() == chunk.len())
            .then(|| held.iter().copied().min())
            .flatten();
        let query = match since {
            Some(v) => format!("tiles={joined}&since={v}"),
            None => format!("tiles={joined}"),
        };
        let (_, response) = discovery
            .request_with_failover(|server| {
                HttpRequest::get(format!(
                    "{}/v1/context-signs/tiles?{query}",
                    server.address.trim_end_matches('/')
                ))
                .with_header("Authorization", format!("Bearer {bearer_token}"))
            })
            .await?;
        if response.status == 404 {
            // not offered here: what was held is no longer true
            let had = !before.tiles.is_empty();
            save(store, &StoredData::default())?;
            return Ok(ContextSignSyncOutcome {
                tiles: 0,
                entries: 0,
                changed: had,
                not_offered: true,
            });
        }
        if !response.is_success() {
            return Err(refusal(&response));
        }
        let answer: TilesAnswer = response
            .json()
            .ok()
            .and_then(|v| serde_json::from_value(v).ok())
            .ok_or_else(|| {
                ContextSignError::Transport("unexpected context-signs body".to_string())
            })?;
        if answer.unchanged {
            continue;
        }
        for tile in answer.tiles {
            if !wanted.iter().any(|w| **w == tile.tile) {
                continue;
            }
            let entries = tile
                .entries
                .into_iter()
                .filter_map(|v| serde_json::from_value(v).ok())
                .collect();
            data.tiles.insert(
                tile.tile,
                StoredTile {
                    version: answer.version,
                    entries,
                },
            );
        }
    }

    let changed = serde_json::to_string(&data).ok() != serde_json::to_string(&before).ok();
    if changed {
        save(store, &data)?;
    }
    Ok(ContextSignSyncOutcome {
        tiles: data.tiles.len(),
        entries: data.tiles.values().map(|t| t.entries.len()).sum(),
        changed,
        not_offered: false,
    })
}

/// The tiles whose context signs the device keeps: those it holds static-data packages for (its offline area) and the ones around
/// its position. `resolution` is the server's `staticDataPartitionH3Resolution`.
pub fn wanted_tiles(
    store: &dyn Store,
    resolution: u8,
    position: Option<(f64, f64)>,
) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = store
        .partition_records()
        .map(|records| records.into_iter().map(|r| r.tile).collect())
        .unwrap_or_default();
    if let Some((lat, lng)) = position {
        out.extend(crate::api::tiles::tiles_around(lat, lng, resolution, 1));
    }
    out
}

// ---------------------------------------------------------------- resolve (online)

/// What a person picked: the sign, where, which way, when. Sent to the node, which finds the road.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSignRequest {
    /// `DE:276`.
    pub sign_type: String,
    /// The start of the stretch (or the place of a sign that stands at one place).
    pub from: PointJson,
    /// The end of the stretch; `None` for a sign at one place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<PointJson>,
    /// `along` or `both` (default `both`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<Direction>,
    /// Direction of travel in degrees, for a sign at one place that applies one way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading: Option<f64>,
    /// `{ windows?: [{ days, from, to }], period?: { from, to }, tz? }` - see the server's `api.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validity: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PointJson {
    pub lat: f64,
    pub lng: f64,
}

impl ContextSignRequest {
    fn validate(&self) -> Result<(), ContextSignError> {
        let ok = |p: &PointJson| {
            IntervalPoint {
                lat: p.lat,
                lng: p.lng,
            }
            .is_valid()
        };
        if self.sign_type.trim().is_empty() {
            return Err(ContextSignError::Invalid(
                "name the sign (for example DE:276)".to_string(),
            ));
        }
        if !ok(&self.from) || self.to.as_ref().is_some_and(|p| !ok(p)) {
            return Err(ContextSignError::Invalid(
                "the position is not valid".to_string(),
            ));
        }
        if self
            .heading
            .is_some_and(|h| !h.is_finite() || !(0.0..=360.0).contains(&h))
        {
            return Err(ContextSignError::Invalid(
                "heading must be between 0 and 360 degrees".to_string(),
            ));
        }
        if self.value.is_some_and(|v| !v.is_finite()) {
            return Err(ContextSignError::Invalid(
                "the value is not a number".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSignRoad {
    pub name: Option<String>,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub class: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarEntry {
    pub entry: ContextSignEntry,
    pub overlap_of_new: f64,
    pub overlap_of_entry: f64,
    pub same_direction: bool,
}

/// The node's answer to "what do these points mean": the stretch on the road, in the form a device signs, and the entries that are
/// the same or similar. Show it before anything is proposed; if `existing` is set, confirm that entry instead of proposing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSignPreview {
    pub descriptor: Value,
    pub entry_key: String,
    pub length_m: f64,
    pub road: ContextSignRoad,
    pub timezone: String,
    #[serde(default)]
    pub existing: Option<ContextSignEntry>,
    #[serde(default)]
    pub similar: Vec<SimilarEntry>,
}

async fn post_failover(
    discovery: &DiscoveryService,
    bearer_token: &str,
    path: &str,
    body: &Value,
) -> Result<HttpResponse, DiscoveryError> {
    let (_, response) = discovery
        .request_with_failover(|server| {
            let url = format!("{}{path}", server.address.trim_end_matches('/'));
            HttpRequest::post_json(url.clone(), body)
                .unwrap_or_else(|_| HttpRequest::get(url))
                .with_header("Authorization", format!("Bearer {bearer_token}"))
        })
        .await?;
    Ok(response)
}

/// `POST /v1/context-signs/resolve`. Needs the network.
pub async fn resolve_context_sign(
    discovery: &DiscoveryService,
    bearer_token: &str,
    request: &ContextSignRequest,
) -> Result<ContextSignPreview, ContextSignError> {
    request.validate()?;
    let body =
        serde_json::to_value(request).map_err(|e| ContextSignError::Invalid(e.to_string()))?;
    let response =
        post_failover(discovery, bearer_token, "/v1/context-signs/resolve", &body).await?;
    if response.status == 404 {
        return Err(ContextSignError::NotOffered);
    }
    if !response.is_success() {
        return Err(refusal(&response));
    }
    response
        .json()
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
        .ok_or_else(|| ContextSignError::Transport("unexpected resolve body".to_string()))
}

// ---------------------------------------------------------------- queueing

fn drop_queued(
    store: &dyn Store,
    is_superseded: impl Fn(&WriteKind) -> bool,
) -> Result<(), StoreError> {
    for write in store.pending_writes()? {
        if is_superseded(&write.kind) {
            store.remove_pending_write(&write.id)?;
        }
    }
    Ok(())
}

/// Queues a proposal ("this sign applies here"). Nothing is resolved now - the node finds the road when the write is sent (the
/// next sync), so it works offline - and the proposal is signed then. The id is local. Use [`resolve_context_sign`] first to show
/// the person what their points mean.
pub fn queue_context_sign_proposal(
    store: &dyn Store,
    clock: &dyn Clock,
    request: &ContextSignRequest,
) -> Result<String, ContextSignError> {
    request.validate()?;
    let body =
        serde_json::to_value(request).map_err(|e| ContextSignError::Invalid(e.to_string()))?;
    let now = clock.now_unix_ms();
    let id = local_write_id(&json!({ "contextSign": body }), now);
    store.enqueue_write(&PendingWrite {
        id: id.clone(),
        request_body: body,
        created_at_unix_ms: now,
        attempts: 0,
        kind: WriteKind::ContextSignProposal,
    })?;
    Ok(id)
}

/// Queues a vote on an entry the device holds: `agrees = true` is "this is right" (it supports the entry), `false` "this is not
/// right". The newest stance on an entry replaces a still-queued older one. A confirmation needs the entry as the device holds it
/// (the signature covers its description), so an unknown entry is refused.
pub fn queue_context_sign_vote(
    store: &dyn Store,
    clock: &dyn Clock,
    entry_id: &str,
    agrees: bool,
) -> Result<String, ContextSignError> {
    let descriptor = if agrees {
        let entry = find_stored_entry(store, entry_id).ok_or_else(|| {
            ContextSignError::Invalid(
                "this device does not hold that sign (sync first)".to_string(),
            )
        })?;
        Some(entry.descriptor())
    } else {
        None
    };
    drop_queued(
        store,
        |kind| matches!(kind, WriteKind::ContextSignVote { entry_id: id, .. } if id == entry_id),
    )?;
    let now = clock.now_unix_ms();
    let body = json!({ "kind": if agrees { "confirm" } else { "deny" } });
    let id = local_write_id(
        &json!({ "contextSignVote": entry_id, "request": body }),
        now,
    );
    store.enqueue_write(&PendingWrite {
        id: id.clone(),
        request_body: body,
        created_at_unix_ms: now,
        attempts: 0,
        kind: WriteKind::ContextSignVote {
            entry_id: entry_id.to_string(),
            descriptor,
        },
    })?;
    Ok(id)
}

// ---------------------------------------------------------------- sending

/// The device-signed vote (`ContextSignVote` in `server/docs/federation-protocol.md` 5.4).
#[derive(Debug, Clone, Serialize)]
struct ContextSignVotePayload {
    kind: &'static str,
    vote: &'static str,
    #[serde(rename = "entryKey")]
    entry_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    entry: Option<Value>,
    #[serde(rename = "devicePublicKey")]
    device_public_key: String,
    timestamp: String,
}

fn assertion(
    key: &Ed25519KeyPair,
    now: i64,
    vote: &'static str,
    entry_key: &str,
    entry: Option<Value>,
) -> Result<Value, WriteBufferError> {
    let payload = ContextSignVotePayload {
        kind: "contextSignVote",
        vote,
        entry_key: entry_key.to_string(),
        entry,
        device_public_key: key.public_key_raw.clone(),
        timestamp: unix_ms_to_rfc3339(now),
    };
    let envelope =
        sign_envelope(payload, key).map_err(|e| WriteBufferError::Signing(e.to_string()))?;
    serde_json::to_value(&envelope).map_err(|e| WriteBufferError::Signing(e.to_string()))
}

enum Sent {
    Done,
    Retry,
    Refused(u16),
}

fn classify(result: Result<HttpResponse, DiscoveryError>) -> Sent {
    match result {
        Ok(r) if r.is_success() => Sent::Done,
        Ok(r) if r.status == 429 => Sent::Retry,
        Ok(r) => Sent::Refused(r.status),
        Err(_) => Sent::Retry,
    }
}

/// POST to the pool; a `404` is not final on one server (the entry may live on another), so the next is tried.
async fn post_pool(
    discovery: &DiscoveryService,
    bearer_token: &str,
    path: &str,
    body: &Value,
) -> Result<HttpResponse, DiscoveryError> {
    let pool = discovery.current_pool();
    if pool.is_empty() {
        return Err(DiscoveryError::NoServersAvailable);
    }
    let mut not_found = None;
    for server in &pool {
        let url = format!("{}{path}", server.address.trim_end_matches('/'));
        let request = HttpRequest::post_json(url, body)
            .map_err(DiscoveryError::Transport)?
            .with_header("Authorization", format!("Bearer {bearer_token}"));
        match discovery.request_to_server(server, request).await {
            Ok(r) if r.status == 404 => not_found = Some(r),
            Ok(r) => return Ok(r),
            Err(_) => {}
        }
    }
    not_found.ok_or(DiscoveryError::AllServersFailed)
}

fn finish(
    store: &dyn Store,
    item: PendingWrite,
    sent: Sent,
) -> Result<FlushOutcome, WriteBufferError> {
    match sent {
        Sent::Done => {
            store
                .remove_pending_write(&item.id)
                .map_err(WriteBufferError::Store)?;
            Ok(FlushOutcome::Submitted {
                local_id: item.id,
                merged: false,
            })
        }
        Sent::Refused(status) => {
            store
                .remove_pending_write(&item.id)
                .map_err(WriteBufferError::Store)?;
            Ok(FlushOutcome::Rejected {
                local_id: item.id,
                status,
            })
        }
        Sent::Retry => {
            let mut retried = item.clone();
            retried.attempts += 1;
            store
                .enqueue_write(&retried)
                .map_err(WriteBufferError::Store)?;
            Ok(FlushOutcome::Failed { local_id: item.id })
        }
    }
}

/// Sends one queued context-sign write (see [`super::flush_pending`], which calls this for them). A proposal is first resolved on the
/// node - if the sign already exists the proposal becomes a confirmation of it - then signed and sent. `429` and network failures
/// are retried later; any other `4xx` (the node does not know the sign, the points are not on a road ...) is a permanent refusal.
pub(super) async fn flush_context_sign_write(
    store: &dyn Store,
    discovery: &DiscoveryService,
    clock: &dyn Clock,
    bearer_token: &str,
    device_key: Option<&Ed25519KeyPair>,
    item: PendingWrite,
) -> Result<FlushOutcome, WriteBufferError> {
    let now = clock.now_unix_ms();
    match &item.kind {
        WriteKind::ContextSignVote {
            entry_id,
            descriptor,
        } => {
            let mut body = item.request_body.clone();
            let agrees = body.get("kind").and_then(|k| k.as_str()) == Some("confirm");
            if let Some(key) = device_key {
                let (vote, entry) = if agrees {
                    ("support", descriptor.clone())
                } else {
                    ("deny", None)
                };
                body["deviceAssertion"] = assertion(key, now, vote, entry_id, entry)?;
            }
            let path = format!("/v1/context-signs/{entry_id}/confirmations");
            let sent = classify(post_pool(discovery, bearer_token, &path, &body).await);
            finish(store, item, sent)
        }
        WriteKind::ContextSignProposal => {
            let resolved = post_failover(
                discovery,
                bearer_token,
                "/v1/context-signs/resolve",
                &item.request_body,
            )
            .await;
            let response = match resolved {
                Ok(r) if r.is_success() => r,
                other => return finish(store, item, classify(other)),
            };
            let Some(preview) = response
                .json()
                .ok()
                .and_then(|v| serde_json::from_value::<ContextSignPreview>(v).ok())
            else {
                return finish(store, item, Sent::Refused(502));
            };
            let sent = if let Some(existing) = preview.existing {
                let mut body = json!({ "kind": "confirm" });
                if let Some(key) = device_key {
                    body["deviceAssertion"] = assertion(
                        key,
                        now,
                        "support",
                        &existing.id,
                        Some(existing.descriptor()),
                    )?;
                }
                let path = format!("/v1/context-signs/{}/confirmations", existing.id);
                classify(post_pool(discovery, bearer_token, &path, &body).await)
            } else {
                let mut body = json!({ "descriptor": preview.descriptor });
                if let Some(key) = device_key {
                    body["deviceAssertion"] = assertion(
                        key,
                        now,
                        "support",
                        &preview.entry_key,
                        Some(preview.descriptor.clone()),
                    )?;
                }
                classify(post_failover(discovery, bearer_token, "/v1/context-signs", &body).await)
            };
            finish(store, item, sent)
        }
        _ => Err(WriteBufferError::InvalidInput(
            "not a context-sign write".to_string(),
        )),
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "context_signs_tests.rs"]
mod tests;
