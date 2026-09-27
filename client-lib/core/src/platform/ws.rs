//! `WsTransport`/`WsConnection`: the WebSocket seam (parallel to
//! `HttpTransport`) that `sync::realtime` drives against `GET /v1/ws`
//! (`server/docs/api.md`'s "Real-time push"). No default implementation
//! ships yet — unlike `ReqwestHttpTransport`, a concrete WebSocket client
//! needs a platform-specific choice this crate can't verify without a real
//! toolchain to build and run it against (native: something like
//! `tokio-tungstenite`; `wasm32`: the browser's own `WebSocket`), so it's
//! deliberately left to F-C4's bindings, each supplying what actually fits
//! its target. `sync::realtime::run` is fully usable today against any
//! `WsConnection` a host app (or a test) provides.

#[derive(Debug, Clone)]
pub enum WsError {
    Connect(String),
    Send(String),
    /// The connection closed (cleanly or otherwise) while a call expected
    /// it to still be open.
    Closed,
}

impl std::fmt::Display for WsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WsError::Connect(msg) => write!(f, "websocket connect error: {msg}"),
            WsError::Send(msg) => write!(f, "websocket send error: {msg}"),
            WsError::Closed => write!(f, "websocket connection closed"),
        }
    }
}

impl std::error::Error for WsError {}

/// One already-established connection. `&mut self` throughout — a
/// WebSocket is an inherently sequential, exclusively-owned stream, unlike
/// `HttpTransport`'s independent request/response calls, so there's no
/// need for `HttpTransport`'s `Sync` bound here.
#[async_trait::async_trait]
pub trait WsConnection: Send {
    async fn send_text(&mut self, text: String) -> Result<(), WsError>;

    /// `Ok(None)` on a clean close — distinct from `Err(WsError::Closed)`,
    /// which callers use for "the connection closed when a message was
    /// still expected."
    async fn recv_text(&mut self) -> Result<Option<String>, WsError>;
}

#[async_trait::async_trait]
pub trait WsTransport: Send + Sync {
    async fn connect(&self, url: &str) -> Result<Box<dyn WsConnection>, WsError>;
}
