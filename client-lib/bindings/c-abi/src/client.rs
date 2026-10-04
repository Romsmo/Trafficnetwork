//! The client API over the C ABI: one opaque handle and one function that
//! runs any API method given by name — `tn_client_call(handle, "sync", "{}")`
//! — with JSON in and JSON out. Every language binding (Python, Node, Dart,
//! Kotlin, Swift, ...) is a thin wrapper around exactly these functions, so
//! they all see the same method names, argument shapes, results and errors
//! (`client-lib/docs/api.md`).
//!
//! **Results.** Every call returns a string, allocated by this library, that
//! the caller frees with [`tn_free_string`]: `{"ok": <result>}` on success or
//! `{"error": {"code": "...", "message": "..."}}` on failure. Nothing here
//! ever unwinds a panic into the caller; a panic becomes an `internal` error.
//!
//! **Threads.** A handle may be used from any thread, several at once.
//! `tn_client_call` blocks the calling thread until the call is done
//! (network calls take as long as the network); `tn_client_call_async` does
//! not, and calls back from a library thread instead.
//!
//! **Secrets.** By default the device's secrets go into a file in the storage
//! directory (readable by the current user only — not hardware-backed). An
//! app on a platform with a keystore passes its own through
//! [`tn_client_new_with_secure_store`].

use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

use tokio::runtime::Runtime;
use trafficnetwork_core::api::{
    code, error_envelope, panic_envelope, ApiError, SecureStore, TrafficNetworkClient,
};

fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("the async runtime could not start")
    })
}

