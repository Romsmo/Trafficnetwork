//! `TrafficNetworkClient::run_realtime` (add-on B1) against fake
//! `WsTransport`/`Sleep` implementations — no real socket, no real waiting,
//! so these run in milliseconds like every other unit test.
//!
//! `RecordingSleep` also advances the shared fake clock by however long it
//! was asked to "sleep" — without that, a server's backoff (computed from
//! that same clock) would never appear to expire, and a test relying on a
//! retry actually succeeding would spin forever. Real time never passes
//! either way; `#[tokio::test]`'s single-threaded runtime just keeps
//! resolving these fake awaits immediately.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::*;
use crate::platform::{
    Clock, HttpError, HttpMethod, HttpRequest, HttpResponse, HttpTransport, Sleep, WsConnection,
    WsError, WsTransport,
};
use crate::storage::InMemoryStore;

struct SharedClock(Arc<AtomicI64>);
impl Clock for SharedClock {
    fn now_unix_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// Answers `POST .../v1/auth/token` with a token, everything else `404` —
/// enough for `ensure_token` to succeed; `run_realtime`'s gap-close sync is
/// best-effort and swallows anything short of `StorageFull` anyway.
struct TokenOnlyHttp;
#[async_trait::async_trait]
impl HttpTransport for TokenOnlyHttp {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
        if request.method == HttpMethod::Post && request.url.ends_with("/v1/auth/token") {
            let body = json!({
                "accessToken": "tok", "tokenType": "Bearer", "expiresIn": 3600, "scopes": ["client"]
            });
            return Ok(HttpResponse {
                status: 200,
                body: serde_json::to_vec(&body).unwrap(),
            });
        }
        Ok(HttpResponse {
            status: 404,
            body: b"{}".to_vec(),
        })
    }
}

/// A `WsConnection` that plays back a fixed script of `recv_text` results,
/// each in order; `send_text` is accepted and ignored. Setting `stop` right
/// as the last scripted result comes back lets a test bound
/// `run_realtime`'s otherwise-infinite loop without controlling real time.
struct ScriptedConnection {
    incoming: Mutex<VecDeque<Result<Option<String>, WsError>>>,
    stop_when_exhausted: Option<Arc<AtomicBool>>,
}
#[async_trait::async_trait]
impl WsConnection for ScriptedConnection {
    async fn send_text(&mut self, _text: String) -> Result<(), WsError> {
        Ok(())
    }
    async fn recv_text(&mut self) -> Result<Option<String>, WsError> {
        let mut incoming = self.incoming.lock().unwrap();
        let next = incoming.pop_front().unwrap_or(Ok(None));
        if incoming.is_empty() {
            if let Some(stop) = &self.stop_when_exhausted {
                stop.store(true, Ordering::SeqCst);
            }
        }
        next
    }
}

/// Authenticates, then closes cleanly — and asks the loop to stop once that
/// happens, so a test only ever sees one successful connection.
fn auth_ok_then_close(stop_after: Arc<AtomicBool>) -> ScriptedConnection {
    ScriptedConnection {
        incoming: Mutex::new(VecDeque::from([
            Ok(Some(json!({"type": "auth_ok"}).to_string())),
            Ok(None),
        ])),
        stop_when_exhausted: Some(stop_after),
    }
}

type ConnectResult = Result<ScriptedConnection, WsError>;

/// Connect results keyed by URL, each used (and removed) at most once — a
/// URL with nothing left scripted (or never scripted at all) falls back to
/// `default`, called fresh every time.
struct ScriptedWs {
    by_url: Mutex<HashMap<String, VecDeque<ConnectResult>>>,
    default: Box<dyn Fn() -> ConnectResult + Send + Sync>,
    attempts: AtomicUsize,
}
impl ScriptedWs {
    fn new(default: impl Fn() -> ConnectResult + Send + Sync + 'static) -> Self {
        Self {
            by_url: Mutex::new(HashMap::new()),
            default: Box::new(default),
            attempts: AtomicUsize::new(0),
        }
    }
    fn script(&self, url: &str, result: ConnectResult) {
        self.by_url
            .lock()
            .unwrap()
            .entry(url.to_string())
            .or_default()
            .push_back(result);
    }
}
#[async_trait::async_trait]
impl WsTransport for ScriptedWs {
    async fn connect(&self, url: &str) -> Result<Box<dyn WsConnection>, WsError> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        let scripted = self
            .by_url
            .lock()
            .unwrap()
            .get_mut(url)
            .and_then(VecDeque::pop_front);
        scripted
            .unwrap_or_else(|| (self.default)())
            .map(|connection| Box::new(connection) as Box<dyn WsConnection>)
    }
}

