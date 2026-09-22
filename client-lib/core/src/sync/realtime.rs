//! Drives the `GET /v1/ws` real-time push protocol
//! (`server/docs/api.md`'s "Real-time push") against a
//! `platform::WsConnection`: auth handshake, tile subscriptions, then
//! dispatching pushed events through the exact same
//! [`SyncEngine::apply_event`] a delta pull uses — a pushed event and a
//! delta-pulled event are handled identically, no separate code path to
//! drift between them.
//!
//! No reconnect/backoff loop lives here — [`run`] handles exactly one
//! connection's lifetime and returns once it closes (cleanly or not); a
//! caller that wants to stay connected calls it again, ideally with the
//! same kind of backoff the discovery pool already applies to HTTP
//! failures. That policy belongs to the public-API facade (F-C0 plan §3's
//! `api.rs`), not this protocol-level driver.

use serde::{Deserialize, Serialize};

use crate::platform::{WsConnection, WsError};

use super::engine::SyncEngine;
use super::types::EventLogEntry;

#[derive(Debug, Clone, Serialize)]
struct AuthMessage<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    token: &'a str,
}

#[derive(Debug, Clone, Serialize)]
struct SubscribeMessage<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    tile: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ServerMessage {
    #[serde(rename = "auth_ok")]
    AuthOk,
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "event")]
    Event { event: EventLogEntry },
}

