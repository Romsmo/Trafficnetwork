//! The same API as a single JSON call — `call("getSpeedLimitAt", {...})` —
//! which is what every binding is built on. Arguments and results are JSON
//! with `camelCase` names, errors are [`ApiError`]s. A binding therefore
//! needs one function instead of one per method, and every language sees
//! exactly the same names, shapes and behaviour: the conformance tests
//! (`client-lib/conformance`) run the same scenarios through each binding.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::sync::{
    Correction, CorrectionReason, CorrectionTarget, MissingSpeedLimitReport, SpeedLimitUnit,
    WrongSpeedLimitReport,
};

use super::client::{segment_ref, TrafficNetworkClient};
use super::error::ApiError;
use super::types::NearbyCategory;

/// Bumped when a method or a result shape changes incompatibly.
pub const API_VERSION: u32 = 1;

fn parse<T: DeserializeOwned>(method: &str, args: Value) -> Result<T, ApiError> {
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args).map_err(|e| ApiError::invalid(format!("{method}: {e}")))
}

fn to_json<T: Serialize>(value: T) -> Result<Value, ApiError> {
    serde_json::to_value(value)
        .map_err(|e| ApiError::new(super::error::code::INTERNAL, e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PositionArgs {
    lat: f64,
    lng: f64,
    heading: Option<f64>,
    speed_kmh: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NearbyArgs {
    lat: f64,
    lng: f64,
    radius_meters: f64,
    #[serde(default)]
    categories: Vec<NearbyCategory>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitReportArgs {
    #[serde(rename = "type")]
    hazard_type: String,
    lat: f64,
    lng: f64,
    speed_kmh: Option<f64>,
    /// How long the report should live, in seconds (optional; within `getReportLimits`).
    ttl_seconds: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportLimitsArgs {
    #[serde(rename = "type")]
    hazard_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmReportArgs {
    report_id: String,
    still_there: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CameraArgs {
    camera_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WrongLimitArgs {
    segment_id: Option<String>,
    lat: Option<f64>,
    lng: Option<f64>,
    proposed_value: u32,
    unit: SpeedLimitUnit,
    reason: Option<CorrectionReason>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MissingLimitArgs {
    lat: f64,
    lng: f64,
    /// A heading along the road, either direction (0..360); the last heading given is used when absent.
    bearing: Option<f64>,
    value: u32,
    unit: SpeedLimitUnit,
    reason: Option<CorrectionReason>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmCorrectionArgs {
    /// The segment whose current community correction is voted on…
    segment_id: Option<String>,
    /// …or a correction from `fetchCorrections`.
    correction: Option<Correction>,
    agrees: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageLimitsArgs {
    /// A number sets the limit, `null` removes it, absent leaves it.
    #[serde(default, deserialize_with = "double_option")]
    max_bytes: Option<Option<u64>>,
    wifi_only: Option<bool>,
}

fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeteredArgs {
    metered: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverageArgs {
    lat: f64,
    lng: f64,
}

fn local_id(id: String) -> Value {
    json!({ "localId": id })
}

impl TrafficNetworkClient {
    /// Runs one API method given by name — see the module documentation.
    pub async fn call(&self, method: &str, args: Value) -> Result<Value, ApiError> {
        match method {
            "version" => Ok(json!({
                "apiVersion": API_VERSION,
                "libraryVersion": env!("CARGO_PKG_VERSION"),
            })),
            "getSpeedLimitAt" => {
                let a: PositionArgs = parse(method, args)?;
                self.set_last_heading(a.heading);
                to_json(self.get_speed_limit_at(a.lat, a.lng, a.heading)?)
            }
            "getNearby" => {
                let a: NearbyArgs = parse(method, args)?;
                let items = self.get_nearby(a.lat, a.lng, a.radius_meters, &a.categories)?;
                Ok(json!({ "items": to_json(items)? }))
            }
            "submitReport" => {
                let a: SubmitReportArgs = parse(method, args)?;
                let submitted = self.submit_report_with_duration(
                    &a.hazard_type,
                    a.lat,
                    a.lng,
                    a.speed_kmh,
                    a.ttl_seconds,
                )?;
                to_json(submitted)
            }
            "getReportLimits" => {
                let a: ReportLimitsArgs = parse(method, args)?;
                to_json(self.get_report_limits(&a.hazard_type)?)
            }
            "confirmReport" => {
                let a: ConfirmReportArgs = parse(method, args)?;
                Ok(local_id(self.confirm_report(&a.report_id, a.still_there)?))
            }
            "reportCameraRemoved" => {
                let a: CameraArgs = parse(method, args)?;
                Ok(local_id(self.report_camera_removed(&a.camera_id)?))
            }
            "reportWrongSpeedLimit" => {
                let a: WrongLimitArgs = parse(method, args)?;
                let segment = segment_ref(a.segment_id, a.lat.zip(a.lng))?;
                let proposal = self.report_wrong_speed_limit(&WrongSpeedLimitReport {
                    segment,
                    proposed_value: a.proposed_value,
                    unit: a.unit,
                    reason: a.reason,
                })?;
                to_json(proposal)
            }
            "reportMissingSpeedLimit" => {
                let a: MissingLimitArgs = parse(method, args)?;
                to_json(self.report_missing_speed_limit(&MissingSpeedLimitReport {
                    lat: a.lat,
                    lng: a.lng,
                    bearing_degrees: a.bearing,
                    value: a.value,
                    unit: a.unit,
                    reason: a.reason,
                })?)
            }
            "lookupSpeedLimit" => {
                let a: PositionArgs = parse(method, args)?;
                to_json(self.lookup_speed_limit(a.lat, a.lng, a.heading).await?)
            }
            "confirmSpeedLimitCorrection" => {
                let a: ConfirmCorrectionArgs = parse(method, args)?;
                let target = match (a.correction, a.segment_id) {
                    (Some(correction), _) => CorrectionTarget::from_correction(&correction),
                    (None, Some(segment_id)) => self.correction_target_for_segment(&segment_id)?,
                    (None, None) => {
                        return Err(ApiError::invalid(
                            "name a correction, or a segment that carries one",
                        ))
                    }
                };
                let id = self.confirm_speed_limit_correction(&target, a.agrees)?;
                Ok(json!({ "localId": id }))
            }
            "fetchCorrections" => {
                let corrections = self.fetch_corrections().await?;
                Ok(json!({ "corrections": to_json(corrections)? }))
            }
            "getOfflineSettings" => to_json(self.get_offline_settings()?),
            "setOfflineRegions" => {
                let patch: super::offline::OfflineSettingsPatch = parse(method, args)?;
                to_json(self.apply_offline_regions(&patch)?)
            }
            "setAutoRegionPolicy" => {
                let patch: super::offline::AutoPolicyPatch = parse(method, args)?;
                to_json(self.apply_auto_region_policy(&patch)?)
            }
            "setStorageLimits" => {
                let a: StorageLimitsArgs = parse(method, args)?;
                to_json(self.set_storage_limits(a.max_bytes, a.wifi_only)?)
            }
            "setConnectionMetered" => {
                let a: MeteredArgs = parse(method, args)?;
                self.set_connection_metered(a.metered);
                Ok(json!({}))
            }
            "listOfflineRegions" => {
                Ok(json!({ "regions": to_json(self.list_offline_regions().await?)? }))
            }
            "getStoragePlan" => to_json(self.get_storage_plan().await?),
            "getStorageUsage" => to_json(self.get_storage_usage()?),
            "getCoverage" => {
                let a: CoverageArgs = parse(method, args)?;
                to_json(self.get_coverage(a.lat, a.lng)?)
            }
            "updatePosition" => {
                let a: PositionArgs = parse(method, args)?;
                self.set_last_heading(a.heading);
                to_json(self.update_position(a.lat, a.lng, a.speed_kmh)?)
            }
            "sync" => to_json(self.sync().await?),
            "tick" => to_json(self.tick().await?),
            "planBootstrap" => to_json(self.plan_bootstrap().await?),
            "getSyncStatus" => to_json(self.get_sync_status()?),
            "getNetworkStatus" => to_json(self.get_network_status()?),
            "getCameraPolicy" => to_json(self.get_camera_policy()?),
            "pollEvents" => Ok(json!({ "events": to_json(self.poll_events())? })),
            "close" => {
                self.close();
                Ok(json!({}))
            }
            other => Err(ApiError::invalid(format!("unknown method `{other}`"))),
        }
    }
}
