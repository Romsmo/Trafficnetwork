//! What the generated Dart code sees. Everything here is either a plain
//! value (`String`, `bool`, [`ClientError`]) or the one opaque object,
//! [`NativeClient`]; nothing about the API's methods is spelled out — they
//! all go through [`NativeClient::call`] by name, as in every other binding.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use flutter_rust_bridge::{frb, DartFnFuture};
use tokio::runtime::Runtime;
use tokio::sync::oneshot;
use trafficnetwork_core::api::{
    code, panic_envelope, ApiError, ClientEvent, EventListener, SecureStore, TrafficNetworkClient,
};

use crate::frb_generated::StreamSink;

/// Every API call runs on one of this runtime's threads, never on the
/// bridge's own pool or the host's: a call goes deep (TLS, JSON, SQLite) and
/// the stack of someone else's thread is not ours to size.
const WORKER_STACK_BYTES: usize = 8 * 1024 * 1024;

fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_stack_size(WORKER_STACK_BYTES)
            .enable_all()
            .build()
            .expect("the async runtime could not start")
    })
}

/// Why a client could not be created. Everything after that — every `call` —
/// reports its failures inside the result JSON instead, exactly like the
/// other bindings, so a host handles API errors in one way everywhere.
#[derive(Debug)]
pub struct ClientError {
    /// One of the API's error codes (`api.md`, "Errors").
    pub error_code: String,
    /// A message for the log.
    pub detail: String,
}

impl From<ApiError> for ClientError {
    fn from(error: ApiError) -> Self {
        Self {
            error_code: error.code,
            detail: error.message,
        }
    }
}

/// The host's secret store, reached through three Dart functions. Dart's
/// secure-storage plugins are asynchronous and the core's seam is not, so each
/// call waits here for the Dart function to answer — from a thread of this
/// library's runtime, never from Dart's own isolate, so Dart is free to answer.
/// A store that fails answers "not there"/"refused", like in every other
/// binding.
struct DartSecureStore {
    get: Box<dyn Fn(String) -> DartFnFuture<Option<String>> + Send + Sync>,
    set: Box<dyn Fn(String, String) -> DartFnFuture<bool> + Send + Sync>,
    delete: Box<dyn Fn(String) -> DartFnFuture<bool> + Send + Sync>,
}

impl SecureStore for DartSecureStore {
    fn get(&self, key: &str) -> Option<String> {
        catch_unwind(AssertUnwindSafe(|| {
            futures::executor::block_on((self.get)(key.to_string()))
        }))
        .ok()
        .flatten()
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            futures::executor::block_on((self.set)(key.to_string(), value.to_string()))
        }));
        match outcome {
            Ok(true) => Ok(()),
            Ok(false) => Err("the host's secret store refused the write".to_string()),
            Err(_) => Err("the host's secret store failed".to_string()),
        }
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            futures::executor::block_on((self.delete)(key.to_string()))
        }));
        match outcome {
            Ok(true) => Ok(()),
            Ok(false) => Err("the host's secret store refused the delete".to_string()),
            Err(_) => Err("the host's secret store failed".to_string()),
        }
    }
}

/// A client. Creating one opens (or creates) the local database in the
/// directory named by `storagePath` in the options; releasing the last
/// reference closes it again — the data stays on disk, a new client on the
/// same directory picks up where this one left off.
#[frb(opaque)]
pub struct NativeClient {
    client: Arc<TrafficNetworkClient>,
    /// Set while `start_realtime` has a background task running.
    realtime_stop: Mutex<Option<Arc<AtomicBool>>>,
}

fn open(
    options_json: &str,
    secure_store: Option<Arc<dyn SecureStore>>,
) -> Result<NativeClient, ClientError> {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // reqwest needs a running runtime to build its client on some platforms.
        let _enter = runtime().enter();
        TrafficNetworkClient::open_native(options_json, secure_store)
    }));
    match outcome {
        Ok(Ok(client)) => Ok(NativeClient {
            client: Arc::new(client),
            realtime_stop: Mutex::new(None),
        }),
        Ok(Err(error)) => Err(error.into()),
        Err(_) => Err(ClientError {
            error_code: code::INTERNAL.to_string(),
            detail: "the library hit an internal error (a panic)".to_string(),
        }),
    }
}

