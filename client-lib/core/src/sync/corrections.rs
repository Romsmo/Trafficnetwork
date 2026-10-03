//! Community speed-limit corrections, client side (add-on K-C; the server
//! side and its design decisions are `server/docs/speed-limit-corrections.md`).
//!
//! A wrong limit is reported with [`report_wrong_speed_limit`], an existing
//! correction is confirmed or objected to with
//! [`confirm_speed_limit_correction`]. Both only *queue* — they go through
//! the same offline write buffer as hazard reports, signed with the device
//! key at send time — and a report also leaves a [`LocalCorrectionProposal`]
//! behind: an overlay next to the synced segment, never a change to it. So
//! the imported value is always still there, and a correction that gets
//! reverted (or a proposal the server rejects) simply falls back to it.
//!
//! What a limit is *shown as* is decided at read time by
//! `sync::matching::nearest_speed_limit_with_proposals`, in this order: a
//! community-confirmed correction (it came from several devices), else this
//! device's own proposal (marked as unconfirmed), else the imported value.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::crypto::{sign_envelope, Ed25519KeyPair};
use crate::discovery::{DiscoveryError, DiscoveryService, KnownServer};
use crate::platform::{Clock, HttpRequest, HttpResponse};
use crate::storage::{
    LocalCorrectionProposal, PendingWrite, ProposalState, Store, StoreError, WriteKind,
};

use super::matching::nearest_speed_limit;
use super::types::{
    ClientConfig, CommunityCorrectionsConfig, CorrectionReason, Geometry, SpeedLimitSegment,
    SpeedLimitUnit,
};
use super::writebuffer::{local_write_id, unix_ms_to_rfc3339, FlushOutcome, WriteBufferError};

#[derive(Debug, Clone, PartialEq)]
pub enum CorrectionError {
    /// The server doesn't offer corrections (an older server, or the
    /// operator switched them off) — a host app should hide the feature.
    NotOffered,
    UnknownSegment,
    /// The segment came from a server that predates corrections, so it has
    /// no `segmentKey` to name in a vote.
    NoSegmentKey,
    UnitMismatch {
        segment_unit: String,
    },
    ValueOutOfRange {
        min: u32,
        max: u32,
    },
    ValueNotOnStep {
        step: u32,
    },
    /// The proposed value is the imported one. To dispute an existing
    /// correction, confirm it with `agrees: false` instead.
    NoChange,
    Store(String),
}

impl std::fmt::Display for CorrectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CorrectionError::NotOffered => write!(f, "this server doesn't offer corrections"),
            CorrectionError::UnknownSegment => write!(f, "no such speed-limit segment"),
            CorrectionError::NoSegmentKey => {
                write!(
                    f,
                    "the segment has no segmentKey (server predates corrections)"
                )
            }
            CorrectionError::UnitMismatch { segment_unit } => {
                write!(
                    f,
                    "the segment's unit is {segment_unit}; a correction never converts"
                )
            }
            CorrectionError::ValueOutOfRange { min, max } => {
                write!(f, "value must be between {min} and {max}")
            }
            CorrectionError::ValueNotOnStep { step } => {
                write!(f, "value must be a multiple of {step}")
            }
            CorrectionError::NoChange => write!(f, "the value equals the imported one"),
            CorrectionError::Store(msg) => write!(f, "storage error: {msg}"),
        }
    }
}

impl std::error::Error for CorrectionError {}

fn store_error(e: StoreError) -> CorrectionError {
    CorrectionError::Store(e.to_string())
}