/// Records every requested duration and advances `now` by it (see the
/// module doc); optionally also stops the loop once a given number of
/// sleeps have happened, for a test that wants to bound how far it gets
/// without a connection ever succeeding.
struct RecordingSleep {
    requested_ms: Mutex<Vec<u64>>,
    now: Arc<AtomicI64>,
    stop_after_calls: Option<(usize, Arc<AtomicBool>)>,
}
impl RecordingSleep {
    fn new(now: Arc<AtomicI64>) -> Self {
        Self {
            requested_ms: Mutex::new(Vec::new()),
            now,
            stop_after_calls: None,
        }
    }
    fn stopping_after_calls(now: Arc<AtomicI64>, calls: usize, stop: Arc<AtomicBool>) -> Self {
        Self {
            requested_ms: Mutex::new(Vec::new()),
            now,
            stop_after_calls: Some((calls, stop)),
        }
    }
}
#[async_trait::async_trait]
impl Sleep for RecordingSleep {
    async fn sleep_ms(&self, duration_ms: u64) {
        let count = {
            let mut requested = self.requested_ms.lock().unwrap();
            requested.push(duration_ms);
            requested.len()
        };
        self.now.fetch_add(duration_ms as i64, Ordering::SeqCst);
        if let Some((at, stop)) = &self.stop_after_calls {
            if count >= *at {
                stop.store(true, Ordering::SeqCst);
            }
        }
    }
}

const START_MS: i64 = 1_800_000_000_000;

fn client(
    options: ClientOptions,
    ws: Arc<ScriptedWs>,
    sleep: Arc<RecordingSleep>,
    now: Arc<AtomicI64>,
) -> TrafficNetworkClient {
    TrafficNetworkClient::new(
        options,
        Platform {
            store: Arc::new(InMemoryStore::new()),
            secure_store: Arc::new(MemorySecureStore::new()),
            http: Arc::new(TokenOnlyHttp),
            clock: Arc::new(SharedClock(now)),
            ws,
            sleep,
        },
    )
    .unwrap()
}

fn fixed_nodes_options(nodes: &[&str]) -> ClientOptions {
    ClientOptions {
        nodes: nodes.iter().map(|s| s.to_string()).collect(),
        discovery: false,
        credentials: Some(Credentials::Client {
            client_id: "device-1".to_string(),
            client_secret: "secret".to_string(),
        }),
        ..ClientOptions::default()
    }
}

#[tokio::test]
async fn failures_do_not_stop_the_loop_until_a_server_finally_connects() {
    // Both servers fail their first (only scripted) attempt; whichever one
    // is tried again once both are backed off succeeds via the default —
    // which of the two that is is not deterministic (score ties are broken
    // by a random jitter, see discovery::scoring), so this only asserts on
    // the outcome, not on which specific address failed.
    let stop = Arc::new(AtomicBool::new(false));
    let now = Arc::new(AtomicI64::new(START_MS));
    let ws = Arc::new(ScriptedWs::new({
        let stop = stop.clone();
        move || Ok(auth_ok_then_close(stop.clone()))
    }));
    ws.script(
        "wss://a.example/v1/ws",
        Err(WsError::Connect("refused".to_string())),
    );
    ws.script(
        "wss://b.example/v1/ws",
        Err(WsError::Connect("refused".to_string())),
    );
    let sleep = Arc::new(RecordingSleep::new(now.clone()));
    let client = client(
        fixed_nodes_options(&["https://a.example", "https://b.example"]),
        ws.clone(),
        sleep,
        now,
    );

    client.run_realtime(&stop).await.unwrap();

    // Two failures, then the one connection that actually succeeds.
    assert_eq!(ws.attempts.load(Ordering::SeqCst), 3);
    let status = client.get_network_status().unwrap();
    let backed_off = status.known_nodes.iter().filter(|n| n.backed_off).count();
    assert_eq!(
        backed_off, 1,
        "the server that never got a working attempt: {status:?}"
    );
}

#[tokio::test]
async fn a_successful_connection_clears_an_earlier_backoff() {
    let stop = Arc::new(AtomicBool::new(false));
    let now = Arc::new(AtomicI64::new(START_MS));
    let ws = Arc::new(ScriptedWs::new(|| {
        Err(WsError::Connect("unused".to_string()))
    }));
    ws.script(
        "wss://a.example/v1/ws",
        Err(WsError::Connect("refused".to_string())),
    );
    ws.script(
        "wss://a.example/v1/ws",
        Ok(auth_ok_then_close(stop.clone())),
    );
    let sleep = Arc::new(RecordingSleep::new(now.clone()));
    let client = client(
        fixed_nodes_options(&["https://a.example"]),
        ws.clone(),
        sleep,
        now,
    );

    client.run_realtime(&stop).await.unwrap();

    assert_eq!(ws.attempts.load(Ordering::SeqCst), 2);
    let status = client.get_network_status().unwrap();
    assert!(
        status.known_nodes.iter().all(|n| !n.backed_off),
        "a working connection should clear the earlier failure: {status:?}"
    );
}

