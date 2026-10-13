//! The road network, online-only calls (server 1.1.0, `server/docs/road-network.md`).
//!
//! * [`resolve_road_interval`] — which stretch of which road two picked points name: the preview a host draws (grey, along the
//!   road's own shape) before anybody proposes a value, with what is on record there and what is proposed for it.
//! * [`fetch_data_defects_near`] / [`report_data_defect`] — "this entry is wrong": the entries near a point that can be
//!   marked, and the mark. An entry is taken out once enough distinct devices have marked it.
//!
//! Nothing here is queued or kept: both ask a server and return what it said, so a host that is offline gets an error it can
//! show. (A *proposal* for a stretch is different: it is queued and effective at once, see `sync::corrections`.)

use serde::{Deserialize, Serialize};

use crate::discovery::{DiscoveryError, DiscoveryService};
use crate::platform::HttpRequest;

use super::corrections::Correction;
use super::intervals::IntervalPoint;
use super::types::Geometry;

/// What the server found for two picked points.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadInterval {
    /// `ivl:…` reference of the two points (what a device signs).
    #[serde(rename = "ref")]
    pub reference: String,
    pub segment_key: String,
    /// The stretch along the road's own shape, between the two points on the road.
    pub geometry: Geometry,
    pub length_m: f64,
    pub road: RoadName,
    /// Limits already on record under the stretch (what a proposal would replace).
    #[serde(default)]
    pub covered: Vec<CoveredLimit>,
    /// Proposals and applied values for exactly this stretch.
    #[serde(default)]
    pub proposals: Vec<Correction>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadName {
    pub name: Option<String>,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub class: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoveredLimit {
    pub segment_id: String,
    pub segment_key: String,
    pub speed_limit: f64,
    pub unit: String,
    pub source: String,
    pub covered_meters: f64,
}

/// An entry near a point that can be marked as wrong.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDefect {
    /// `speedLimitSegment` or `staticSign`.
    pub target_type: String,
    pub target_id: String,
    pub distance_meters: f64,
    #[serde(default)]
    pub speed_limit: Option<f64>,
    #[serde(default)]
    pub speed_limit_unit: Option<String>,
    #[serde(default)]
    pub sign_type: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub geometry: Option<Geometry>,
    #[serde(default)]
    pub position: Option<Geometry>,
    /// How many distinct devices have marked it so far.
    pub reports: u32,
    /// How many it takes to take the entry out.
    pub threshold: u32,
}

/// The node's answer to a mark.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefectReportAnswer {
    /// `false`: this device had marked the entry before.
    pub recorded: bool,
    pub reports: u32,
    pub threshold: u32,
    /// The entry is out now.
    pub removed: bool,
}

/// Why a road-network call failed: the server's own code when it gave one (`NO_ROAD_FOUND`, …).
#[derive(Debug, Clone, PartialEq)]
pub enum RoadError {
    /// The server does not offer this (older, or switched off).
    NotOffered,
    /// The server refused with a code of its own.
    Refused {
        status: u16,
        code: String,
        message: String,
    },
    Transport(String),
}

impl From<DiscoveryError> for RoadError {
    fn from(error: DiscoveryError) -> Self {
        RoadError::Transport(error.to_string())
    }
}

fn refusal(response: &crate::platform::HttpResponse) -> RoadError {
    let body = response.json().ok();
    let error = body.as_ref().and_then(|v| v.get("error"));
    let text = |key: &str| {
        error
            .and_then(|e| e.get(key))
            .and_then(|c| c.as_str())
            .map(str::to_string)
    };
    RoadError::Refused {
        status: response.status,
        code: text("code").unwrap_or_else(|| format!("HTTP_{}", response.status)),
        message: text("message").unwrap_or_else(|| format!("HTTP {}", response.status)),
    }
}

fn point_json(p: IntervalPoint) -> serde_json::Value {
    serde_json::json!({ "lat": p.lat, "lng": p.lng })
}

/// `POST /v1/roads/resolve`.
pub async fn resolve_road_interval(
    discovery: &DiscoveryService,
    bearer_token: &str,
    from: IntervalPoint,
    to: IntervalPoint,
) -> Result<RoadInterval, RoadError> {
    let body = serde_json::json!({ "from": point_json(from), "to": point_json(to) });
    let (_, response) = discovery
        .request_with_failover(|server| {
            let url = format!("{}/v1/roads/resolve", server.address.trim_end_matches('/'));
            HttpRequest::post_json(url, &body)
                .expect("a JSON body serialises")
                .with_header("Authorization", format!("Bearer {bearer_token}"))
        })
        .await?;
    if response.status == 404 {
        return Err(RoadError::NotOffered);
    }
    if !response.is_success() {
        return Err(refusal(&response));
    }
    response
        .json()
        .ok()
        .and_then(|v| serde_json::from_value::<RoadInterval>(v).ok())
        .ok_or_else(|| RoadError::Transport("unexpected road answer".to_string()))
}

/// `GET /v1/data-defects/near`.
pub async fn fetch_data_defects_near(
    discovery: &DiscoveryService,
    bearer_token: &str,
    lat: f64,
    lng: f64,
    radius_meters: f64,
) -> Result<Vec<DataDefect>, RoadError> {
    #[derive(Deserialize)]
    struct Items {
        items: Vec<DataDefect>,
    }
    let (_, response) = discovery
        .request_with_failover(|server| {
            let url = format!(
                "{}/v1/data-defects/near?lat={lat}&lng={lng}&radiusM={radius_meters}",
                server.address.trim_end_matches('/')
            );
            HttpRequest::get(url).with_header("Authorization", format!("Bearer {bearer_token}"))
        })
        .await?;
    if response.status == 404 {
        return Err(RoadError::NotOffered);
    }
    if !response.is_success() {
        return Err(refusal(&response));
    }
    response
        .json()
        .ok()
        .and_then(|v| serde_json::from_value::<Items>(v).ok())
        .map(|items| items.items)
        .ok_or_else(|| RoadError::Transport("unexpected defects answer".to_string()))
}

/// `POST /v1/data-defects`.
pub async fn report_data_defect(
    discovery: &DiscoveryService,
    bearer_token: &str,
    target_type: &str,
    target_id: &str,
    reason: Option<&str>,
) -> Result<DefectReportAnswer, RoadError> {
    let mut body = serde_json::json!({ "targetType": target_type, "targetId": target_id });
    if let Some(reason) = reason {
        body["reason"] = serde_json::json!(reason);
    }
    let (_, response) = discovery
        .request_with_failover(|server| {
            let url = format!("{}/v1/data-defects", server.address.trim_end_matches('/'));
            HttpRequest::post_json(url, &body)
                .expect("a JSON body serialises")
                .with_header("Authorization", format!("Bearer {bearer_token}"))
        })
        .await?;
    // `404` is what an entry that is gone answers (and what a server without the feature answers): the server's own
    // words are passed on either way.
    if !response.is_success() {
        return Err(refusal(&response));
    }
    response
        .json()
        .ok()
        .and_then(|v| serde_json::from_value::<DefectReportAnswer>(v).ok())
        .ok_or_else(|| RoadError::Transport("unexpected defect answer".to_string()))
}