fn to_c_string(text: String) -> *mut c_char {
    CString::new(text)
        .unwrap_or_else(|_| {
            CString::new(r#"{"error":{"code":"internal","message":"NUL byte in result"}}"#).unwrap()
        })
        .into_raw()
}

/// Reads a C string argument; `None` for NULL or invalid UTF-8.
///
/// # Safety
/// `ptr` must be NULL or a valid NUL-terminated string.
unsafe fn read_str(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    // Safety: the caller promises a valid NUL-terminated string.
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .ok()
        .map(str::to_owned)
}

/// What a handle points at.
struct Handle {
    client: Arc<TrafficNetworkClient>,
    /// Set while `tn_client_start_realtime` has a background task running;
    /// `tn_client_stop_realtime`/a second `start` flips it and replaces it
    /// with a fresh one for any later restart.
    realtime_stop: Mutex<Option<Arc<AtomicBool>>>,
}

// -------------------------------------------------------------- secure store

/// Reads a secret: writes the value (NUL-terminated, shorter than `capacity`)
/// into `buffer` and returns its length, or returns -1 if there is none.
pub type TnSecureGet = unsafe extern "C" fn(
    user_data: *mut c_void,
    key: *const c_char,
    buffer: *mut c_char,
    capacity: i32,
) -> i32;
/// Stores a secret; returns 0 on success.
pub type TnSecureSet =
    unsafe extern "C" fn(user_data: *mut c_void, key: *const c_char, value: *const c_char) -> i32;
/// Forgets a secret; returns 0 on success.
pub type TnSecureDelete = unsafe extern "C" fn(user_data: *mut c_void, key: *const c_char) -> i32;

/// The host app's secret store, reached through function pointers.
struct CallbackSecureStore {
    user_data: usize,
    get: TnSecureGet,
    set: TnSecureSet,
    delete: TnSecureDelete,
}

// Safety: the host promises its callbacks may be called from any thread
// (documented on `tn_client_new_with_secure_store`); `user_data` is an opaque
// number the library never dereferences.
unsafe impl Send for CallbackSecureStore {}
unsafe impl Sync for CallbackSecureStore {}

/// Secrets are short (base64 keys, ids); this is far more than they need.
const SECRET_BUFFER: usize = 4096;

impl SecureStore for CallbackSecureStore {
    fn get(&self, key: &str) -> Option<String> {
        let key = CString::new(key).ok()?;
        let mut buffer = vec![0u8; SECRET_BUFFER];
        // Safety: the host's callback is called with a valid key string and a
        // writable buffer of the stated capacity.
        let length = unsafe {
            (self.get)(
                self.user_data as *mut c_void,
                key.as_ptr(),
                buffer.as_mut_ptr().cast::<c_char>(),
                SECRET_BUFFER as i32,
            )
        };
        let length = usize::try_from(length).ok()?;
        if length >= SECRET_BUFFER {
            return None;
        }
        String::from_utf8(buffer[..length].to_vec()).ok()
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let key = CString::new(key).map_err(|e| e.to_string())?;
        let value = CString::new(value).map_err(|e| e.to_string())?;
        // Safety: valid NUL-terminated strings for the duration of the call.
        let status =
            unsafe { (self.set)(self.user_data as *mut c_void, key.as_ptr(), value.as_ptr()) };
        if status == 0 {
            Ok(())
        } else {
            Err(format!(
                "the host's secret store refused the write ({status})"
            ))
        }
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let key = CString::new(key).map_err(|e| e.to_string())?;
        // Safety: a valid NUL-terminated string for the duration of the call.
        let status = unsafe { (self.delete)(self.user_data as *mut c_void, key.as_ptr()) };
        if status == 0 {
            Ok(())
        } else {
            Err(format!(
                "the host's secret store refused the delete ({status})"
            ))
        }
    }
}

// ------------------------------------------------------------------ creation

fn create(
    options_json: &str,
    secure_store: Option<Arc<dyn SecureStore>>,
) -> Result<Handle, ApiError> {
    // reqwest needs a running runtime to build its client on some platforms.
    let _enter = runtime().enter();
    let client = TrafficNetworkClient::open_native(options_json, secure_store)?;
    Ok(Handle {
        client: Arc::new(client),
        realtime_stop: Mutex::new(None),
    })
}

unsafe fn new_client(
    options_json: *const c_char,
    secure_store: Option<Arc<dyn SecureStore>>,
    error_json: *mut *mut c_char,
) -> *mut c_void {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // Safety: forwarded from the caller's promise about `options_json`.
        let Some(options) = (unsafe { read_str(options_json) }) else {
            return Err(ApiError::new(
                code::INVALID_ARGUMENT,
                "options must be a JSON string",
            ));
        };
        create(&options, secure_store)
    }));
    match outcome {
        Ok(Ok(handle)) => Box::into_raw(Box::new(handle)).cast::<c_void>(),
        Ok(Err(error)) => {
            if !error_json.is_null() {
                // Safety: `error_json` is NULL or writable, per the contract.
                unsafe { *error_json = to_c_string(error_envelope(&error)) };
            }
            std::ptr::null_mut()
        }
        Err(_) => {
            if !error_json.is_null() {
                // Safety: as above.
                unsafe { *error_json = to_c_string(panic_envelope()) };
            }
            std::ptr::null_mut()
        }
    }
}

/// Creates a client. `options_json` is the client's options (see
/// `client-lib/docs/api.md`) plus `storagePath`, the directory the client
/// keeps its database and its secrets in. Returns an opaque handle, or NULL
/// — then, if `error_json` is not NULL, `*error_json` is set to an error
/// string (`{"error": {...}}`) the caller frees with `tn_free_string`.
///
/// # Safety
/// `options_json` must be a valid NUL-terminated string; `error_json` must be
/// NULL or point to a writable `char *`.
#[no_mangle]
pub unsafe extern "C" fn tn_client_new(
    options_json: *const c_char,
    error_json: *mut *mut c_char,
) -> *mut c_void {
    // Safety: forwarded.
    unsafe { new_client(options_json, None, error_json) }
}

/// [`tn_client_new`] with the device's secrets kept in the host app's own
/// store (Keychain, Keystore, ...) instead of a file. The three callbacks may
/// be called from any thread, also concurrently, and must stay valid until
/// `tn_client_free`; `user_data` is passed back to them untouched.
///
/// # Safety
/// As for `tn_client_new`; the callbacks must honour their documented contracts.
#[no_mangle]
pub unsafe extern "C" fn tn_client_new_with_secure_store(
    options_json: *const c_char,
    get: TnSecureGet,
    set: TnSecureSet,
    delete: TnSecureDelete,
    user_data: *mut c_void,
    error_json: *mut *mut c_char,
) -> *mut c_void {
    let store: Arc<dyn SecureStore> = Arc::new(CallbackSecureStore {
        user_data: user_data as usize,
        get,
        set,
        delete,
    });
    // Safety: forwarded.
    unsafe { new_client(options_json, Some(store), error_json) }
}

