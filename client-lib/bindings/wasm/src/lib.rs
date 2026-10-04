// This whole crate only makes sense on `wasm32`: it calls
// `trafficnetwork_core::api::Platform::wasm`/`storage::IndexedDbStore`,
// which only exist under that `cfg` (see their own docs for why), and
// depends on `wasm-bindgen`/`js-sys`. Gating the entire crate here — rather
// than every item inside it — means `cargo build --workspace`/`cargo test
// --workspace` (the native CI job, which does reach this crate now that
// it's a workspace member) compiles it as a legitimately empty library on
// a native target instead of failing on unresolved wasm32-only items; the
// real content only exists when actually building for `wasm32-unknown-unknown`
// (`.github/workflows/client-lib-ci.yml`'s `wasm-build`/`wasm-test` jobs).
#![cfg(target_arch = "wasm32")]

//! The client API over `wasm-bindgen` (add-on B3): one JS/TS-facing `Client`
//! class with the same `call(method, argsJson) -> resultJson` shape as the
//! C-ABI (`bindings/c-abi/src/client.rs`) and the Python binding, so
//! `client-lib/docs/api.md`'s method reference and `conformance/scenarios.json`
//! apply here unchanged. `ts/` on top of this is the ergonomic, typed
//! wrapper a real app actually imports — see `client-lib/docs/integration-web.md`.
//!
//! `Client::create` is `async` (unlike the C-ABI's synchronous
//! `tn_client_new`) because opening the IndexedDB-backed store
//! (`Platform::wasm`, `storage::IndexedDbStore`) is only ever reachable
//! asynchronously in a browser — see that module's own doc for why.

use std::cell::RefCell;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::FutureExt;
use serde_json::Value;
use trafficnetwork_core::api::{
    error_envelope, panic_envelope, ApiError, ClientOptions, EventListener, Platform, SecureStore,
    TrafficNetworkClient,
};
use wasm_bindgen::prelude::*;

fn js_error(message: impl Into<String>) -> JsValue {
    JsValue::from_str(&error_envelope(&ApiError::new(
        trafficnetwork_core::api::code::INVALID_ARGUMENT,
        message.into(),
    )))
}

/// A `js_sys::Function` wrapped so it can live inside an `EventListener`
/// (`Arc<dyn Fn(&ClientEvent) + Send + Sync>`, a bound shared with every
/// other platform's background-thread event dispatch).
///
/// Safety: wasm32 without the `atomics` target feature (which this crate
/// does not enable) is single-threaded — there is never a second thread
/// this could be sent to or accessed from concurrently. `js_sys::Function`
/// is conservatively `!Send`/`!Sync` regardless, since it wraps a `JsValue`
/// — same justification as `trafficnetwork-core`'s wasm32 platform code
/// (`storage::IndexedDbStore`, `platform::ws`'s wasm module).
struct WasmEventCallback(js_sys::Function);
unsafe impl Send for WasmEventCallback {}
unsafe impl Sync for WasmEventCallback {}

/// A host-supplied secret store: a plain JS object with synchronous
/// `get(key)`, `set(key, value)` and `delete(key)` methods — the JS
/// counterpart of the C-ABI's `tn_client_new_with_secure_store` callbacks.
/// Sync on purpose: the core reads a secret in the middle of a call.
///
/// Safety: the same single-threaded-wasm32 argument as `WasmEventCallback`
/// above — `js_sys::Object` wraps a `JsValue`, conservatively `!Send`/`!Sync`.
struct JsSecureStore(js_sys::Object);
unsafe impl Send for JsSecureStore {}
unsafe impl Sync for JsSecureStore {}

impl JsSecureStore {
    fn method(&self, name: &str) -> Option<js_sys::Function> {
        js_sys::Reflect::get(&self.0, &JsValue::from_str(name))
            .ok()?
            .dyn_into::<js_sys::Function>()
            .ok()
    }
}

impl SecureStore for JsSecureStore {
    fn get(&self, key: &str) -> Option<String> {
        let value = self
            .method("get")?
            .call1(&self.0, &JsValue::from_str(key))
            .ok()?;
        // `null`/`undefined` (nothing stored) and anything that is not a
        // string both read as "not there" — the same answer a failing store
        // gives in the C-ABI and Python bindings.
        value.as_string()
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let method = self.method("set").ok_or("the secret store has no set()")?;
        method
            .call2(&self.0, &JsValue::from_str(key), &JsValue::from_str(value))
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let method = self
            .method("delete")
            .ok_or("the secret store has no delete()")?;
        method
            .call1(&self.0, &JsValue::from_str(key))
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }
}

