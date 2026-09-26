//! `HttpTransport`: the one seam every network call in this crate goes
//! through (F-C0 plan's "Transport austauschbar" requirement) — a host app
//! that needs a custom network stack (corporate proxy, a platform-native
//! HTTP client instead of `reqwest`, request logging/metrics) implements
//! this trait and passes it in; everything else in `core` is written
//! against the trait, never against `reqwest` directly.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: HttpMethod,
    pub url: String,
    /// `(name, value)` pairs, e.g. `("Authorization", "Bearer ...")`.
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

impl HttpRequest {
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            method: HttpMethod::Get,
            url: url.into(),
            headers: Vec::new(),
            body: None,
        }
    }

    pub fn post_json(url: impl Into<String>, body: &serde_json::Value) -> Result<Self, HttpError> {
        let bytes = serde_json::to_vec(body).map_err(|e| HttpError::Encoding(e.to_string()))?;
        Ok(Self {
            method: HttpMethod::Post,
            url: url.into(),
            headers: vec![("Content-Type".to_string(), "application/json".to_string())],
            body: Some(bytes),
        })
    }

    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn json(&self) -> Result<serde_json::Value, HttpError> {
        serde_json::from_slice(&self.body).map_err(|e| HttpError::Encoding(e.to_string()))
    }
}

#[derive(Debug, Clone)]
pub enum HttpError {
    /// Connection failed, timed out, or the transport otherwise couldn't
    /// produce a response at all — distinct from a response that arrived
    /// with an error status (which is a normal, successfully-transported
    /// `HttpResponse` with `status >= 400`, not an `HttpError`).
    Network(String),
    Encoding(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::Network(msg) => write!(f, "network error: {msg}"),
            HttpError::Encoding(msg) => write!(f, "encoding error: {msg}"),
        }
    }
}

impl std::error::Error for HttpError {}

// `?Send` on wasm32: reqwest's wasm backend wraps browser Promises via
// js_sys/wasm-bindgen types that aren't (and can't be, in a single-threaded
// wasm32 browser context) Send — async_trait's default expansion boxes the
// returned future as `Pin<Box<dyn Future + Send>>`, which those futures
// can't satisfy. `?Send` (an async-trait feature specifically for this)
// drops that requirement; native keeps the normal Send-required expansion,
// since a host app may legitimately move a boxed future across threads
// there (e.g. handing it to a tokio worker pool).
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
pub trait HttpTransport: Send + Sync {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError>;
}

/// Default implementation, backed by `reqwest` — works unmodified on both
/// native (tokio-driven) and `wasm32-unknown-unknown` (delegates to the
/// browser's own `fetch()`), see F-C2's research note in the plan. A host
/// app only needs its own `HttpTransport` for something `reqwest` itself
/// can't do (a custom proxy, platform-native TLS pinning, ...).
pub struct ReqwestHttpTransport {
    client: reqwest::Client,
}

impl ReqwestHttpTransport {
    /// `reqwest::Client::new()` panics on wasm32 — `Client::builder().build()`
    /// is the portable construction path on every target, so this
    /// constructor is fallible everywhere rather than infallible on native
    /// and panicking on wasm32.
    pub fn new() -> Result<Self, HttpError> {
        let builder = reqwest::Client::builder();
        // Without a limit a stalled connection would hang a sync forever.
        // The read timeout applies to every single read, not to the whole
        // body, so a 100 MB package on a slow line is still fine as long as
        // bytes keep arriving. (A browser's fetch() has its own timeouts.)
        #[cfg(not(target_arch = "wasm32"))]
        let builder = builder
            .connect_timeout(std::time::Duration::from_secs(15))
            .read_timeout(std::time::Duration::from_secs(60));
        let client = builder
            .build()
            .map_err(|e| HttpError::Network(e.to_string()))?;
        Ok(Self { client })
    }
}

impl Default for ReqwestHttpTransport {
    /// Panics if the underlying `reqwest::Client` can't be built — use
    /// [`ReqwestHttpTransport::new`] directly to handle that instead.
    fn default() -> Self {
        Self::new().expect("failed to construct the default reqwest-based HttpTransport")
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
impl HttpTransport for ReqwestHttpTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        let method = match request.method {
            HttpMethod::Get => reqwest::Method::GET,
            HttpMethod::Post => reqwest::Method::POST,
        };
        let mut builder = self.client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let response = builder
            .send()
            .await
            .map_err(|e| HttpError::Network(e.to_string()))?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .await
            .map_err(|e| HttpError::Network(e.to_string()))?
            .to_vec();
        Ok(HttpResponse { status, body })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_is_success_checks_2xx_range() {
        let ok = HttpResponse {
            status: 200,
            body: vec![],
        };
        let created = HttpResponse {
            status: 201,
            body: vec![],
        };
        let not_found = HttpResponse {
            status: 404,
            body: vec![],
        };
        let server_error = HttpResponse {
            status: 500,
            body: vec![],
        };
        assert!(ok.is_success());
        assert!(created.is_success());
        assert!(!not_found.is_success());
        assert!(!server_error.is_success());
    }

    #[test]
    fn post_json_sets_content_type_and_encodes_body() {
        let req = HttpRequest::post_json("https://example.test/x", &serde_json::json!({ "a": 1 }))
            .unwrap();
        assert_eq!(req.method, HttpMethod::Post);
        assert!(req
            .headers
            .contains(&("Content-Type".to_string(), "application/json".to_string())));
        assert_eq!(req.body.unwrap(), br#"{"a":1}"#);
    }
}
