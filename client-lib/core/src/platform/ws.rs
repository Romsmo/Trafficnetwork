//! `WsTransport`/`WsConnection`: the WebSocket seam (parallel to
//! `HttpTransport`) that `sync::realtime` drives against `GET /v1/ws`
//! (`server/docs/api.md`'s "Real-time push"). [`TokioTungsteniteWsTransport`]
//! is the native default (add-on B1); a `wasm32` build brings its own
//! `WsConnection` backed by the browser's own `WebSocket` instead (F-C4) —
//! `sync::realtime::run` is fully usable today against any `WsConnection` a
//! host app (or a test) provides, native or not.

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

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::MaybeTlsStream;

    use super::{WsConnection, WsError, WsTransport};

    type Socket = tokio_tungstenite::WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

    /// The native default, backed by `tokio-tungstenite` (rustls +
    /// `webpki-roots`, matching `ReqwestHttpTransport`'s own TLS choice — see
    /// `Cargo.toml`). Deliberately **not** split into separate read/write
    /// halves: `WsConnection`'s `send_text`/`recv_text` are already
    /// sequential (`&mut self`, never called concurrently), and keeping the
    /// stream whole is what makes tungstenite's own ping/pong handling work
    /// without this code having to know about it — a `Ping` is queued as an
    /// auto-reply `Pong` internally and flushed on the connection's next
    /// read or write, which `recv_text`'s own poll loop already is.
    pub struct TokioTungsteniteWsTransport;

    #[async_trait::async_trait]
    impl WsTransport for TokioTungsteniteWsTransport {
        async fn connect(&self, url: &str) -> Result<Box<dyn WsConnection>, WsError> {
            let (socket, _response) = tokio_tungstenite::connect_async(url)
                .await
                .map_err(|e| WsError::Connect(e.to_string()))?;
            Ok(Box::new(NativeConnection { socket }))
        }
    }

    struct NativeConnection {
        socket: Socket,
    }

    #[async_trait::async_trait]
    impl WsConnection for NativeConnection {
        async fn send_text(&mut self, text: String) -> Result<(), WsError> {
            self.socket
                .send(Message::Text(text.into()))
                .await
                .map_err(|e| WsError::Send(e.to_string()))
        }

        async fn recv_text(&mut self) -> Result<Option<String>, WsError> {
            loop {
                match self.socket.next().await {
                    Some(Ok(Message::Text(text))) => return Ok(Some(text.to_string())),
                    // Control frames: tungstenite already answered a Ping
                    // with a queued Pong (flushed on this same poll) — there
                    // is nothing for `sync::realtime`'s protocol to see here.
                    Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
                    // The protocol (server/docs/api.md's "Real-time push")
                    // is text-only; a binary frame is not something a
                    // conforming server sends, so it is not fatal either —
                    // ignored like an unrecognized text message would be.
                    Some(Ok(Message::Binary(_))) => continue,
                    Some(Ok(Message::Close(_))) | None => return Ok(None),
                    Some(Err(e)) => return Err(WsError::Send(e.to_string())),
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use tokio::net::TcpListener;

        #[tokio::test]
        async fn sends_and_receives_real_text_frames_over_a_real_socket() {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                // Real auth handshake shape (server/docs/api.md).
                let auth = socket.next().await.unwrap().unwrap();
                assert_eq!(auth, Message::Text("hello from client".into()));
                socket
                    .send(Message::Text("hello from server".into()))
                    .await
                    .unwrap();
                // A real server sends a Ping; a conforming client answers
                // with an automatic Pong without `sync::realtime` ever
                // seeing it — proof that not splitting the stream works.
                socket.send(Message::Ping(Vec::new().into())).await.unwrap();
                let pong = socket.next().await.unwrap().unwrap();
                assert!(matches!(pong, Message::Pong(_)));
                socket.close(None).await.unwrap();
            });

            let transport = TokioTungsteniteWsTransport;
            let mut connection = transport.connect(&url).await.unwrap();
            connection
                .send_text("hello from client".to_string())
                .await
                .unwrap();
            let reply = connection.recv_text().await.unwrap();
            assert_eq!(reply.as_deref(), Some("hello from server"));
            // The Ping/Pong exchange above is invisible here — recv_text
            // goes straight to the clean close.
            assert_eq!(connection.recv_text().await.unwrap(), None);

            server.await.unwrap();
        }

        #[tokio::test]
        async fn connecting_to_a_closed_port_is_a_connect_error_not_a_panic() {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            drop(listener); // now nothing is listening on this port

            let transport = TokioTungsteniteWsTransport;
            let result = transport.connect(&url).await;
            assert!(matches!(result, Err(WsError::Connect(_))));
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::TokioTungsteniteWsTransport;