/// Releases a client. The data it stored stays on disk, so a new client on
/// the same directory carries on. Safe with NULL. Do not use the handle again,
/// and do not free it while a call on it is still running.
///
/// # Safety
/// `client` must be NULL or a handle from `tn_client_new*`, freed at most once.
#[no_mangle]
pub unsafe extern "C" fn tn_client_free(client: *mut c_void) {
    if client.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // Safety: the caller passes back exactly a handle this library made.
        let handle = unsafe { Box::from_raw(client.cast::<Handle>()) };
        handle.client.close();
    }));
}

// --------------------------------------------------------------------- calls

fn run_call(client: &Arc<TrafficNetworkClient>, method: &str, args: &str) -> String {
    let result = catch_unwind(AssertUnwindSafe(|| {
        runtime().block_on(client.call_json(method, args))
    }));
    result.unwrap_or_else(|_| panic_envelope())
}

/// Runs one API method and returns its result — see the module documentation
/// for the format; free the returned string with `tn_free_string`. Blocks
/// until the call is done. `args_json` may be NULL or empty for a method
/// without arguments.
///
/// # Safety
/// `client` must be a live handle; `method` a valid NUL-terminated string;
/// `args_json` NULL or a valid NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn tn_client_call(
    client: *mut c_void,
    method: *const c_char,
    args_json: *const c_char,
) -> *mut c_char {
    if client.is_null() {
        return to_c_string(error_envelope(&ApiError::new(code::CLOSED, "no client")));
    }
    // Safety: a live handle, per the contract.
    let handle = unsafe { &*client.cast::<Handle>() };
    // Safety: valid strings, per the contract.
    let (method, args) = unsafe { (read_str(method), read_str(args_json)) };
    let Some(method) = method else {
        return to_c_string(error_envelope(&ApiError::new(
            code::INVALID_ARGUMENT,
            "the method name must be a string",
        )));
    };
    to_c_string(run_call(
        &handle.client,
        &method,
        args.as_deref().unwrap_or(""),
    ))
}

/// Called with the result string (valid only during the call — copy it) when
/// an asynchronous call is done, from a thread of the library.
pub type TnResultCallback =
    unsafe extern "C" fn(user_data: *mut c_void, result_json: *const c_char);

/// [`tn_client_call`] without blocking: returns at once and calls `callback`
/// with the result when the call is done.
///
/// # Safety
/// As for `tn_client_call`; `callback` must be callable from any thread and
/// stay valid until it has been called; the handle must not be freed before.
#[no_mangle]
pub unsafe extern "C" fn tn_client_call_async(
    client: *mut c_void,
    method: *const c_char,
    args_json: *const c_char,
    callback: TnResultCallback,
    user_data: *mut c_void,
) {
    let user_data = user_data as usize;
    let deliver = move |text: String| {
        let text = CString::new(text).unwrap_or_default();
        // Safety: the callback's contract; the string outlives the call.
        unsafe { callback(user_data as *mut c_void, text.as_ptr()) };
    };
    if client.is_null() {
        deliver(error_envelope(&ApiError::new(code::CLOSED, "no client")));
        return;
    }
    // Safety: a live handle, per the contract.
    let handle = unsafe { &*client.cast::<Handle>() };
    // Safety: valid strings, per the contract.
    let (method, args) = unsafe { (read_str(method), read_str(args_json)) };
    let Some(method) = method else {
        deliver(error_envelope(&ApiError::new(
            code::INVALID_ARGUMENT,
            "the method name must be a string",
        )));
        return;
    };
    let client = handle.client.clone();
    let args = args.unwrap_or_default();
    // A thread per call: calls are rare (a sync every few seconds at most)
    // and this keeps the caller's callback off the runtime's own threads.
    std::thread::spawn(move || {
        let result = run_call(&client, &method, &args);
        deliver(result);
    });
}