/// A client. Mirrors the C-ABI's `Handle`/Python's `Client` — every binding
/// wraps the same `TrafficNetworkClient`, none add behavior of their own.
#[wasm_bindgen]
pub struct Client {
    inner: Arc<TrafficNetworkClient>,
    /// Set while `startRealtime` has a task running — same role as the
    /// C-ABI `Handle::realtime_stop`.
    realtime_stop: RefCell<Option<Arc<AtomicBool>>>,
}

#[wasm_bindgen]
impl Client {
    /// `options_json` is `client-lib/docs/api.md`'s options shape plus a
    /// `storagePath` field, used here as the IndexedDB database name (not a
    /// filesystem path — same field name as every other binding for a
    /// single shared options type across `conformance/scenarios.json`).
    ///
    /// `secure_store` (optional) is a JS object with synchronous `get`/
    /// `set`/`delete` methods that keeps the device's secrets instead of the
    /// default `localStorage` — see [`JsSecureStore`].
    pub async fn create(
        options_json: String,
        secure_store: Option<js_sys::Object>,
    ) -> Result<Client, JsValue> {
        console_error_panic_hook::set_once();
        let value: Value = serde_json::from_str(&options_json)
            .map_err(|e| js_error(format!("options are not JSON: {e}")))?;
        let db_name = value
            .get("storagePath")
            .and_then(Value::as_str)
            .ok_or_else(|| js_error("options need a `storagePath`"))?
            .to_string();
        let options: ClientOptions =
            serde_json::from_value(value).map_err(|e| js_error(format!("options: {e}")))?;
        let mut platform = Platform::wasm(&db_name)
            .await
            .map_err(|e| JsValue::from_str(&error_envelope(&e)))?;
        if let Some(store) = secure_store {
            platform.secure_store = Arc::new(JsSecureStore(store));
        }
        let client = TrafficNetworkClient::new(options, platform)
            .map_err(|e| JsValue::from_str(&error_envelope(&e)))?;
        Ok(Client {
            inner: Arc::new(client),
            realtime_stop: RefCell::new(None),
        })
    }

    /// Runs one API method — see `client-lib/docs/api.md` for the format;
    /// always resolves (never rejects) with `{"ok": ...}` or
    /// `{"error": {"code", "message"}}`, exactly like every other binding's
    /// `call`, so a JS caller checks the envelope rather than a thrown/
    /// rejected error for an ordinary API failure. `args_json` may be empty
    /// for a method that takes no arguments.
    pub async fn call(&self, method: String, args_json: String) -> String {
        AssertUnwindSafe(self.inner.call_json(&method, &args_json))
            .catch_unwind()
            .await
            .unwrap_or_else(|_| panic_envelope())
    }

    /// Keeps a WebSocket connection to the network open and applies pushed
    /// events (`client-lib/docs/api.md`, "Realtime push") — the JS
    /// counterpart of the C-ABI's `tn_client_start_realtime`, run on the
    /// page's own event loop instead of a library-owned thread. A no-op if
    /// already running.
    #[wasm_bindgen(js_name = startRealtime)]
    pub fn start_realtime(&self) {
        let mut slot = self.realtime_stop.borrow_mut();
        if slot.is_some() {
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        *slot = Some(stop.clone());
        let client = self.inner.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let _ = client.run_realtime(&stop).await;
        });
    }

    /// Asks a running realtime task to stop — between connection attempts,
    /// not by force-closing a connection that is open (see
    /// `TrafficNetworkClient::run_realtime`). A no-op if none is running.
    #[wasm_bindgen(js_name = stopRealtime)]
    pub fn stop_realtime(&self) {
        if let Some(stop) = self.realtime_stop.borrow_mut().take() {
            stop.store(true, Ordering::Relaxed);
        }
    }

    /// Registers (replacing any previous registration) a function called
    /// for every event as it happens — the JS equivalent of the C-ABI's
    /// `tn_client_set_event_callback`. Pass `undefined`/`null` to remove it.
    #[wasm_bindgen(js_name = onEvent)]
    pub fn on_event(&self, callback: Option<js_sys::Function>) {
        let listener: Option<EventListener> = callback.map(|callback| {
            let callback = WasmEventCallback(callback);
            let listener: EventListener = Arc::new(move |event| {
                let Ok(text) = serde_json::to_string(event) else {
                    return;
                };
                let _ = callback.0.call1(&JsValue::NULL, &JsValue::from_str(&text));
            });
            listener
        });
        self.inner.set_event_listener(listener);
    }
}
