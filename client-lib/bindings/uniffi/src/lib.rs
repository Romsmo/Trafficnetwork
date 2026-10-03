//! The client API for Kotlin and Swift (add-on B4), through UniFFI: one
//! object, [`TrafficNetworkClient`], with the same `call(method, argsJson) ->
//! resultJson` shape as the C ABI (`bindings/c-abi/src/client.rs`), the Python
//! and Node bindings and the browser one — so `client-lib/docs/api.md`'s method
//! reference and `conformance/scenarios.json` apply here unchanged. The Kotlin
//! and Swift code UniFFI generates from these exports is the whole binding;
//! nothing is written by hand on top of it.
//!
//! What this crate adds is only what is specific to crossing UniFFI's
//! boundary: where a call runs (a tokio runtime this crate owns, like the C
//! ABI), how the host's secret store and event listener are reached
//! ([`SecureStore`], [`EventListener`] — traits the host implements), and
//! that a panic or a throwing host callback never reaches the host as a crash
//! where the C ABI would have returned an error.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use tokio::runtime::Runtime;
use tokio::sync::oneshot;
use trafficnetwork_core::api::{
    code, panic_envelope, ApiError, ClientEvent, EventListener as CoreEventListener,
    SecureStore as CoreSecureStore, TrafficNetworkClient as CoreClient,
};

uniffi::setup_scaffolding!();

/// Every API call runs on one of this runtime's threads, never on the host's
/// own: a call goes deep (TLS, JSON, SQLite) and a host thread's stack — an
/// Android worker's or a JVM's default is about 1 MiB — is not ours to size.
/// Reserved lazily, so only what a call touches is used.
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

// ------------------------------------------------------------------- errors

/// Why a client could not be created. Everything after that — every `call` —
/// reports its failures inside the result JSON instead, exactly like the
/// other bindings, so a host handles API errors in one way everywhere.
#[derive(Debug, uniffi::Error)]
pub enum ClientError {
    /// `error_code` is one of the API's error codes (`api.md`, "Errors"),
    /// `detail` a message for the log.
    Failed { error_code: String, detail: String },
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let Self::Failed { error_code, detail } = self;
        write!(f, "{error_code}: {detail}")
    }
}

impl std::error::Error for ClientError {}

impl From<ApiError> for ClientError {
    fn from(error: ApiError) -> Self {
        Self::Failed {
            error_code: error.code,
            detail: error.message,
        }
    }
}

/// What the host's own code (a secret store, an event listener) reports when
/// it fails. A host callback that throws, or crashes in a way UniFFI can
/// intercept, ends up here instead of unwinding into the library.
#[derive(Debug, uniffi::Error)]
pub enum HostError {
    Failed { detail: String },
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let Self::Failed { detail } = self;
        write!(f, "{detail}")
    }
}

impl std::error::Error for HostError {}

impl From<uniffi::UnexpectedUniFFICallbackError> for HostError {
    fn from(error: uniffi::UnexpectedUniFFICallbackError) -> Self {
        Self::Failed {
            detail: format!("{error:?}"),
        }
    }
}

// ------------------------------------------------------------- host callbacks

/// The host app's secret store (Android Keystore, iOS Keychain, ...), where
/// the device's credential and signing key go instead of into a file. May be
/// called from any thread, also concurrently. `get` returns `null`/`nil` when
/// there is nothing under `key`.
#[uniffi::export(with_foreign)]
pub trait SecureStore: Send + Sync {
    fn get(&self, key: String) -> Result<Option<String>, HostError>;
    fn set(&self, key: String, value: String) -> Result<(), HostError>;
    fn delete(&self, key: String) -> Result<(), HostError>;
}

/// Told about every event as it happens (`api.md`, "Events"; they are also
/// queued for `pollEvents`), from a thread of the library — hand over to the
/// UI thread yourself.
#[uniffi::export(with_foreign)]
pub trait EventListener: Send + Sync {
    fn on_event(&self, event_json: String) -> Result<(), HostError>;
}

/// The core's secret-store seam, backed by the host's [`SecureStore`]. A
/// store that fails or throws answers "not there"/"refused", like in every
/// other binding.
struct HostSecureStore(Arc<dyn SecureStore>);

