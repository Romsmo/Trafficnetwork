//! One error type for the whole public API, the same in every binding: a
//! short machine-readable `code` a host app can branch on, and a `message`
//! for logs.

use serde::Serialize;

use crate::discovery::DiscoveryError;
use crate::storage::StoreError;
use crate::sync::{
    AuthError, ContextSignError, CorrectionError, RoadError, SyncError, WriteBufferError,
};

/// The `code` values an [`ApiError`] can carry.
pub mod code {
    /// The call's arguments are not acceptable (unknown method, wrong shape,
    /// a value out of range).
    pub const INVALID_ARGUMENT: &str = "invalidArgument";
    /// The client has no credentials, so it cannot talk to a server.
    pub const NOT_CONFIGURED: &str = "notConfigured";
    /// The server does not offer this feature (an older server, or the
    /// operator switched it off) — hide it in the UI.
    pub const NOT_OFFERED: &str = "notOffered";
    /// The segment or position named does not match anything stored.
    pub const UNKNOWN_SEGMENT: &str = "unknownSegment";
    /// The local store is out of space. Nothing already stored is lost and
    /// the next sync resumes where this one stopped: free some space, then
    /// call again.
    pub const STORAGE_FULL: &str = "storageFull";
    /// Any other local storage failure.
    pub const STORAGE: &str = "storage";
    /// No server could be reached, or one answered with something unusable.
    pub const NETWORK: &str = "network";
    /// The server refused the credentials.
    pub const AUTH: &str = "auth";
    /// The server refused the request itself.
    pub const REJECTED: &str = "rejected";
    /// The data the call needs is not there yet (for example: the server's
    /// configuration has not been fetched, sync once first).
    pub const UNAVAILABLE: &str = "unavailable";
    /// The duration asked for a report is outside what the server accepts for that type. Nothing was
    /// queued; `getReportLimits` gives the bounds.
    pub const TTL_OUT_OF_RANGE: &str = "ttlOutOfRange";
    /// The server has no road data for that area and cannot look it up (`resolveRoadInterval`).
    pub const NO_ROAD_DATA: &str = "noRoadData";
    /// No road was found near one of the two points: tap closer to the road.
    pub const NO_ROAD_FOUND: &str = "noRoadFound";
    /// The two points are not on one road that runs between them.
    pub const NO_ROAD_BETWEEN_POINTS: &str = "noRoadBetweenPoints";
    /// The two points are further apart than one stretch may be (the server's `roadNetwork.intervalMaxMeters`).
    pub const INTERVAL_TOO_LONG: &str = "intervalTooLong";
    /// The two points are closer together than a stretch can be.
    pub const INTERVAL_TOO_SHORT: &str = "intervalTooShort";
    /// The sign is not in the server catalogue (`DE:276` ...).
    pub const UNKNOWN_SIGN: &str = "unknownSign";
    /// The sign covers a stretch: give where it ends.
    pub const SIGN_NEEDS_TWO_POINTS: &str = "signNeedsTwoPoints";
    /// A sign at one place that applies one way needs the direction of travel.
    pub const HEADING_REQUIRED: &str = "headingRequired";
    /// The stretch is longer than this sign may cover.
    pub const STRETCH_TOO_LONG: &str = "stretchTooLong";
    /// The value is missing, out of range or does not fit the sign.
    pub const INVALID_VALUE: &str = "invalidValue";
    /// The time zone, the times or the period are not acceptable (or a temporary sign has no end).
    pub const INVALID_VALIDITY: &str = "invalidValidity";
    /// The stretch is not on a road the server knows.
    pub const SHAPE_OFF_ROAD: &str = "shapeOffRoad";
    /// The client was closed.
    pub const CLOSED: &str = "closed";
    pub const INTERNAL: &str = "internal";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new(code::INVALID_ARGUMENT, message)
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

fn store_error(error: &StoreError) -> ApiError {
    if crate::storage::is_storage_full(error) {
        ApiError::new(code::STORAGE_FULL, "the local store is out of space")
    } else {
        ApiError::new(code::STORAGE, error.to_string())
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        store_error(&error)
    }
}

impl From<DiscoveryError> for ApiError {
    fn from(error: DiscoveryError) -> Self {
        ApiError::new(code::NETWORK, error.to_string())
    }
}

impl From<SyncError> for ApiError {
    fn from(error: SyncError) -> Self {
        match error {
            SyncError::StorageFull => {
                ApiError::new(code::STORAGE_FULL, "the local store is out of space")
            }
            SyncError::Store(e) => store_error(&e),
            SyncError::Discovery(e) => ApiError::from(e),
            SyncError::InvalidResponse(message) => ApiError::new(code::NETWORK, message),
            SyncError::Rejected { status, body } => {
                let code = if status == 401 || status == 403 {
                    code::AUTH
                } else {
                    code::REJECTED
                };
                ApiError::new(code, format!("HTTP {status}: {body}"))
            }
        }
    }
}

impl From<AuthError> for ApiError {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::Discovery(e) => ApiError::from(e),
            other => ApiError::new(code::AUTH, other.to_string()),
        }
    }
}

