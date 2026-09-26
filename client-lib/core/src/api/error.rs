//! One error type for the whole public API, the same in every binding: a
//! short machine-readable `code` a host app can branch on, and a `message`
//! for logs.

use serde::Serialize;

use crate::discovery::DiscoveryError;
use crate::storage::StoreError;
use crate::sync::{AuthError, CorrectionError, SyncError, WriteBufferError};

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
        match error {
            CorrectionError::NotOffered => ApiError::new(
                code::NOT_OFFERED,
                "the server does not offer speed-limit corrections",
            ),
            CorrectionError::UnknownSegment => ApiError::new(
                code::UNKNOWN_SEGMENT,
                "no speed-limit segment matches",
            ),
            CorrectionError::Store(message) => ApiError::new(code::STORAGE, message),
            other => ApiError::invalid(other.to_string()),
        }
    }
}