impl NativeClient {
    /// `options_json` is the client's options (`api.md`, "Options") plus
    /// `storagePath`, the directory the database and the secrets go in. The
    /// device's secrets go into a file in that directory (readable by the
    /// current user only — not hardware-backed); see
    /// [`create_with_secure_store`](Self::create_with_secure_store) for the
    /// platform's own store.
    pub fn create(options_json: String) -> Result<NativeClient, ClientError> {
        open(&options_json, None)
    }

    /// [`create`](Self::create) with the device's secrets kept in the host's
    /// own store (Keychain, Keystore, ...) instead of a file: `get` answers
    /// the value under a key (`null` if there is none), `set` and `delete`
    /// answer whether they worked.
    pub fn create_with_secure_store(
        options_json: String,
        get: impl Fn(String) -> DartFnFuture<Option<String>> + Send + Sync + 'static,
        set: impl Fn(String, String) -> DartFnFuture<bool> + Send + Sync + 'static,
        delete: impl Fn(String) -> DartFnFuture<bool> + Send + Sync + 'static,
    ) -> Result<NativeClient, ClientError> {
        let store: Arc<dyn SecureStore> = Arc::new(DartSecureStore {
            get: Box::new(get),
            set: Box::new(set),
            delete: Box::new(delete),
        });
        open(&options_json, Some(store))
    }

    /// Runs one API method (`api.md` lists them) and returns its result as
    /// JSON: `{"ok": …}` or `{"error": {"code": …, "message": …}}`.
    /// `args_json` may be empty for a method without arguments.
    pub fn call(&self, method: String, args_json: String) -> String {
        let client = self.client.clone();
        let (sender, receiver) = oneshot::channel();
        runtime().spawn(async move {
            let _ = sender.send(client.call_json(&method, &args_json).await);
        });
        // A task that died (a panic inside the call) drops the sender.
        receiver
            .blocking_recv()
            .unwrap_or_else(|_| panic_envelope())
    }

    /// Every event as it happens (`api.md`, "Events"; they are also queued for
    /// `pollEvents`), as JSON — a `Stream<String>` in Dart. A second call
    /// replaces the first stream's source.
    pub fn events(&self, sink: StreamSink<String>) -> Result<(), ClientError> {
        let listener: EventListener = Arc::new(move |event: &ClientEvent| {
            if let Ok(text) = serde_json::to_string(event) {
                let _ = sink.add(text);
            }
        });
        self.client.set_event_listener(Some(listener));
        Ok(())
    }

    /// Stops delivering events to the stream.
    pub fn stop_events(&self) {
        self.client.set_event_listener(None);
    }

    /// Keeps a WebSocket connection to the network open and applies pushed
    /// events (`api.md`, "Realtime push"), on this library's own background
    /// task. Events surface like every other (`pollEvents`, the stream). A
    /// no-op if already running.
    pub fn start_realtime(&self) {
        let mut slot = self
            .realtime_stop
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if slot.is_some() {
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        *slot = Some(stop.clone());
        drop(slot);
        let client = self.client.clone();
        runtime().spawn(async move {
            let _ = client.run_realtime(&stop).await;
        });
    }

    /// Asks a running realtime task to stop — between connection attempts,
    /// not by closing a connection that is open. A no-op if none is running.
    pub fn stop_realtime(&self) {
        let stop = self
            .realtime_stop
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(stop) = stop {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

impl Drop for NativeClient {
    fn drop(&mut self) {
        self.stop_realtime();
        self.client.close();
    }
}

/// The library's version.
#[frb(sync)]
pub fn library_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