/// `connection` must already be open (from `WsTransport::connect`).
/// Authenticates, subscribes to `tiles`, then applies every pushed event to
/// `engine` until the connection closes. Returns `Ok(())` on a clean close,
/// `Err` on an auth rejection or a transport-level failure.
pub async fn run(
    connection: &mut dyn WsConnection,
    engine: &SyncEngine,
    bearer_token: &str,
    tiles: &[String],
) -> Result<(), WsError> {
    let auth = AuthMessage {
        kind: "auth",
        token: bearer_token,
    };
    connection
        .send_text(serde_json::to_string(&auth).expect("auth message always serializes"))
        .await?;

    loop {
        let text = connection.recv_text().await?.ok_or(WsError::Closed)?;
        match serde_json::from_str::<ServerMessage>(&text) {
            Ok(ServerMessage::AuthOk) => break,
            Ok(ServerMessage::Error { message }) => return Err(WsError::Connect(message)),
            // Anything else before auth_ok is unexpected but not fatal —
            // ignore and keep waiting for the handshake to resolve.
            _ => continue,
        }
    }

    for tile in tiles {
        let subscribe = SubscribeMessage {
            kind: "subscribe",
            tile,
        };
        connection
            .send_text(
                serde_json::to_string(&subscribe).expect("subscribe message always serializes"),
            )
            .await?;
    }

    loop {
        let text = match connection.recv_text().await? {
            Some(text) => text,
            None => return Ok(()),
        };
        if let Ok(ServerMessage::Event { event }) = serde_json::from_str::<ServerMessage>(&text) {
            // Best-effort: a single malformed/unrecognized pushed event
            // never tears down the connection — the next delta/manifest
            // sync cycle would catch up on it anyway.
            let _ = engine.apply_event(&event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{DiscoveryConfig, DiscoveryService};
    use crate::platform::{Clock, HttpError, HttpRequest, HttpResponse, HttpTransport};
    use crate::storage::InMemoryStore;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::{Arc, Mutex};

    struct FixedClock(AtomicI64);
    impl Clock for FixedClock {
        fn now_unix_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct NoopTransport;
    #[async_trait::async_trait]
    impl HttpTransport for NoopTransport {
        async fn send(&self, _request: HttpRequest) -> Result<HttpResponse, HttpError> {
            Err(HttpError::Network("not used by these tests".to_string()))
        }
    }

    struct ScriptedConnection {
        incoming: VecDeque<Option<String>>,
        sent: Arc<Mutex<Vec<String>>>,
    }
    #[async_trait::async_trait]
    impl WsConnection for ScriptedConnection {
        async fn send_text(&mut self, text: String) -> Result<(), WsError> {
            self.sent.lock().unwrap().push(text);
            Ok(())
        }
        async fn recv_text(&mut self) -> Result<Option<String>, WsError> {
            Ok(self.incoming.pop_front().flatten())
        }
    }

    fn engine_with_store() -> (SyncEngine, Arc<InMemoryStore>) {
        let clock = Arc::new(FixedClock(AtomicI64::new(0)));
        let discovery = Arc::new(DiscoveryService::new(
            Arc::new(NoopTransport),
            clock.clone(),
            DiscoveryConfig::default(),
        ));
        let store = Arc::new(InMemoryStore::new());
        (SyncEngine::new(discovery, store.clone(), clock), store)
    }

    fn hazard_report_created_json(id: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "event",
            "event": {
                "sequence": 1,
                "occurredAt": "2026-01-01T00:00:00Z",
                "type": "ReportCreated",
                "entityType": "hazardReport",
                "entityId": id,
                "payload": {
                    "id": id,
                    "type": "ice",
                    "position": { "type": "Point", "coordinates": [13.4, 52.5] },
                    "regionTile": "tile1",
                    "reportedAt": "2026-01-01T00:00:00Z",
                    "reporterId": "r1",
                    "speedKmh": null,
                    "expiresAt": "2026-01-01T00:20:00Z",
                    "status": "active",
                    "source": "community",
                    "sourceLicense": null,
                    "confirmCount": 0,
                    "denyCount": 0
                },
                "regionTile": "tile1",
                "source": "community"
            }
        })
    }

    #[tokio::test]
    async fn applies_a_pushed_event_after_the_auth_handshake() {
        let (engine, store) = engine_with_store();
        let sent = Arc::new(Mutex::new(Vec::new()));
        let mut connection = ScriptedConnection {
            incoming: VecDeque::from([
                Some(serde_json::json!({"type": "auth_ok"}).to_string()),
                Some(hazard_report_created_json("hr1").to_string()),
                None,
            ]),
            sent: sent.clone(),
        };

        run(&mut connection, &engine, "token", &[]).await.unwrap();

        let entities = store.all_entities().unwrap();
        assert_eq!(entities.hazard_reports.len(), 1);
        assert_eq!(entities.hazard_reports[0].id, "hr1");
        assert!(sent.lock().unwrap()[0].contains("\"type\":\"auth\""));
    }

    #[tokio::test]
    async fn subscribes_to_every_requested_tile_after_auth() {
        let (engine, _store) = engine_with_store();
        let sent = Arc::new(Mutex::new(Vec::new()));
        let mut connection = ScriptedConnection {
            incoming: VecDeque::from([
                Some(serde_json::json!({"type": "auth_ok"}).to_string()),
                None,
            ]),
            sent: sent.clone(),
        };

        run(
            &mut connection,
            &engine,
            "token",
            &["tileA".to_string(), "tileB".to_string()],
        )
        .await
        .unwrap();

        let sent = sent.lock().unwrap();
        assert!(sent.iter().any(|m| m.contains("tileA")));
        assert!(sent.iter().any(|m| m.contains("tileB")));
    }

    #[tokio::test]
    async fn returns_an_error_when_the_server_rejects_the_auth_token() {
        let (engine, _store) = engine_with_store();
        let mut connection = ScriptedConnection {
            incoming: VecDeque::from([Some(
                serde_json::json!({"type": "error", "message": "Invalid token"}).to_string(),
            )]),
            sent: Arc::new(Mutex::new(Vec::new())),
        };

        let result = run(&mut connection, &engine, "bad-token", &[]).await;
        assert!(matches!(result, Err(WsError::Connect(_))));
    }

    #[tokio::test]
    async fn a_clean_close_before_auth_ok_is_reported_as_closed() {
        let (engine, _store) = engine_with_store();
        let mut connection = ScriptedConnection {
            incoming: VecDeque::from([None]),
            sent: Arc::new(Mutex::new(Vec::new())),
        };

        let result = run(&mut connection, &engine, "token", &[]).await;
        assert!(matches!(result, Err(WsError::Closed)));
    }
}