/// The deterministic, cross-server-stable id of a correction record —
/// `server/src/modules/speed-limit-corrections/tally.ts`'s `correctionId`:
/// the first 128 bits of `sha256("speedLimitCorrection|<segmentKey>|<unit>|
/// <value>")`, formatted as a UUID. It is a pure function of what a
/// proposal says, so a device knows the id of its own proposal before the
/// server has ever seen it.
pub fn correction_id(segment_key: &str, unit: SpeedLimitUnit, value: u32) -> String {
    let unit = unit.as_str();
    let natural_key = format!("speedLimitCorrection|{segment_key}|{unit}|{value}");
    let hex = hex::encode(Sha256::digest(natural_key.as_bytes()));
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Which segment a report is about: by the id the client already holds, or
/// by position (the nearest segment in the local store).
#[derive(Debug, Clone, PartialEq)]
pub enum SegmentRef {
    Id(String),
    Position { lat: f64, lng: f64 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct WrongSpeedLimitReport {
    pub segment: SegmentRef,
    pub proposed_value: u32,
    pub unit: SpeedLimitUnit,
    pub reason: Option<CorrectionReason>,
}

/// Looks the segment up through the store's indexed queries — never by
/// loading every segment, which with a large dataset would be millions.
fn find_segment(
    store: &dyn Store,
    by: &SegmentRef,
    max_distance_meters: f64,
) -> Result<Option<SpeedLimitSegment>, CorrectionError> {
    match by {
        SegmentRef::Id(id) => store.speed_limit_segment(id).map_err(store_error),
        SegmentRef::Position { lat, lng } => {
            let nearby = store
                .speed_limit_segments_near(*lat, *lng, max_distance_meters)
                .map_err(store_error)?;
            let Some(nearest) = nearest_speed_limit(*lat, *lng, &nearby, max_distance_meters)
            else {
                return Ok(None);
            };
            Ok(nearby.into_iter().find(|s| s.id == nearest.segment_id))
        }
    }
}

/// Mirrors the server's plausibility rules (`GET /v1/config` →
/// `communityCorrections`) so an implausible value is rejected before it
/// costs a round trip — the server checks again regardless.
fn validate_value(
    rules: &CommunityCorrectionsConfig,
    segment: &SpeedLimitSegment,
    value: u32,
    unit: SpeedLimitUnit,
) -> Result<(), CorrectionError> {
    if segment.speed_limit_unit != unit.as_str() {
        return Err(CorrectionError::UnitMismatch {
            segment_unit: segment.speed_limit_unit.clone(),
        });
    }
    let range = match unit {
        SpeedLimitUnit::Kmh => rules.value_range.kmh,
        SpeedLimitUnit::Mph => rules.value_range.mph,
    };
    if !(range.min..=range.max).contains(&value) {
        return Err(CorrectionError::ValueOutOfRange {
            min: range.min,
            max: range.max,
        });
    }
    if rules.value_step > 0 && !value.is_multiple_of(rules.value_step) {
        return Err(CorrectionError::ValueNotOnStep {
            step: rules.value_step,
        });
    }
    let imported = segment.imported_speed_limit.unwrap_or(segment.speed_limit);
    if (imported - f64::from(value)).abs() < 0.5 {
        return Err(CorrectionError::NoChange);
    }
    Ok(())
}

/// `(lat, lng)` of the first vertex — where to look for this segment on a
/// server that doesn't know its row id.
fn first_vertex(geometry: &Geometry) -> Option<(f64, f64)> {
    match geometry {
        Geometry::LineString { coordinates } => coordinates.first().map(|c| (c[1], c[0])),
        Geometry::Point { .. } => None,
    }
}

fn drop_queued_writes(
    store: &dyn Store,
    is_superseded: impl Fn(&WriteKind) -> bool,
) -> Result<(), CorrectionError> {
    for write in store.pending_writes().map_err(store_error)? {
        if is_superseded(&write.kind) {
            store.remove_pending_write(&write.id).map_err(store_error)?;
        }
    }
    Ok(())
}

/// Queues a proposal for the right limit on a segment and records it as this
/// device's own [`LocalCorrectionProposal`] — effective locally right away,
/// sent when [`super::flush_pending`] next runs.
///
/// A device supports one value per segment, so a newer proposal replaces a
/// still-queued older one (and the local overlay).
pub fn report_wrong_speed_limit(
    store: &dyn Store,
    clock: &dyn Clock,
    config: &ClientConfig,
    report: &WrongSpeedLimitReport,
) -> Result<LocalCorrectionProposal, CorrectionError> {
    let rules = config
        .community_corrections
        .filter(|c| c.enabled)
        .ok_or(CorrectionError::NotOffered)?;

    let segment = find_segment(
        store,
        &report.segment,
        config.speed_limit_lookup_max_distance_meters,
    )?
    .ok_or(CorrectionError::UnknownSegment)?;
    let segment_key = segment
        .segment_key
        .clone()
        .ok_or(CorrectionError::NoSegmentKey)?;
    validate_value(&rules, &segment, report.proposed_value, report.unit)?;

    let now = clock.now_unix_ms();
    let mut body = serde_json::json!({
        "value": report.proposed_value,
        "unit": report.unit,
    });
    if let Some(reason) = report.reason {
        body["reason"] = serde_json::json!(reason);
    }

    drop_queued_writes(store, |kind| {
        matches!(
            kind,
            WriteKind::SpeedLimitCorrection { segment_key: key, .. } if key == &segment_key
        )
    })?;

    let id = local_write_id(
        &serde_json::json!({ "segmentKey": segment_key, "request": body }),
        now,
    );
    let item = PendingWrite {
        id,
        request_body: body,
        created_at_unix_ms: now,
        attempts: 0,
        kind: WriteKind::SpeedLimitCorrection {
            segment_id: segment.id.clone(),
            segment_key: segment_key.clone(),
            resolve_hint: first_vertex(&segment.geometry),
        },
    };
    store.enqueue_write(&item).map_err(store_error)?;

    let proposal_id = correction_id(&segment_key, report.unit, report.proposed_value);
    let proposal = LocalCorrectionProposal {
        segment_key,
        segment_id: segment.id.clone(),
        value: report.proposed_value,
        unit: report.unit,
        reason: report.reason,
        state: ProposalState::Queued,
        correction_id: Some(proposal_id),
        confirmations: 0,
        proposed_at_unix_ms: now,
    };
    store
        .upsert_local_proposal(&proposal)
        .map_err(store_error)?;
    Ok(proposal)
}

/// What a vote has to name: the correction and, for the signed vote, the
/// segment/value/unit it is about.
#[derive(Debug, Clone, PartialEq)]
pub struct CorrectionTarget {
    pub correction_id: String,
    pub segment_key: String,
    pub value: u32,
    pub unit: SpeedLimitUnit,
}

fn whole_number(value: f64) -> Option<u32> {
    if value >= 0.0 && value.fract() == 0.0 && value <= f64::from(u32::MAX) {
        Some(value as u32)
    } else {
        None
    }
}

fn parse_unit(unit: &str) -> Option<SpeedLimitUnit> {
    match unit {
        "kmh" => Some(SpeedLimitUnit::Kmh),
        "mph" => Some(SpeedLimitUnit::Mph),
        _ => None,
    }
}

impl CorrectionTarget {
    /// The correction a synced segment currently carries — `None` when its
    /// limit isn't a community correction (or the segment predates them).
    pub fn from_segment(segment: &SpeedLimitSegment) -> Option<Self> {
        let correction = segment.correction.as_ref()?;
        Some(Self {
            correction_id: correction.id.clone(),
            segment_key: segment.segment_key.clone()?,
            value: whole_number(segment.speed_limit)?,
            unit: parse_unit(&segment.speed_limit_unit)?,
        })
    }

    /// From an entry of [`fetch_corrections`] — the way to reach a proposal
    /// that isn't (yet) a correction any segment carries.
    pub fn from_correction(correction: &Correction) -> Self {
        Self {
            correction_id: correction.id.clone(),
            segment_key: correction.segment_key.clone(),
            value: correction.value,
            unit: correction.unit,
        }
    }
}

/// Queues a confirmation ("stimmt", `agrees: true`) or objection ("stimmt
/// nicht") to an existing correction and returns the queue id. Nothing
/// changes in what a limit is shown as until the server's answer comes back
/// through sync, since one vote alone never flips a correction. The newest
/// stance on a correction wins over a still-queued older one.
///
/// One case does change locally: objecting to this device's *own* proposal
/// withdraws it (the server drops a device's support when it objects), so
/// its overlay goes away at once. If that proposal was still queued there is
/// nothing on the server to withdraw — it is simply cancelled, nothing is
/// queued, and the result is `None`.
pub fn confirm_speed_limit_correction(
    store: &dyn Store,
    clock: &dyn Clock,
    config: &ClientConfig,
    target: &CorrectionTarget,
    agrees: bool,
) -> Result<Option<String>, CorrectionError> {
    config
        .community_corrections
        .filter(|c| c.enabled)
        .ok_or(CorrectionError::NotOffered)?;

    if !agrees && withdraw_own_proposal(store, target)? {
        return Ok(None);
    }

    drop_queued_writes(store, |kind| {
        matches!(
            kind,
            WriteKind::SpeedLimitConfirmation { correction_id: id, .. }
                if id == &target.correction_id
        )
    })?;

    let now = clock.now_unix_ms();
    let stance = if agrees { "confirm" } else { "deny" };
    let body = serde_json::json!({ "kind": stance });
    let id = local_write_id(
        &serde_json::json!({ "correctionId": target.correction_id, "request": body }),
        now,
    );
    let item = PendingWrite {
        id: id.clone(),
        request_body: body,
        created_at_unix_ms: now,
        attempts: 0,
        kind: WriteKind::SpeedLimitConfirmation {
            correction_id: target.correction_id.clone(),
            segment_key: target.segment_key.clone(),
            value: target.value,
            unit: target.unit,
            agrees,
        },
    };
    store.enqueue_write(&item).map_err(store_error)?;
    Ok(Some(id))
}

/// Objecting to a value this device itself proposed: the overlay goes away.
/// `true` if that proposal was still queued and has been cancelled outright,
/// so there is nothing to send.
fn withdraw_own_proposal(
    store: &dyn Store,
    target: &CorrectionTarget,
) -> Result<bool, CorrectionError> {
    let own = store
        .local_proposals()
        .map_err(store_error)?
        .into_iter()
        .find(|p| {
            p.segment_key == target.segment_key && p.unit == target.unit && p.value == target.value
        });
    let Some(own) = own else {
        return Ok(false);
    };
    store
        .remove_local_proposal(&own.segment_key)
        .map_err(store_error)?;
    if own.state != ProposalState::Queued {
        return Ok(false);
    }
    drop_queued_writes(store, |kind| {
        matches!(
            kind,
            WriteKind::SpeedLimitCorrection { segment_key: key, .. } if key == &own.segment_key
        )
    })?;
    Ok(true)
}

/// One entry of `GET /v1/speed-limit-corrections`
/// (`server/docs/api.md`, "Speed-limit corrections").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Correction {
    pub id: String,
    #[serde(rename = "segmentKey")]
    pub segment_key: String,
    #[serde(rename = "segmentId")]
    pub segment_id: Option<String>,
    pub value: u32,
    pub unit: SpeedLimitUnit,
    /// `proposed`, `applied`, `superseded` or `reverted`.
    pub status: String,
    pub reason: Option<String>,
    pub confirmations: u32,
    pub denials: u32,
    #[serde(rename = "appliedAt")]
    pub applied_at: Option<String>,
    #[serde(rename = "importedSpeedLimit")]
    pub imported_speed_limit: Option<f64>,
    #[serde(rename = "needsReview")]
    pub needs_review: bool,
}

#[derive(Debug, Deserialize)]
struct CorrectionList {
    corrections: Vec<Correction>,
}

/// The server's largest accepted `tiles` list.
const MAX_TILES_PER_REQUEST: usize = 100;

/// Open proposals and applied corrections in the given H3 cells — so an app
/// can ask a driver "still true?". A server without corrections (older, or
/// switched off) answers `404`, which is an empty list here, not an error.
pub async fn fetch_corrections(
    discovery: &DiscoveryService,
    bearer_token: &str,
    tiles: &[String],
) -> Result<Vec<Correction>, DiscoveryError> {
    let mut all = Vec::new();
    for chunk in tiles.chunks(MAX_TILES_PER_REQUEST) {
        let joined = chunk.join(",");
        let (_, response) = discovery
            .request_with_failover(|server| {
                let url = format!(
                    "{}/v1/speed-limit-corrections?tiles={joined}",
                    server.address.trim_end_matches('/')
                );
                HttpRequest::get(url).with_header("Authorization", format!("Bearer {bearer_token}"))
            })
            .await?;
        if response.status == 404 {
            return Ok(Vec::new());
        }
        if !response.is_success() {
            return Err(DiscoveryError::InvalidResponse(format!(
                "HTTP {}",
                response.status
            )));
        }
        let list = response
            .json()
            .ok()
            .and_then(|v| serde_json::from_value::<CorrectionList>(v).ok())
            .ok_or_else(|| {
                DiscoveryError::InvalidResponse("unexpected corrections body".to_string())
            })?;
        all.extend(list.corrections);
    }
    Ok(all)
}

// ---------------------------------------------------------------- sending

/// The device-signed vote (`SpeedLimitVote` in `server/docs/api.md`) — the
/// federation counterpart of a hazard report's `DeviceCreateEvent`.
#[derive(Debug, Clone, Serialize)]
struct SpeedLimitVotePayload {
    kind: &'static str,
    vote: &'static str,
    #[serde(rename = "segmentKey")]
    segment_key: String,
    value: u32,
    unit: SpeedLimitUnit,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<CorrectionReason>,
    #[serde(rename = "devicePublicKey")]
    device_public_key: String,
    timestamp: String,
}

fn queued_value(item: &PendingWrite) -> Option<u32> {
    let value = item.request_body.get("value")?.as_u64()?;
    u32::try_from(value).ok()
}

/// What the signed vote has to say for this write — it must match the
/// request body exactly, or the server rejects it.
fn vote_payload(
    item: &PendingWrite,
    key: &Ed25519KeyPair,
    now_unix_ms: i64,
) -> Option<SpeedLimitVotePayload> {
    let (vote, segment_key, value, unit, reason) = match &item.kind {
        WriteKind::SpeedLimitCorrection { segment_key, .. } => {
            let unit_json = item.request_body.get("unit")?.clone();
            let unit = serde_json::from_value::<SpeedLimitUnit>(unit_json).ok()?;
            let reason = item
                .request_body
                .get("reason")
                .and_then(|r| serde_json::from_value::<CorrectionReason>(r.clone()).ok());
            (
                "support",
                segment_key.clone(),
                queued_value(item)?,
                unit,
                reason,
            )
        }
        WriteKind::SpeedLimitConfirmation {
            segment_key,
            value,
            unit,
            agrees,
            ..
        } => {
            let vote = if *agrees { "support" } else { "deny" };
            (vote, segment_key.clone(), *value, *unit, None)
        }
        // Not votes on a segment (and not signed: the server takes these
        // unsigned, they are not replicated between servers).
        WriteKind::HazardReport
        | WriteKind::HazardConfirmation { .. }
        | WriteKind::CameraRemoval { .. } => return None,
    };
    Some(SpeedLimitVotePayload {
        kind: "speedLimitVote",
        vote,
        segment_key,
        value,
        unit,
        reason,
        device_public_key: key.public_key_raw.clone(),
        timestamp: unix_ms_to_rfc3339(now_unix_ms),
    })
}

async fn post(
    discovery: &DiscoveryService,
    server: &KnownServer,
    bearer_token: &str,
    path: &str,
    body: &serde_json::Value,
) -> Result<HttpResponse, DiscoveryError> {
    let url = format!("{}{path}", server.address.trim_end_matches('/'));
    let request = HttpRequest::post_json(url, body)
        .map_err(DiscoveryError::Transport)?
        .with_header("Authorization", format!("Bearer {bearer_token}"));
    discovery.request_to_server(server, request).await
}

/// A segment's row id is local to the server that supplied it, so a server
/// that answers `404` for the id may still hold the same segment under a
/// different one. Its `segmentKey` is the same everywhere: look near the
/// segment and take the row carrying that key.
async fn find_row_id(
    discovery: &DiscoveryService,
    server: &KnownServer,
    bearer_token: &str,
    segment_key: &str,
    hint: Option<(f64, f64)>,
) -> Option<String> {
    let (lat, lng) = hint?;
    let url = format!(
        "{}/v1/speed-limit-segments/nearby?lat={lat}&lng={lng}&radiusM=25",
        server.address.trim_end_matches('/')
    );
    let request =
        HttpRequest::get(url).with_header("Authorization", format!("Bearer {bearer_token}"));
    let response = discovery.request_to_server(server, request).await.ok()?;
    if !response.is_success() {
        return None;
    }
    let json = response.json().ok()?;
    let segments = json.get("segments")?.as_array()?;
    let found = segments
        .iter()
        .find(|s| s.get("segmentKey").and_then(|k| k.as_str()) == Some(segment_key))?;
    found.get("id")?.as_str().map(str::to_string)
}

async fn send_to_server(
    discovery: &DiscoveryService,
    server: &KnownServer,
    bearer_token: &str,
    kind: &WriteKind,
    body: &serde_json::Value,
) -> Result<HttpResponse, DiscoveryError> {
    match kind {
        WriteKind::SpeedLimitCorrection {
            segment_id,
            segment_key,
            resolve_hint,
        } => {
            let path = format!("/v1/speed-limit-segments/{segment_id}/corrections");
            let first = post(discovery, server, bearer_token, &path, body).await?;
            if first.status != 404 {
                return Ok(first);
            }
            let hint = *resolve_hint;
            let local_id = find_row_id(discovery, server, bearer_token, segment_key, hint).await;
            match local_id {
                Some(id) if &id != segment_id => {
                    let path = format!("/v1/speed-limit-segments/{id}/corrections");
                    post(discovery, server, bearer_token, &path, body).await
                }
                _ => Ok(first),
            }
        }
        WriteKind::SpeedLimitConfirmation { correction_id, .. } => {
            let path = format!("/v1/speed-limit-corrections/{correction_id}/confirmations");
            post(discovery, server, bearer_token, &path, body).await
        }
        WriteKind::HazardConfirmation { report_id } => {
            let path = format!("/v1/hazard-reports/{report_id}/confirmations");
            post(discovery, server, bearer_token, &path, body).await
        }
        WriteKind::CameraRemoval { camera_id } => {
            let path = format!("/v1/speed-cameras/{camera_id}/removal-reports");
            post(discovery, server, bearer_token, &path, body).await
        }
        WriteKind::HazardReport => Err(DiscoveryError::InvalidResponse(
            "a hazard report is sent by the hazard-report flush".to_string(),
        )),
    }
}

/// Tries the pool in ranked order. A `404` isn't final on one server — the
/// segment or correction may simply live on another — so it moves on, and
/// only if every server answered `404` is that the result.
async fn send_to_pool(
    discovery: &DiscoveryService,
    bearer_token: &str,
    kind: &WriteKind,
    body: &serde_json::Value,
) -> Result<HttpResponse, DiscoveryError> {
    let pool = discovery.current_pool();
    if pool.is_empty() {
        return Err(DiscoveryError::NoServersAvailable);
    }
    let mut not_found = None;
    for server in &pool {
        match send_to_server(discovery, server, bearer_token, kind, body).await {
            Ok(response) if response.status == 404 => not_found = Some(response),
            Ok(response) => return Ok(response),
            Err(_) => {}
        }
    }
    match not_found {
        Some(response) => Ok(response),
        None => Err(DiscoveryError::AllServersFailed),
    }
}

/// The server accepted a proposal: the local overlay is now `Sent` and
/// carries the correction id and the server's count.
fn record_accepted(
    store: &dyn Store,
    item: &PendingWrite,
    response: &HttpResponse,
) -> Result<(), WriteBufferError> {
    let WriteKind::SpeedLimitCorrection { segment_key, .. } = &item.kind else {
        return Ok(());
    };
    let proposals = store.local_proposals().map_err(WriteBufferError::Store)?;
    let Some(mut proposal) = proposals
        .into_iter()
        .find(|p| &p.segment_key == segment_key && Some(p.value) == queued_value(item))
    else {
        return Ok(());
    };
    let json = response.json().ok();
    let correction = json.as_ref().and_then(|v| v.get("correction"));
    proposal.state = ProposalState::Sent;
    proposal.correction_id = correction
        .and_then(|c| c.get("id"))
        .and_then(|id| id.as_str())
        .map(str::to_string);
    if let Some(count) = correction
        .and_then(|c| c.get("confirmations"))
        .and_then(|n| n.as_u64())
    {
        proposal.confirmations = u32::try_from(count).unwrap_or(proposal.confirmations);
    }
    store
        .upsert_local_proposal(&proposal)
        .map_err(WriteBufferError::Store)
}

/// The server permanently refused a proposal: its overlay must not go on
/// showing a value nobody accepted.
fn drop_rejected_proposal(store: &dyn Store, item: &PendingWrite) -> Result<(), WriteBufferError> {
    let WriteKind::SpeedLimitCorrection { segment_key, .. } = &item.kind else {
        return Ok(());
    };
    let proposals = store.local_proposals().map_err(WriteBufferError::Store)?;
    let is_this_one = proposals
        .iter()
        .any(|p| &p.segment_key == segment_key && Some(p.value) == queued_value(item));
    if is_this_one {
        store
            .remove_local_proposal(segment_key)
            .map_err(WriteBufferError::Store)?;
    }
    Ok(())
}

/// Sends one queued correction or confirmation — see
/// [`super::flush_pending`], which calls this for every such write.
/// `429` is the server's per-device budget and is retried later; any other
/// `4xx` is a permanent refusal.
pub(super) async fn flush_correction_write(
    store: &dyn Store,
    discovery: &DiscoveryService,
    clock: &dyn Clock,
    bearer_token: &str,
    device_key: Option<&Ed25519KeyPair>,
    item: PendingWrite,
) -> Result<FlushOutcome, WriteBufferError> {
    let mut body = item.request_body.clone();
    if let Some(key) = device_key {
        if let Some(payload) = vote_payload(&item, key, clock.now_unix_ms()) {
            let assertion = sign_envelope(payload, key)
                .map_err(|e| WriteBufferError::Signing(e.to_string()))?;
            body["deviceAssertion"] = serde_json::to_value(&assertion)
                .map_err(|e| WriteBufferError::Signing(e.to_string()))?;
        }
    }

    match send_to_pool(discovery, bearer_token, &item.kind, &body).await {
        Ok(response) if response.is_success() => {
            store
                .remove_pending_write(&item.id)
                .map_err(WriteBufferError::Store)?;
            record_accepted(store, &item, &response)?;
            let merged = response
                .json()
                .ok()
                .and_then(|v| v.get("merged").and_then(|m| m.as_bool()))
                .unwrap_or(false);
            Ok(FlushOutcome::Submitted {
                local_id: item.id,
                merged,
            })
        }
        Ok(response) if response.status == 429 => {
            let mut retried = item.clone();
            retried.attempts += 1;
            store
                .enqueue_write(&retried)
                .map_err(WriteBufferError::Store)?;
            Ok(FlushOutcome::Failed { local_id: item.id })
        }
        Ok(response) => {
            store
                .remove_pending_write(&item.id)
                .map_err(WriteBufferError::Store)?;
            drop_rejected_proposal(store, &item)?;
            Ok(FlushOutcome::Rejected {
                local_id: item.id,
                status: response.status,
            })
        }
        Err(_) => {
            let mut retried = item.clone();
            retried.attempts += 1;
            store
                .enqueue_write(&retried)
                .map_err(WriteBufferError::Store)?;
            Ok(FlushOutcome::Failed { local_id: item.id })
        }
    }
}

// Native-only: uses `#[tokio::test]`, which needs a real tokio runtime.
#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::crypto::{generate_ed25519_keypair, verify_signed_envelope, SignedEnvelope};
    use crate::discovery::DiscoveryConfig;
    use crate::platform::{HttpError, HttpTransport};
    use crate::storage::{InMemoryStore, StoredEntities};
    use crate::sync::types::{CorrectionRateLimit, SegmentCorrection, ValueRange, ValueRanges};
    use crate::sync::writebuffer::flush_pending;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::{Arc, Mutex};

    const KEY: &str = "0123456789abcdef0123456789abcdef";
    const T0: i64 = 1_000_000;

    struct FixedClock(AtomicI64);
    impl Clock for FixedClock {
        fn now_unix_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct MockTransport {
        responses: Mutex<HashMap<String, HttpResponse>>,
        seen: Mutex<Vec<(String, Option<Vec<u8>>)>>,
    }
    impl MockTransport {
        fn new() -> Self {
            Self {
                responses: Mutex::new(HashMap::new()),
                seen: Mutex::new(Vec::new()),
            }
        }
        fn set(&self, url: &str, status: u16, body: serde_json::Value) {
            self.responses.lock().unwrap().insert(
                url.to_string(),
                HttpResponse {
                    status,
                    body: serde_json::to_vec(&body).unwrap(),
                },
            );
        }
        fn request_count(&self) -> usize {
            self.seen.lock().unwrap().len()
        }
        fn bodies_to(&self, url: &str) -> Vec<serde_json::Value> {
            self.seen
                .lock()
                .unwrap()
                .iter()
                .filter(|(u, _)| u == url)
                .filter_map(|(_, body)| body.as_ref())
                .filter_map(|b| serde_json::from_slice(b).ok())
                .collect()
        }
    }
    #[async_trait::async_trait]
    impl HttpTransport for MockTransport {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
            self.seen
                .lock()
                .unwrap()
                .push((request.url.clone(), request.body.clone()));
            self.responses
                .lock()
                .unwrap()
                .get(&request.url)
                .cloned()
                .ok_or_else(|| HttpError::Network(format!("no mock response for {}", request.url)))
        }
    }

    struct Fixture {
        store: InMemoryStore,
        discovery: DiscoveryService,
        transport: Arc<MockTransport>,
        clock: Arc<FixedClock>,
    }

    fn fixture(nodes: &[(&str, &str)]) -> Fixture {
        let transport = Arc::new(MockTransport::new());
        let clock = Arc::new(FixedClock(AtomicI64::new(T0)));
        let discovery =
            DiscoveryService::new(transport.clone(), clock.clone(), DiscoveryConfig::default());
        let nodes: Vec<(String, String)> = nodes
            .iter()
            .map(|(id, address)| (id.to_string(), address.to_string()))
            .collect();
        discovery.seed_fixed_nodes(&nodes);
        Fixture {
            store: InMemoryStore::new(),
            discovery,
            transport,
            clock,
        }
    }

    fn one_server() -> Fixture {
        fixture(&[("node1", "https://a.example")])
    }

    fn segment(id: &str, key: Option<&str>) -> SpeedLimitSegment {
        SpeedLimitSegment {
            id: id.to_string(),
            geometry: Geometry::LineString {
                coordinates: vec![[13.0, 52.1], [13.01, 52.1]],
            },
            speed_limit: 50.0,
            speed_limit_unit: "kmh".to_string(),
            source: "osm".to_string(),
            source_license: None,
            imported_at: "2026-01-01T00:00:00Z".to_string(),
            last_confirmed_at: None,
            segment_key: key.map(str::to_string),
            corrected_by: None,
            imported_speed_limit: None,
            correction: None,
        }
    }

    fn add_segments(f: &Fixture, segments: Vec<SpeedLimitSegment>) {
        let data = StoredEntities {
            speed_limit_segments: segments,
            ..Default::default()
        };
        f.store.upsert_static_data(&data).unwrap();
    }

    fn rules(enabled: bool) -> CommunityCorrectionsConfig {
        CommunityCorrectionsConfig {
            enabled,
            confirmations_required: 3,
            value_range: ValueRanges {
                kmh: ValueRange { min: 5, max: 150 },
                mph: ValueRange { min: 5, max: 85 },
            },
            value_step: 5,
            rate_limit: CorrectionRateLimit {
                max: 5,
                window_minutes: 60,
            },
        }
    }

    fn config(community_corrections: Option<CommunityCorrectionsConfig>) -> ClientConfig {
        ClientConfig {
            region_tile_h3_resolution: 7,
            static_data_partition_h3_resolution: 2,
            speed_camera_namespace_enabled: false,
            camera_namespace_hazard_types: vec![],
            duplicate_merge_radius_meters: 50.0,
            speed_limit_lookup_max_distance_meters: 100.0,
            hazard_expiry_ms_by_type: HashMap::new(),
            report_rate_limit_max: 10,
            report_rate_limit_window_minutes: 10,
            camera_removal_threshold: 3,
            static_data_version: 1,
            federation_enabled: false,
            network_config: None,
            community_corrections,
        }
    }

    fn report(segment_id: &str, value: u32) -> WrongSpeedLimitReport {
        WrongSpeedLimitReport {
            segment: SegmentRef::Id(segment_id.to_string()),
            proposed_value: value,
            unit: SpeedLimitUnit::Kmh,
            reason: None,
        }
    }

    fn accepted(correction_id: &str, confirmations: u32) -> serde_json::Value {
        serde_json::json!({
            "correction": { "id": correction_id, "confirmations": confirmations },
            "recorded": true,
            "merged": false,
            "segment": {}
        })
    }

    const S1_URL: &str = "https://a.example/v1/speed-limit-segments/s1/corrections";

    #[test]
    fn a_server_that_does_not_offer_corrections_is_reported_and_nothing_is_queued() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        let clock = FixedClock(AtomicI64::new(T0));

        let absent = report_wrong_speed_limit(&f.store, &clock, &config(None), &report("s1", 30));
        let off = report_wrong_speed_limit(
            &f.store,
            &clock,
            &config(Some(rules(false))),
            &report("s1", 30),
        );

        assert_eq!(absent, Err(CorrectionError::NotOffered));
        assert_eq!(off, Err(CorrectionError::NotOffered));
        assert!(f.store.pending_writes().unwrap().is_empty());
        assert!(f.store.local_proposals().unwrap().is_empty());
    }

    #[test]
    fn implausible_input_is_rejected_before_anything_is_queued() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY)), segment("no-key", None)]);
        let clock = FixedClock(AtomicI64::new(T0));
        let cfg = config(Some(rules(true)));
        let propose = |r: &WrongSpeedLimitReport| {
            report_wrong_speed_limit(&f.store, &clock, &cfg, r).unwrap_err()
        };

        assert_eq!(
            propose(&report("s1", 200)),
            CorrectionError::ValueOutOfRange { min: 5, max: 150 }
        );
        assert_eq!(
            propose(&report("s1", 33)),
            CorrectionError::ValueNotOnStep { step: 5 }
        );
        assert_eq!(propose(&report("s1", 50)), CorrectionError::NoChange);
        assert_eq!(
            propose(&report("missing", 30)),
            CorrectionError::UnknownSegment
        );
        assert_eq!(
            propose(&report("no-key", 30)),
            CorrectionError::NoSegmentKey
        );
        let mph = WrongSpeedLimitReport {
            unit: SpeedLimitUnit::Mph,
            ..report("s1", 30)
        };
        assert_eq!(
            propose(&mph),
            CorrectionError::UnitMismatch {
                segment_unit: "kmh".to_string()
            }
        );
        assert!(f.store.pending_writes().unwrap().is_empty());
        assert!(f.store.local_proposals().unwrap().is_empty());
    }

    #[test]
    fn a_report_by_position_finds_the_nearest_segment() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        let clock = FixedClock(AtomicI64::new(T0));
        let by_position = WrongSpeedLimitReport {
            segment: SegmentRef::Position {
                lat: 52.1,
                lng: 13.005,
            },
            ..report("ignored", 30)
        };

        let proposal =
            report_wrong_speed_limit(&f.store, &clock, &config(Some(rules(true))), &by_position)
                .unwrap();

        assert_eq!(proposal.segment_id, "s1");
    }

    #[test]
    fn a_report_queues_an_unsigned_write_and_a_local_overlay_and_sends_nothing() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        let clock = FixedClock(AtomicI64::new(T0));
        let with_reason = WrongSpeedLimitReport {
            reason: Some(CorrectionReason::LimitLifted),
            ..report("s1", 30)
        };

        let proposal =
            report_wrong_speed_limit(&f.store, &clock, &config(Some(rules(true))), &with_reason)
                .unwrap();

        let pending = f.store.pending_writes().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].request_body,
            serde_json::json!({ "value": 30, "unit": "kmh", "reason": "limit_lifted" })
        );
        assert_eq!(
            pending[0].kind,
            WriteKind::SpeedLimitCorrection {
                segment_id: "s1".to_string(),
                segment_key: KEY.to_string(),
                resolve_hint: Some((52.1, 13.0)),
            }
        );
        assert_eq!(proposal.state, ProposalState::Queued);
        assert_eq!(f.store.local_proposals().unwrap(), vec![proposal]);
        assert_eq!(f.transport.request_count(), 0);
    }

    #[test]
    fn a_newer_report_replaces_the_still_queued_older_one() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        let clock = FixedClock(AtomicI64::new(T0));
        let cfg = config(Some(rules(true)));

        report_wrong_speed_limit(&f.store, &clock, &cfg, &report("s1", 30)).unwrap();
        report_wrong_speed_limit(&f.store, &clock, &cfg, &report("s1", 70)).unwrap();

        let pending = f.store.pending_writes().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].request_body["value"], 70);
        let proposals = f.store.local_proposals().unwrap();
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].value, 70);
    }

    #[tokio::test]
    async fn flushing_signs_fresh_and_marks_the_overlay_as_sent() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        f.transport.set(S1_URL, 201, accepted("c1", 1));
        let cfg = config(Some(rules(true)));
        report_wrong_speed_limit(&f.store, &*f.clock, &cfg, &report("s1", 30)).unwrap();
        let key = generate_ed25519_keypair().unwrap();
        // Offline for five minutes — far past a signature's 60-second window.
        f.clock.0.fetch_add(5 * 60 * 1000, Ordering::SeqCst);

        let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", Some(&key))
            .await
            .unwrap();

        assert!(matches!(
            outcomes.as_slice(),
            [FlushOutcome::Submitted { merged: false, .. }]
        ));
        assert!(f.store.pending_writes().unwrap().is_empty());
        let proposals = f.store.local_proposals().unwrap();
        let proposal = &proposals[0];
        assert_eq!(proposal.state, ProposalState::Sent);
        assert_eq!(proposal.correction_id.as_deref(), Some("c1"));
        assert_eq!(proposal.confirmations, 1);

        let bodies = f.transport.bodies_to(S1_URL);
        let sent = &bodies[0];
        assert_eq!(sent["value"], 30);
        assert_eq!(sent["unit"], "kmh");
        let payload = &sent["deviceAssertion"]["payload"];
        assert_eq!(payload["kind"], "speedLimitVote");
        assert_eq!(payload["vote"], "support");
        assert_eq!(payload["segmentKey"], KEY);
        assert_eq!(payload["value"], 30);
        assert_eq!(payload["unit"], "kmh");
        assert_eq!(payload["devicePublicKey"], key.public_key_raw);
        let signed_at =
            chrono::DateTime::parse_from_rfc3339(payload["timestamp"].as_str().unwrap())
                .unwrap()
                .timestamp_millis();
        assert_eq!(signed_at, T0 + 5 * 60 * 1000);
        let envelope: SignedEnvelope<serde_json::Value> =
            serde_json::from_value(sent["deviceAssertion"].clone()).unwrap();
        assert!(verify_signed_envelope(&envelope, &key.public_key_raw));
    }

    #[tokio::test]
    async fn without_a_device_key_the_proposal_is_sent_unsigned() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        f.transport.set(S1_URL, 201, accepted("c1", 1));
        let cfg = config(Some(rules(true)));
        report_wrong_speed_limit(&f.store, &*f.clock, &cfg, &report("s1", 30)).unwrap();

        flush_pending(&f.store, &f.discovery, &*f.clock, "token", None)
            .await
            .unwrap();

        let bodies = f.transport.bodies_to(S1_URL);
        assert!(bodies[0].get("deviceAssertion").is_none());
    }

    #[tokio::test]
    async fn a_row_id_another_server_does_not_know_is_found_again_by_its_segment_key() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        f.transport.set(S1_URL, 404, serde_json::json!({}));
        f.transport.set(
            "https://a.example/v1/speed-limit-segments/nearby?lat=52.1&lng=13&radiusM=25",
            200,
            serde_json::json!({ "segments": [
                { "id": "someone-else", "segmentKey": "ffffffffffffffffffffffffffffffff" },
                { "id": "local-row", "segmentKey": KEY }
            ] }),
        );
        let local_url = "https://a.example/v1/speed-limit-segments/local-row/corrections";
        f.transport.set(local_url, 201, accepted("c1", 1));
        let cfg = config(Some(rules(true)));
        report_wrong_speed_limit(&f.store, &*f.clock, &cfg, &report("s1", 30)).unwrap();

        let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", None)
            .await
            .unwrap();

        assert!(matches!(
            outcomes.as_slice(),
            [FlushOutcome::Submitted { .. }]
        ));
        assert_eq!(f.transport.bodies_to(local_url).len(), 1);
    }

    #[tokio::test]
    async fn a_segment_no_server_knows_is_a_permanent_rejection_and_drops_the_overlay() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        f.transport.set(S1_URL, 404, serde_json::json!({}));
        f.transport.set(
            "https://a.example/v1/speed-limit-segments/nearby?lat=52.1&lng=13&radiusM=25",
            200,
            serde_json::json!({ "segments": [] }),
        );
        let cfg = config(Some(rules(true)));
        report_wrong_speed_limit(&f.store, &*f.clock, &cfg, &report("s1", 30)).unwrap();

        let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", None)
            .await
            .unwrap();

        assert!(matches!(
            outcomes.as_slice(),
            [FlushOutcome::Rejected { status: 404, .. }]
        ));
        assert!(f.store.pending_writes().unwrap().is_empty());
        assert!(f.store.local_proposals().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_refused_value_is_dropped_along_with_its_overlay() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        f.transport.set(
            S1_URL,
            422,
            serde_json::json!({ "error": { "code": "CORRECTION_NO_CHANGE" } }),
        );
        let cfg = config(Some(rules(true)));
        report_wrong_speed_limit(&f.store, &*f.clock, &cfg, &report("s1", 30)).unwrap();

        let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", None)
            .await
            .unwrap();

        assert!(matches!(
            outcomes.as_slice(),
            [FlushOutcome::Rejected { status: 422, .. }]
        ));
        assert!(f.store.local_proposals().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_per_device_rate_limit_is_retried_later_not_dropped() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        f.transport.set(S1_URL, 429, serde_json::json!({}));
        let cfg = config(Some(rules(true)));
        report_wrong_speed_limit(&f.store, &*f.clock, &cfg, &report("s1", 30)).unwrap();

        let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", None)
            .await
            .unwrap();

        assert!(matches!(outcomes.as_slice(), [FlushOutcome::Failed { .. }]));
        let pending = f.store.pending_writes().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].attempts, 1);
        assert_eq!(
            f.store.local_proposals().unwrap()[0].state,
            ProposalState::Queued
        );
    }

    #[tokio::test]
    async fn offline_everything_stays_queued_for_the_next_attempt() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        // No response configured at all: every send fails.
        let cfg = config(Some(rules(true)));
        report_wrong_speed_limit(&f.store, &*f.clock, &cfg, &report("s1", 30)).unwrap();

        let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", None)
            .await
            .unwrap();

        assert!(matches!(outcomes.as_slice(), [FlushOutcome::Failed { .. }]));
        assert_eq!(f.store.pending_writes().unwrap()[0].attempts, 1);
        assert_eq!(f.store.local_proposals().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn another_server_takes_over_when_the_first_is_unreachable() {
        let f = fixture(&[("a", "https://a.example"), ("b", "https://b.example")]);
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        // Only b answers, whichever the pool tries first.
        f.transport.set(
            "https://b.example/v1/speed-limit-segments/s1/corrections",
            201,
            accepted("c1", 1),
        );
        let cfg = config(Some(rules(true)));
        report_wrong_speed_limit(&f.store, &*f.clock, &cfg, &report("s1", 30)).unwrap();

        let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", None)
            .await
            .unwrap();

        assert!(matches!(
            outcomes.as_slice(),
            [FlushOutcome::Submitted { .. }]
        ));
    }

    fn target() -> CorrectionTarget {
        CorrectionTarget {
            correction_id: "c1".to_string(),
            segment_key: KEY.to_string(),
            value: 30,
            unit: SpeedLimitUnit::Kmh,
        }
    }

    #[tokio::test]
    async fn an_objection_is_queued_replaced_by_the_newest_stance_and_sent_signed() {
        let f = one_server();
        let cfg = config(Some(rules(true)));
        let confirmations_url = "https://a.example/v1/speed-limit-corrections/c1/confirmations";
        f.transport.set(
            confirmations_url,
            200,
            serde_json::json!({ "correction": { "id": "c1" }, "recorded": true, "merged": true }),
        );
        confirm_speed_limit_correction(&f.store, &*f.clock, &cfg, &target(), true).unwrap();
        confirm_speed_limit_correction(&f.store, &*f.clock, &cfg, &target(), false).unwrap();
        assert_eq!(f.store.pending_writes().unwrap().len(), 1);
        let key = generate_ed25519_keypair().unwrap();

        let outcomes = flush_pending(&f.store, &f.discovery, &*f.clock, "token", Some(&key))
            .await
            .unwrap();

        assert!(matches!(
            outcomes.as_slice(),
            [FlushOutcome::Submitted { merged: true, .. }]
        ));
        let bodies = f.transport.bodies_to(confirmations_url);
        let sent = &bodies[0];
        assert_eq!(sent["kind"], "deny");
        let payload = &sent["deviceAssertion"]["payload"];
        assert_eq!(payload["vote"], "deny");
        assert_eq!(payload["segmentKey"], KEY);
        assert_eq!(payload["value"], 30);
        assert_eq!(payload["unit"], "kmh");
        assert!(payload.get("reason").is_none());
    }

    #[test]
    fn a_confirmation_needs_the_feature_to_be_offered() {
        let f = one_server();

        let result =
            confirm_speed_limit_correction(&f.store, &*f.clock, &config(None), &target(), true);

        assert_eq!(result, Err(CorrectionError::NotOffered));
        assert!(f.store.pending_writes().unwrap().is_empty());
    }

    #[test]
    fn only_a_segment_that_carries_a_correction_yields_a_target() {
        let plain = segment("s1", Some(KEY));
        assert_eq!(CorrectionTarget::from_segment(&plain), None);

        let mut corrected = segment("s1", Some(KEY));
        corrected.speed_limit = 30.0;
        corrected.corrected_by = Some("community".to_string());
        corrected.correction = Some(SegmentCorrection {
            id: "c1".to_string(),
            confirmations: 3,
            denials: 0,
            applied_at: None,
            needs_review: false,
        });
        assert_eq!(CorrectionTarget::from_segment(&corrected), Some(target()));
    }

    #[test]
    fn the_correction_id_is_derived_exactly_like_the_servers() {
        assert_eq!(
            correction_id(KEY, SpeedLimitUnit::Kmh, 30),
            "acfbf09f-e41f-0981-0363-822e37b8f80f"
        );
        assert_eq!(
            correction_id(KEY, SpeedLimitUnit::Mph, 40),
            "0598f390-e544-7e15-681c-cc0828044ab6"
        );
    }

    #[test]
    fn a_proposal_knows_its_correction_id_before_it_is_sent() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        let cfg = config(Some(rules(true)));

        let proposal =
            report_wrong_speed_limit(&f.store, &*f.clock, &cfg, &report("s1", 30)).unwrap();

        assert_eq!(
            proposal.correction_id.as_deref(),
            Some("acfbf09f-e41f-0981-0363-822e37b8f80f")
        );
    }

    fn own_target() -> CorrectionTarget {
        CorrectionTarget {
            correction_id: correction_id(KEY, SpeedLimitUnit::Kmh, 30),
            segment_key: KEY.to_string(),
            value: 30,
            unit: SpeedLimitUnit::Kmh,
        }
    }

    #[test]
    fn objecting_to_ones_own_still_queued_proposal_just_cancels_it() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        let cfg = config(Some(rules(true)));
        report_wrong_speed_limit(&f.store, &*f.clock, &cfg, &report("s1", 30)).unwrap();

        let queued =
            confirm_speed_limit_correction(&f.store, &*f.clock, &cfg, &own_target(), false)
                .unwrap();

        assert_eq!(queued, None);
        assert!(f.store.pending_writes().unwrap().is_empty());
        assert!(f.store.local_proposals().unwrap().is_empty());
    }

    #[tokio::test]
    async fn objecting_to_ones_own_sent_proposal_withdraws_the_overlay_and_queues_the_objection() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        f.transport.set(S1_URL, 201, accepted("c1", 1));
        let cfg = config(Some(rules(true)));
        report_wrong_speed_limit(&f.store, &*f.clock, &cfg, &report("s1", 30)).unwrap();
        flush_pending(&f.store, &f.discovery, &*f.clock, "token", None)
            .await
            .unwrap();

        let queued =
            confirm_speed_limit_correction(&f.store, &*f.clock, &cfg, &own_target(), false)
                .unwrap();

        assert!(queued.is_some());
        assert!(f.store.local_proposals().unwrap().is_empty());
        let pending = f.store.pending_writes().unwrap();
        assert_eq!(pending.len(), 1);
        assert!(matches!(
            pending[0].kind,
            WriteKind::SpeedLimitConfirmation { agrees: false, .. }
        ));
    }

    #[test]
    fn confirming_ones_own_proposal_changes_nothing_locally() {
        let f = one_server();
        add_segments(&f, vec![segment("s1", Some(KEY))]);
        let cfg = config(Some(rules(true)));
        report_wrong_speed_limit(&f.store, &*f.clock, &cfg, &report("s1", 30)).unwrap();

        confirm_speed_limit_correction(&f.store, &*f.clock, &cfg, &own_target(), true).unwrap();

        assert_eq!(f.store.local_proposals().unwrap().len(), 1);
    }

    fn open_proposal_json() -> serde_json::Value {
        serde_json::json!({
            "id": "c9",
            "segmentKey": KEY,
            "segmentId": "s1",
            "value": 30,
            "unit": "kmh",
            "status": "proposed",
            "reason": null,
            "confirmations": 1,
            "denials": 0,
            "firstProposedAt": "2026-09-24T12:00:00.000Z",
            "lastVoteAt": "2026-09-24T12:00:00.000Z",
            "appliedAt": null,
            "importedSpeedLimit": 50,
            "needsReview": false,
            "source": "community"
        })
    }

    #[tokio::test]
    async fn open_proposals_can_be_fetched_and_confirmed_from_their_entry() {
        let f = one_server();
        f.transport.set(
            "https://a.example/v1/speed-limit-corrections?tiles=t1,t2",
            200,
            serde_json::json!({ "corrections": [open_proposal_json()] }),
        );
        let tiles = vec!["t1".to_string(), "t2".to_string()];

        let corrections = fetch_corrections(&f.discovery, "token", &tiles)
            .await
            .unwrap();

        assert_eq!(corrections.len(), 1);
        assert_eq!(corrections[0].status, "proposed");
        assert_eq!(corrections[0].confirmations, 1);
        let target = CorrectionTarget::from_correction(&corrections[0]);
        assert_eq!(target.correction_id, "c9");
        assert_eq!(target.value, 30);
    }

    #[tokio::test]
    async fn a_server_without_corrections_yields_an_empty_list_not_an_error() {
        let f = one_server();
        f.transport.set(
            "https://a.example/v1/speed-limit-corrections?tiles=t1",
            404,
            serde_json::json!({}),
        );

        let corrections = fetch_corrections(&f.discovery, "token", &["t1".to_string()])
            .await
            .unwrap();

        assert!(corrections.is_empty());
        let none = fetch_corrections(&f.discovery, "token", &[]).await.unwrap();
        assert!(none.is_empty());
    }
}