impl CoreSecureStore for HostSecureStore {
    fn get(&self, key: &str) -> Option<String> {
        catch_unwind(AssertUnwindSafe(|| self.0.get(key.to_string())))
            .ok()
            .and_then(Result::ok)
            .flatten()
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        match catch_unwind(AssertUnwindSafe(|| {
            self.0.set(key.to_string(), value.to_string())
        })) {
            Ok(result) => result.map_err(|e| e.to_string()),
            Err(_) => Err("the host's secret store failed".to_string()),
        }
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        match catch_unwind(AssertUnwindSafe(|| self.0.delete(key.to_string()))) {
            Ok(result) => result.map_err(|e| e.to_string()),
            Err(_) => Err("the host's secret store failed".to_string()),
        }
    }
}

// -------------------------------------------------------------------- client

/// A client. Creating one opens (or creates) the local database in the
/// directory named by `storagePath` in the options; dropping the last
/// reference closes it again — the data stays on disk, a new client on the
/// same directory picks up where this one left off.
///
/// A client may be used from any thread, several at once.
#[derive(uniffi::Object)]
pub struct TrafficNetworkClient {
    client: Arc<CoreClient>,
    /// Set while `start_realtime` has a background task running.
    realtime_stop: Mutex<Option<Arc<AtomicBool>>>,
}

#[uniffi::export]
impl TrafficNetworkClient {
    /// `options_json` is the client's options (`api.md`, "Options") plus
    /// `storagePath`, the directory the database and the secrets go in. With a
    /// `secure_store` the device's secrets go there instead of into a file in
    /// that directory (readable by the current user only — not
    /// hardware-backed).
    #[uniffi::constructor]
    pub fn new(
        options_json: String,
        secure_store: Option<Arc<dyn SecureStore>>,
    ) -> Result<Arc<Self>, ClientError> {
        let store = secure_store
            .map(|store| -> Arc<dyn CoreSecureStore> { Arc::new(HostSecureStore(store)) });
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            // reqwest needs a running runtime to build its client on some platforms.
            let _enter = runtime().enter();
            CoreClient::open_native(&options_json, store)
        }));
        match outcome {
            Ok(Ok(client)) => Ok(Arc::new(Self {
                client: Arc::new(client),
                realtime_stop: Mutex::new(None),
            })),
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(ClientError::Failed {
                error_code: code::INTERNAL.to_string(),
                detail: "the library hit an internal error (a panic)".to_string(),
            }),
        }
    }

    /// Runs one API method (`api.md` lists them) and returns its result as
    /// JSON: `{"ok": …}` or `{"error": {"code": …, "message": …}}`. Blocks
    /// until the call is done — a sync takes as long as the network does, so
    /// call it off the UI thread, or use [`call_async`](Self::call_async).
    /// `args_json` may be empty for a method without arguments.
    pub fn call(&self, method: String, args_json: String) -> String {
        // Blocks the calling thread only; the call itself runs on the
        // library's own thread (see `WORKER_STACK_BYTES`).
        self.start_call(method, args_json)
            .blocking_recv()
            .unwrap_or_else(|_| panic_envelope())
    }

    /// [`call`](Self::call) without blocking the calling thread: a `suspend
    /// fun` in Kotlin, an `async` function in Swift.
    pub async fn call_async(&self, method: String, args_json: String) -> String {
        // A task that died (a panic inside the call) drops the sender.
        self.start_call(method, args_json)
            .await
            .unwrap_or_else(|_| panic_envelope())
    }

    /// Registers (replacing any previous one; `None` removes it) a listener
    /// called for every event as it happens.
    pub fn set_event_listener(&self, listener: Option<Arc<dyn EventListener>>) {
        let listener = listener.map(|listener| -> CoreEventListener {
            Arc::new(move |event: &ClientEvent| {
                let Ok(text) = serde_json::to_string(event) else {
                    return;
                };
                // A throwing host listener must not unwind into the library.
                let _ = catch_unwind(AssertUnwindSafe(|| listener.on_event(text)));
            })
        });
        self.client.set_event_listener(listener);
    }

    /// Keeps a WebSocket connection to the network open and applies pushed
    /// events (`api.md`, "Realtime push"), on this library's own background
    /// task — the host needs no thread of its own. Events surface like every
    /// other (`pollEvents`, the listener). A no-op if already running.
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

impl TrafficNetworkClient {
    /// Starts one call on the library's runtime; the answer arrives on the
    /// returned channel.
    fn start_call(&self, method: String, args_json: String) -> oneshot::Receiver<String> {
        let client = self.client.clone();
        let (sender, receiver) = oneshot::channel();
        runtime().spawn(async move {
            let _ = sender.send(client.call_json(&method, &args_json).await);
        });
        receiver
    }
}

impl Drop for TrafficNetworkClient {
    fn drop(&mut self) {
        self.stop_realtime();
        self.client.close();
    }
}

/// The library's version.
#[uniffi::export]
pub fn library_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests;