#[tokio::test]
async fn the_only_server_is_retried_after_its_backoff_instead_of_being_abandoned() {
    let stop = Arc::new(AtomicBool::new(false));
    let now = Arc::new(AtomicI64::new(START_MS));
    let ws = Arc::new(ScriptedWs::new(|| {
        Err(WsError::Connect("unused".to_string()))
    }));
    ws.script(
        "wss://a.example/v1/ws",
        Err(WsError::Connect("refused".to_string())),
    );
    let sleep = Arc::new(RecordingSleep::stopping_after_calls(
        now.clone(),
        1,
        stop.clone(),
    ));
    let client = client(
        fixed_nodes_options(&["https://a.example"]),
        ws.clone(),
        sleep.clone(),
        now,
    );

    client.run_realtime(&stop).await.unwrap();

    // One failed attempt, then a wait (recorded, not really waited) for
    // that same server's own backoff — the test stops it there rather than
    // letting it retry (which the previous test already covers).
    assert_eq!(ws.attempts.load(Ordering::SeqCst), 1);
    let waited = sleep.requested_ms.lock().unwrap().clone();
    assert_eq!(waited.len(), 1);
    assert!(waited[0] > 0, "{waited:?}");
}

#[tokio::test]
async fn with_no_known_server_it_waits_the_fixed_retry_delay_without_connecting() {
    let stop = Arc::new(AtomicBool::new(false));
    let now = Arc::new(AtomicI64::new(START_MS));
    let ws = Arc::new(ScriptedWs::new(|| {
        Err(WsError::Connect("unused".to_string()))
    }));
    let sleep = Arc::new(RecordingSleep::stopping_after_calls(
        now.clone(),
        1,
        stop.clone(),
    ));
    // discovery: true, but no seed ever answers (TokenOnlyHttp 404s
    // everything else) and no fixed nodes — an empty pool, a valid state.
    let options = ClientOptions {
        discovery: true,
        credentials: Some(Credentials::Client {
            client_id: "device-1".to_string(),
            client_secret: "secret".to_string(),
        }),
        ..ClientOptions::default()
    };
    let client = client(options, ws.clone(), sleep.clone(), now);

    client.run_realtime(&stop).await.unwrap();

    assert_eq!(ws.attempts.load(Ordering::SeqCst), 0);
    assert_eq!(sleep.requested_ms.lock().unwrap().as_slice(), [5_000]);
}

#[tokio::test]
async fn a_client_with_no_credentials_fails_at_once_rather_than_looping_forever() {
    let stop = Arc::new(AtomicBool::new(false));
    let now = Arc::new(AtomicI64::new(START_MS));
    let ws = Arc::new(ScriptedWs::new(|| {
        Err(WsError::Connect("unused".to_string()))
    }));
    let sleep = Arc::new(RecordingSleep::new(now.clone()));
    let mut options = fixed_nodes_options(&["https://a.example"]);
    options.credentials = None;
    let client = client(options, ws.clone(), sleep, now);

    let error = client.run_realtime(&stop).await.unwrap_err();

    assert_eq!(error.code, code::NOT_CONFIGURED);
    // Not even a connect was attempted — there was never a token to use.
    assert_eq!(ws.attempts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_closed_client_refuses_to_start() {
    let stop = Arc::new(AtomicBool::new(false));
    let now = Arc::new(AtomicI64::new(START_MS));
    let ws = Arc::new(ScriptedWs::new(|| {
        Err(WsError::Connect("unused".to_string()))
    }));
    let sleep = Arc::new(RecordingSleep::new(now.clone()));
    let client = client(fixed_nodes_options(&["https://a.example"]), ws, sleep, now);
    client.close();

    let error = client.run_realtime(&stop).await.unwrap_err();

    assert_eq!(error.code, code::CLOSED);
}

#[tokio::test]
async fn stop_set_before_starting_means_it_returns_at_once() {
    let stop = Arc::new(AtomicBool::new(true));
    let now = Arc::new(AtomicI64::new(START_MS));
    let ws = Arc::new(ScriptedWs::new(|| {
        Err(WsError::Connect("unused".to_string()))
    }));
    let sleep = Arc::new(RecordingSleep::new(now.clone()));
    let client = client(
        fixed_nodes_options(&["https://a.example"]),
        ws.clone(),
        sleep,
        now,
    );

    client.run_realtime(&stop).await.unwrap();

    assert_eq!(ws.attempts.load(Ordering::SeqCst), 0);
}