impl From<WriteBufferError> for ApiError {
    fn from(error: WriteBufferError) -> Self {
        match error {
            WriteBufferError::Store(e) => store_error(&e),
            WriteBufferError::Signing(message) => ApiError::new(code::INTERNAL, message),
            WriteBufferError::InvalidInput(message) => ApiError::invalid(message),
        }
    }
}

impl From<CorrectionError> for ApiError {
    fn from(error: CorrectionError) -> Self {
        match &error {
            CorrectionError::NotOffered => ApiError::new(
                code::NOT_OFFERED,
                "the server does not offer speed-limit corrections",
            ),
            CorrectionError::UnknownSegment => {
                ApiError::new(code::UNKNOWN_SEGMENT, "no speed-limit segment matches")
            }
            CorrectionError::Store(message) => ApiError::new(code::STORAGE, message),
            CorrectionError::IntervalTooShort { .. } => {
                ApiError::new(code::INTERVAL_TOO_SHORT, error.to_string())
            }
            other => ApiError::invalid(other.to_string()),
        }
    }
}

impl From<ContextSignError> for ApiError {
    fn from(error: ContextSignError) -> Self {
        match error {
            ContextSignError::NotOffered => ApiError::new(code::NOT_OFFERED, "the server does not offer context signs (an older server, or the operator switched them off)"),
            ContextSignError::Transport(message) => ApiError::new(code::NETWORK, message),
            ContextSignError::Store(message) => ApiError::new(code::STORAGE, message),
            ContextSignError::StorageFull => ApiError::new(code::STORAGE_FULL, "the local store is out of space"),
            ContextSignError::Invalid(message) => ApiError::invalid(message),
            ContextSignError::Refused { status, code: server_code, message } => {
                let mapped = match server_code.as_str() {
                    "NO_ROAD_DATA" => code::NO_ROAD_DATA,
                    "NO_ROAD_FOUND" => code::NO_ROAD_FOUND,
                    "NO_ROAD_BETWEEN_POINTS" => code::NO_ROAD_BETWEEN_POINTS,
                    "INTERVAL_TOO_LONG" => code::INTERVAL_TOO_LONG,
                    "INTERVAL_TOO_SHORT" => code::INTERVAL_TOO_SHORT,
                    "UNKNOWN_SIGN" => code::UNKNOWN_SIGN,
                    "SIGN_NEEDS_TWO_POINTS" => code::SIGN_NEEDS_TWO_POINTS,
                    "HEADING_REQUIRED" => code::HEADING_REQUIRED,
                    "STRETCH_TOO_LONG" => code::STRETCH_TOO_LONG,
                    "VALUE_REQUIRED" | "INVALID_VALUE" => code::INVALID_VALUE,
                    "INVALID_TIMEZONE" | "INVALID_WINDOW" | "INVALID_PERIOD" | "PERIOD_REQUIRED" | "PERIOD_TOO_LONG" => code::INVALID_VALIDITY,
                    "SHAPE_OFF_ROAD" => code::SHAPE_OFF_ROAD,
                    _ if status == 401 || status == 403 => code::AUTH,
                    _ => code::REJECTED,
                };
                ApiError::new(mapped, message)
            }
        }
    }
}

impl From<RoadError> for ApiError {
    fn from(error: RoadError) -> Self {
        match error {
            RoadError::NotOffered => ApiError::new(
                code::NOT_OFFERED,
                "the server does not offer this (an older server, or the operator switched it off)",
            ),
            RoadError::Transport(message) => ApiError::new(code::NETWORK, message),
            RoadError::Refused {
                status,
                code: server_code,
                message,
            } => {
                let mapped = match server_code.as_str() {
                    "NO_ROAD_DATA" => code::NO_ROAD_DATA,
                    "NO_ROAD_FOUND" => code::NO_ROAD_FOUND,
                    "NO_ROAD_BETWEEN_POINTS" => code::NO_ROAD_BETWEEN_POINTS,
                    "INTERVAL_TOO_LONG" => code::INTERVAL_TOO_LONG,
                    "INTERVAL_TOO_SHORT" => code::INTERVAL_TOO_SHORT,
                    _ if status == 429 => code::REJECTED,
                    _ => code::REJECTED,
                };
                ApiError::new(mapped, message)
            }
        }
    }
}