/// Called with each event (valid only during the call — copy it), from a
/// thread of the library.
pub type TnEventCallback = unsafe extern "C" fn(user_data: *mut c_void, event_json: *const c_char);

/// Registers (or, with NULL, removes) a function called for every event as it
/// happens. Events are also queued for `pollEvents`.
///
/// # Safety
/// `client` must be a live handle; `callback` (if any) must be callable from
/// any thread and stay valid until removed or the handle is freed.
#[no_mangle]
pub unsafe extern "C" fn tn_client_set_event_callback(
    client: *mut c_void,
    callback: Option<TnEventCallback>,
    user_data: *mut c_void,
) {
    if client.is_null() {
        return;
    }
    // Safety: a live handle, per the contract.
    let handle = unsafe { &*client.cast::<Handle>() };
    let user_data = user_data as usize;
    let listener = callback.map(|callback| {
        let listener: trafficnetwork_core::api::EventListener = Arc::new(move |event| {
            let Ok(text) = serde_json::to_string(event) else {
                return;
            };
            let text = CString::new(text).unwrap_or_default();
            // Safety: the callback's contract; the string outlives the call.
            unsafe { callback(user_data as *mut c_void, text.as_ptr()) };
        });
        listener
    });
    handle.client.set_event_listener(listener);
}

// -------------------------------------------------------------- realtime

/// Starts (add-on B1) a background task that keeps a WebSocket connection
/// to the network open and applies pushed events as they arrive, spawned on
/// this crate's own runtime — the host app does not need one of its own.
/// Events surface exactly like any other (`pollEvents`/the event callback);
/// there is no separate realtime-specific callback. A no-op if realtime is
/// already running on this handle. Returns 0 on success, -1 for a NULL
/// handle.
///
/// # Safety
/// `client` must be NULL or a live handle from `tn_client_new*`.
#[no_mangle]
pub unsafe extern "C" fn tn_client_start_realtime(client: *mut c_void) -> i32 {
    if client.is_null() {
        return -1;
    }
    // Every other function here that touches a `Handle` is wrapped the same
    // way (see `tn_client_call`/`tn_client_free`) — unwinding a panic across
    // an `extern "C"` boundary is undefined behavior, not just an ugly crash,
    // so a poisoned `Mutex` (or anything else panicking below) must never be
    // allowed past this point uncaught.
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // Safety: a live handle, per the contract.
        let handle = unsafe { &*client.cast::<Handle>() };
        let mut stop_slot = handle.realtime_stop.lock().unwrap();
        if stop_slot.is_some() {
            return; // already running
        }
        let stop = Arc::new(AtomicBool::new(false));
        *stop_slot = Some(stop.clone());
        drop(stop_slot);
        let client_arc = handle.client.clone();
        runtime().spawn(async move {
            let _ = client_arc.run_realtime(&stop).await;
        });
    }));
    match outcome {
        Ok(()) => 0,
        Err(_) => -1,
    }
}

/// Signals a running realtime task to stop and returns at once — it stops
/// between connection attempts, not by force-closing a connection already
/// open (see `run_realtime`'s own documentation). A no-op if none is
/// running, or `client` is NULL.
///
/// # Safety
/// `client` must be NULL or a live handle from `tn_client_new*`.
#[no_mangle]
pub unsafe extern "C" fn tn_client_stop_realtime(client: *mut c_void) {
    if client.is_null() {
        return;
    }
    // See `tn_client_start_realtime`'s comment on why this must not let a
    // panic unwind across the FFI boundary.
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // Safety: a live handle, per the contract.
        let handle = unsafe { &*client.cast::<Handle>() };
        if let Some(stop) = handle.realtime_stop.lock().unwrap().take() {
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }));
}

/// The library's version, as a string to free with `tn_free_string`.
#[no_mangle]
pub extern "C" fn tn_library_version() -> *mut c_char {
    to_c_string(env!("CARGO_PKG_VERSION").to_string())
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
