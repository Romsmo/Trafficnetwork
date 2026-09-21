//! Client-credential and device-key auth flows against `/v1/auth/*` and
//! `/v1/devices/*` (`server/docs/api.md` "Auth"/"Device registration") — the
//! sync engine needs a bearer token for every endpoint it calls except
//! `GET /v1/network/{directory,node-info}`, and this is the one place that
//! token comes from. Every call goes through `DiscoveryService::request_with_failover`
//! like any other sync-engine request, so a token exchange itself benefits
//! from the same pool/failover behavior as bootstrap/delta.

use serde::{Deserialize, Serialize};

use crate::crypto::{sign_envelope, Ed25519KeyPair, SignedEnvelope};
use crate::discovery::{DiscoveryError, DiscoveryService};
use crate::platform::{Clock, HttpRequest, HttpResponse};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenResponse {
    #[serde(rename = "accessToken")]
    pub access_token: String,
    #[serde(rename = "tokenType")]
    pub token_type: String,
    #[serde(rename = "expiresIn")]
    pub expires_in: i64,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceRegistration {
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(rename = "clientSecret")]
    pub client_secret: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BindKeyResponse {
    pub bound: bool,
    #[serde(rename = "publicKey")]
    pub public_key: String,
}

#[derive(Debug, Clone)]
pub enum AuthError {
    Discovery(DiscoveryError),
    /// The server answered but rejected the request (e.g. `401 Unauthorized`,
    /// or the expected `409 KEY_ALREADY_BOUND` on a second bind-key attempt)
    /// — carries the raw status/body for the caller to inspect rather than
    /// collapsing every non-2xx response into one opaque error.
    Rejected { status: u16, body: String },
    InvalidResponse(String),
    Signing(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::Discovery(e) => write!(f, "discovery error: {e}"),
            AuthError::Rejected { status, body } => {
                write!(f, "server rejected the request (HTTP {status}): {body}")
            }
            AuthError::InvalidResponse(msg) => write!(f, "invalid response: {msg}"),
            AuthError::Signing(msg) => write!(f, "signing error: {msg}"),
        }
    }
}

impl std::error::Error for AuthError {}

fn parse_response<T: serde::de::DeserializeOwned>(response: &HttpResponse) -> Result<T, AuthError> {
    if !response.is_success() {
        let body = String::from_utf8_lossy(&response.body).to_string();
        return Err(AuthError::Rejected {
            status: response.status,
            body,
        });
    }
    let value = response
        .json()
        .map_err(|e| AuthError::InvalidResponse(e.to_string()))?;
    serde_json::from_value(value).map_err(|e| AuthError::InvalidResponse(e.to_string()))
}

fn unix_ms_to_rfc3339(unix_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(unix_ms)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

/// `POST /v1/auth/token` — the client-secret exchange every device starts
/// with, before optionally upgrading to a bound device key ([`device_token`]).
pub async fn exchange_client_secret(
    discovery: &DiscoveryService,
    client_id: &str,
    client_secret: &str,
) -> Result<TokenResponse, AuthError> {
    let body = serde_json::json!({ "clientId": client_id, "clientSecret": client_secret });
    let (_, response) = discovery
        .request_with_failover(|server| {
            let url = format!("{}/v1/auth/token", server.address.trim_end_matches('/'));
            HttpRequest::post_json(url, &body).expect("client-credential body always serializes")
        })
        .await
        .map_err(AuthError::Discovery)?;
    parse_response(&response)
}

/// `POST /v1/devices/register` — mints a fresh anonymous device credential
/// using an app-key bearer token (scope `device-registration`). The device
/// then calls [`exchange_client_secret`] with the returned credential like
/// any other client.
pub async fn register_device(
    discovery: &DiscoveryService,
    app_key_bearer_token: &str,
) -> Result<DeviceRegistration, AuthError> {
    let (_, response) = discovery
        .request_with_failover(|server| {
            let url = format!("{}/v1/devices/register", server.address.trim_end_matches('/'));
            HttpRequest::post_json(url, &serde_json::json!({}))
                .expect("empty body always serializes")
                .with_header("Authorization", format!("Bearer {app_key_bearer_token}"))
        })
        .await
        .map_err(AuthError::Discovery)?;
    parse_response(&response)
}

#[derive(Debug, Clone, Serialize)]
struct BindKeyPayload {
    #[serde(rename = "publicKey")]
    public_key: String,
    timestamp: String,
}

/// `POST /v1/devices/bind-key` — binds `key_pair`'s public half to the
/// client identity behind `bearer_token`, proving possession of the new
/// key's private half via the signature itself (the bearer token only
/// proves *which* client is asking, per `server/docs/api.md`). One-shot per
/// client — a second call returns `AuthError::Rejected { status: 409, .. }`.
pub async fn bind_device_key(
    discovery: &DiscoveryService,
    clock: &dyn Clock,
    bearer_token: &str,
    key_pair: &Ed25519KeyPair,
) -> Result<BindKeyResponse, AuthError> {
    let payload = BindKeyPayload {
        public_key: key_pair.public_key_raw.clone(),
        timestamp: unix_ms_to_rfc3339(clock.now_unix_ms()),
    };
    let assertion =
        sign_envelope(payload, key_pair).map_err(|e| AuthError::Signing(e.to_string()))?;
    let body = serde_json::json!({ "assertion": assertion });
    let (_, response) = discovery
        .request_with_failover(|server| {
            let url = format!("{}/v1/devices/bind-key", server.address.trim_end_matches('/'));
            HttpRequest::post_json(url, &body)
                .expect("assertion body always serializes")
                .with_header("Authorization", format!("Bearer {bearer_token}"))
        })
        .await
        .map_err(AuthError::Discovery)?;
    parse_response(&response)
}

#[derive(Debug, Clone, Serialize)]
struct DeviceTokenPayload {
    #[serde(rename = "clientId")]
    client_id: String,
    timestamp: String,
}

/// `POST /v1/auth/device-token` — additive alternative to
/// [`exchange_client_secret`] for a client that has bound a device key: same
/// response shape, proved by a signature instead of the shared secret.
pub async fn device_token(
    discovery: &DiscoveryService,
    clock: &dyn Clock,
    client_id: &str,
    key_pair: &Ed25519KeyPair,
) -> Result<TokenResponse, AuthError> {
    let payload = DeviceTokenPayload {
        client_id: client_id.to_string(),
        timestamp: unix_ms_to_rfc3339(clock.now_unix_ms()),
    };
    let assertion: SignedEnvelope<DeviceTokenPayload> =
        sign_envelope(payload, key_pair).map_err(|e| AuthError::Signing(e.to_string()))?;
    let body = serde_json::json!({ "clientId": client_id, "assertion": assertion });
    let (_, response) = discovery
        .request_with_failover(|server| {
            let url = format!("{}/v1/auth/device-token", server.address.trim_end_matches('/'));
            HttpRequest::post_json(url, &body).expect("device-token body always serializes")
        })
        .await
        .map_err(AuthError::Discovery)?;
    parse_response(&response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::generate_ed25519_keypair;
    use crate::discovery::DiscoveryConfig;
    use crate::platform::{HttpError, HttpTransport};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::{Arc, Mutex};

    struct FixedClock(AtomicI64);
    impl Clock for FixedClock {
        fn now_unix_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct MockTransport {
        responses: Mutex<HashMap<String, HttpResponse>>,
    }
    impl MockTransport {
        fn new() -> Self {
            Self {
                responses: Mutex::new(HashMap::new()),
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
    }
    #[async_trait::async_trait]
    impl HttpTransport for MockTransport {
        async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
            self.responses
                .lock()
                .unwrap()
                .get(&request.url)
                .cloned()
                .ok_or_else(|| HttpError::Network(format!("no mock response for {}", request.url)))
        }
    }

    fn service_with_one_server(transport: Arc<MockTransport>) -> DiscoveryService {
        let clock = Arc::new(FixedClock(AtomicI64::new(0)));
        let service = DiscoveryService::new(transport, clock, DiscoveryConfig::default());
        service.seed_fixed_nodes(&[("node1".to_string(), "https://a.example".to_string())]);
        service
    }

    #[tokio::test]
    async fn exchanges_client_credentials_for_a_token() {
        let transport = Arc::new(MockTransport::new());
        transport.set(
            "https://a.example/v1/auth/token",
            200,
            serde_json::json!({
                "accessToken": "jwt-abc",
                "tokenType": "Bearer",
                "expiresIn": 3600,
                "scopes": ["client"]
            }),
        );
        let service = service_with_one_server(transport);
        let token = exchange_client_secret(&service, "client_1", "secret_1")
            .await
            .unwrap();
        assert_eq!(token.access_token, "jwt-abc");
        assert_eq!(token.scopes, vec!["client".to_string()]);
    }

    #[tokio::test]
    async fn surfaces_rejection_status_and_body_on_invalid_credentials() {
        let transport = Arc::new(MockTransport::new());
        transport.set(
            "https://a.example/v1/auth/token",
            401,
            serde_json::json!({
                "error": { "code": "UNAUTHORIZED", "message": "Invalid credentials" }
            }),
        );
        let service = service_with_one_server(transport);
        let result = exchange_client_secret(&service, "client_1", "wrong").await;
        match result {
            Err(AuthError::Rejected { status, body }) => {
                assert_eq!(status, 401);
                assert!(body.contains("UNAUTHORIZED"));
            }
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn binds_a_device_key_with_a_signed_assertion() {
        let transport = Arc::new(MockTransport::new());
        let pair = generate_ed25519_keypair().unwrap();
        transport.set(
            "https://a.example/v1/devices/bind-key",
            200,
            serde_json::json!({ "bound": true, "publicKey": pair.public_key_raw }),
        );
        let service = service_with_one_server(transport);
        let clock = FixedClock(AtomicI64::new(1_000_000));
        let response = bind_device_key(&service, &clock, "bearer-token", &pair)
            .await
            .unwrap();
        assert!(response.bound);
        assert_eq!(response.public_key, pair.public_key_raw);
    }

    #[tokio::test]
    async fn exchanges_a_device_signature_for_a_token() {
        let transport = Arc::new(MockTransport::new());
        let pair = generate_ed25519_keypair().unwrap();
        transport.set(
            "https://a.example/v1/auth/device-token",
            200,
            serde_json::json!({
                "accessToken": "jwt-device",
                "tokenType": "Bearer",
                "expiresIn": 3600,
                "scopes": ["client"]
            }),
        );
        let service = service_with_one_server(transport);
        let clock = FixedClock(AtomicI64::new(1_000_000));
        let token = device_token(&service, &clock, "client_1", &pair)
            .await
            .unwrap();
        assert_eq!(token.access_token, "jwt-device");
    }
}
