//! The C functions against a real (local, in-process) HTTP server: the whole
//! native stack — reqwest, SQLite, the async runtime — behind the C ABI.

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::*;
use crate::tn_free_string;

// ------------------------------------------------------------ scripted server

type Routes = HashMap<String, (u16, String)>;

struct TestServer {
    port: u16,
    log: Arc<Mutex<Vec<(String, String)>>>,
}

impl TestServer {
    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn requests_to(&self, key: &str) -> Vec<String> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _)| k == key)
            .map(|(_, body)| body.clone())
            .collect()
    }
}

fn handle(mut stream: std::net::TcpStream, routes: &Routes, log: &Mutex<Vec<(String, String)>>) {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut chunk).unwrap_or(0);
        if n == 0 {
            return;
        }
        buffer.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let content_length = head
        .lines()
        .find_map(|line| {
            let lower = line.to_ascii_lowercase();
            lower
                .strip_prefix("content-length:")
                .and_then(|v| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    while buffer.len() < header_end + content_length {
        let n = stream.read(&mut chunk).unwrap_or(0);
        if n == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&buffer[header_end..]).to_string();
    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("").split('?').next().unwrap_or("");
    let key = format!("{method} {path}");
    log.lock().unwrap().push((key.clone(), body));
    let (status, payload) = routes.get(&key).cloned().unwrap_or((404, "{}".to_string()));
    let response = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
        payload.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn start_server(routes: Routes) -> TestServer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let log = Arc::new(Mutex::new(Vec::new()));
    let served = log.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let routes = routes.clone();
            let served = served.clone();
            std::thread::spawn(move || handle(stream, &routes, &served));
        }
    });
    TestServer { port, log }
}

fn working_routes() -> Routes {
    let package = json!({
        "tile": "t1",
        "speedLimitSegments": [{
            "id": "seg1",
            "geometry": { "type": "LineString", "coordinates": [[13.0, 52.0], [13.01, 52.0]] },
            "speedLimit": 50, "speedLimitUnit": "kmh", "source": "osm", "sourceLicense": "ODbL",
            "importedAt": "2027-01-01T00:00:00Z", "lastConfirmedAt": null
        }],
        "staticSigns": [], "fixedSpeedCameras": []
    });
    let package_text = serde_json::to_string(&package).unwrap();
    let hash = hex::encode(Sha256::digest(package_text.as_bytes()));
    let mut routes = Routes::new();
    let mut add = |key: &str, status: u16, body: Value| {
        routes.insert(key.to_string(), (status, body.to_string()));
    };
    add(
        "POST /v1/auth/token",
        200,
        json!({ "accessToken": "tok", "tokenType": "Bearer", "expiresIn": 3600, "scopes": ["client"] }),
    );
    add(
        "POST /v1/devices/bind-key",
        200,
        json!({ "bound": true, "publicKey": "x" }),
    );
    add(
        "GET /v1/config",
        200,
        json!({
            "regionTileH3Resolution": 7, "staticDataPartitionH3Resolution": 4,
            "speedCameraNamespaceEnabled": false, "cameraNamespaceHazardTypes": [],
            "duplicateMergeRadiusMeters": 100, "speedLimitLookupMaxDistanceMeters": 50,
            "hazardExpiryMsByType": { "traffic": 900000 },
            "reportRateLimitMax": 10, "reportRateLimitWindowMinutes": 10,
            "cameraRemovalThreshold": 3, "staticDataVersion": 1, "federationEnabled": false,
            "networkConfig": null
        }),
    );
    add(
        "GET /v1/static-data/manifest",
        200,
        json!({
            "staticDataVersion": 1, "generatedAt": "2027-01-01T00:00:00Z",
            "partitions": [{ "tile": "t1", "hash": hash, "sizeBytes": package_text.len() }]
        }),
    );
    routes.insert(
        "GET /v1/static-data/partitions/t1".to_string(),
        (200, package_text),
    );
    let mut add = |key: &str, status: u16, body: Value| {
        routes.insert(key.to_string(), (status, body.to_string()));
    };
    add(
        "GET /v1/snapshot",
        200,
        json!({
            "snapshotSequence": 5, "speedLimitSegments": [], "staticSigns": [],
            "hazardReports": [], "fixedSpeedCameras": []
        }),
    );
    add(
        "POST /v1/hazard-reports",
        201,
        json!({ "report": {}, "merged": false }),
    );
    add(
        "POST /v1/devices/register",
        201,
        json!({ "clientId": "device-77", "clientSecret": "device-secret" }),
    );
    routes
}

// ------------------------------------------------------------------- helpers

fn temp_dir(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("tn-cabi-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir.display().to_string()
}

fn options(server: &TestServer, dir: &str, credentials: Value) -> String {
    json!({
        "storagePath": dir,
        "nodes": [server.url()],
        "discovery": false,
        "credentials": credentials,
    })
    .to_string()
}

fn device_credentials() -> Value {
    json!({ "type": "client", "clientId": "device-1", "clientSecret": "secret" })
}

fn take(ptr: *mut c_char) -> Value {
    assert!(!ptr.is_null());
    // Safety: a string this library returned, freed exactly once below.
    let text = unsafe { CStr::from_ptr(ptr) }.to_str().unwrap().to_string();
    unsafe { tn_free_string(ptr) };
    serde_json::from_str(&text).unwrap()
}

fn new_client(options: &str) -> *mut c_void {
    let options = CString::new(options).unwrap();
    let mut error: *mut c_char = std::ptr::null_mut();
    // Safety: valid C strings and a writable out-pointer.
    let client = unsafe { tn_client_new(options.as_ptr(), &mut error) };
    if client.is_null() {
        panic!("could not create a client: {}", take(error));
    }
    client
}

fn call(client: *mut c_void, method: &str, args: Value) -> Value {
    let method = CString::new(method).unwrap();
    let args = CString::new(args.to_string()).unwrap();
    // Safety: a live handle and valid C strings.
    take(unsafe { tn_client_call(client, method.as_ptr(), args.as_ptr()) })
}

// --------------------------------------------------------------------- tests

#[test]
fn a_client_syncs_reads_and_reports_through_the_c_functions() {
    let server = start_server(working_routes());
    let dir = temp_dir("basic");
    let client = new_client(&options(&server, &dir, device_credentials()));

    let sync = call(client, "sync", json!({}));
    assert_eq!(sync["ok"]["ok"], true, "{sync}");

    let limit = call(
        client,
        "getSpeedLimitAt",
        json!({ "lat": 52.0, "lng": 13.005 }),
    );
    assert_eq!(limit["ok"]["value"], 50.0);
    assert_eq!(limit["ok"]["unit"], "kmh");

    let report = call(
        client,
        "submitReport",
        json!({ "type": "traffic", "lat": 52.0, "lng": 13.0 }),
    );
    assert!(report["ok"]["localId"].is_string());
    let synced = call(client, "sync", json!({}));
    assert_eq!(synced["ok"]["submitted"], 1, "{synced}");
    let sent = server.requests_to("POST /v1/hazard-reports");
    assert_eq!(sent.len(), 1);
    let sent: Value = serde_json::from_str(&sent[0]).unwrap();
    assert_eq!(sent["type"], "traffic");
    assert!(sent.get("deviceAssertion").is_some());

    // Safety: a handle from tn_client_new, freed once.
    unsafe { tn_client_free(client) };
    // What was fetched is on disk: a new client sees it without any network.
    let dead_server = TestServer {
        port: 1,
        log: Arc::new(Mutex::new(Vec::new())),
    };
    let again = new_client(&options(&dead_server, &dir, device_credentials()));
    let limit = call(
        again,
        "getSpeedLimitAt",
        json!({ "lat": 52.0, "lng": 13.005 }),
    );
    assert_eq!(limit["ok"]["value"], 50.0);
    unsafe { tn_client_free(again) };
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn errors_come_back_as_json_never_as_a_crash() {
    let server = start_server(working_routes());
    let dir = temp_dir("errors");

    // Creation: bad options give NULL and an error string.
    let bad = CString::new("{ not json").unwrap();
    let mut error: *mut c_char = std::ptr::null_mut();
    // Safety: valid arguments.
    let client = unsafe { tn_client_new(bad.as_ptr(), &mut error) };
    assert!(client.is_null());
    assert_eq!(take(error)["error"]["code"], "invalidArgument");
    let missing_path = CString::new(r#"{"nodes":["http://x"],"discovery":false}"#).unwrap();
    let mut error: *mut c_char = std::ptr::null_mut();
    let client = unsafe { tn_client_new(missing_path.as_ptr(), &mut error) };
    assert!(client.is_null());
    assert_eq!(take(error)["error"]["code"], "invalidArgument");

    let client = new_client(&options(&server, &dir, device_credentials()));
    assert_eq!(
        call(client, "noSuchMethod", json!({}))["error"]["code"],
        "invalidArgument"
    );
    assert_eq!(
        call(client, "getSpeedLimitAt", json!({ "lat": "x" }))["error"]["code"],
        "invalidArgument"
    );
    // A NULL handle and a NULL method are errors too.
    let method = CString::new("sync").unwrap();
    // Safety: NULL is documented as allowed and answered with an error.
    let result =
        take(unsafe { tn_client_call(std::ptr::null_mut(), method.as_ptr(), std::ptr::null()) });
    assert_eq!(result["error"]["code"], "closed");
    let result = take(unsafe { tn_client_call(client, std::ptr::null(), std::ptr::null()) });
    assert_eq!(result["error"]["code"], "invalidArgument");

    // After the client is closed, calls fail cleanly.
    assert!(call(client, "close", Value::Null)["ok"].is_object());
    assert_eq!(
        call(client, "getSyncStatus", Value::Null)["error"]["code"],
        "closed"
    );
    unsafe { tn_client_free(client) };
    // Freeing NULL is fine.
    unsafe { tn_client_free(std::ptr::null_mut()) };
    let _ = std::fs::remove_dir_all(&dir);
}

extern "C" fn deliver_to_channel(user_data: *mut c_void, result: *const c_char) {
    // Safety: `user_data` is the `Sender` leaked by the test, `result` a valid string.
    let sender = unsafe { &*user_data.cast::<Mutex<Sender<String>>>() };
    let text = unsafe { CStr::from_ptr(result) }
        .to_str()
        .unwrap()
        .to_string();
    sender.lock().unwrap().send(text).unwrap();
}

#[test]
fn an_asynchronous_call_returns_at_once_and_calls_back() {
    let server = start_server(working_routes());
    let dir = temp_dir("async");
    let client = new_client(&options(&server, &dir, device_credentials()));
    let (sender, receiver) = channel::<String>();
    let user_data = Box::into_raw(Box::new(Mutex::new(sender)));

    let method = CString::new("sync").unwrap();
    let args = CString::new("{}").unwrap();
    // Safety: a live handle, valid strings, a callback that outlives the call.
    unsafe {
        tn_client_call_async(
            client,
            method.as_ptr(),
            args.as_ptr(),
            deliver_to_channel,
            user_data.cast::<c_void>(),
        );
    }
    let result = receiver.recv_timeout(Duration::from_secs(30)).unwrap();
    let result: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(result["ok"]["ok"], true, "{result}");

    unsafe {
        tn_client_free(client);
        drop(Box::from_raw(user_data));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

extern "C" fn record_event(user_data: *mut c_void, event: *const c_char) {
    // Safety: `user_data` is the `Mutex<Vec<String>>` owned by the test.
    let events = unsafe { &*user_data.cast::<Mutex<Vec<String>>>() };
    let text = unsafe { CStr::from_ptr(event) }
        .to_str()
        .unwrap()
        .to_string();
    events.lock().unwrap().push(text);
}

#[test]
fn events_reach_the_registered_callback() {
    let server = start_server(working_routes());
    let dir = temp_dir("events");
    let client = new_client(&options(&server, &dir, device_credentials()));
    let events = Box::into_raw(Box::new(Mutex::new(Vec::<String>::new())));
    // Safety: a live handle; the callback and its data outlive the client.
    unsafe { tn_client_set_event_callback(client, Some(record_event), events.cast::<c_void>()) };

    let sync = call(client, "sync", json!({}));
    assert_eq!(sync["ok"]["ok"], true);

    // Safety: still owned by this test.
    let seen = unsafe { &*events }.lock().unwrap().clone();
    assert!(
        seen.iter().any(|e| e.contains("\"syncCompleted\"")),
        "{seen:?}"
    );
    assert!(
        seen.iter().any(|e| e.contains("\"bootstrapProgress\"")),
        "{seen:?}"
    );
    unsafe {
        tn_client_free(client);
        drop(Box::from_raw(events));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

struct SecretMap(Mutex<HashMap<String, String>>);

extern "C" fn secret_get(
    user_data: *mut c_void,
    key: *const c_char,
    buffer: *mut c_char,
    capacity: i32,
) -> i32 {
    // Safety: `user_data` is a `SecretMap` owned by the test; `key` a valid string;
    // `buffer` writable for `capacity` bytes.
    let map = unsafe { &*user_data.cast::<SecretMap>() };
    let key = unsafe { CStr::from_ptr(key) }.to_str().unwrap();
    match map.0.lock().unwrap().get(key) {
        Some(value) if (value.len() as i32) < capacity => {
            unsafe {
                std::ptr::copy_nonoverlapping(value.as_ptr(), buffer.cast::<u8>(), value.len());
                *buffer.add(value.len()) = 0;
            }
            value.len() as i32
        }
        _ => -1,
    }
}

extern "C" fn secret_set(user_data: *mut c_void, key: *const c_char, value: *const c_char) -> i32 {
    let map = unsafe { &*user_data.cast::<SecretMap>() };
    let key = unsafe { CStr::from_ptr(key) }.to_str().unwrap().to_string();
    let value = unsafe { CStr::from_ptr(value) }
        .to_str()
        .unwrap()
        .to_string();
    map.0.lock().unwrap().insert(key, value);
    0
}

extern "C" fn secret_delete(user_data: *mut c_void, key: *const c_char) -> i32 {
    let map = unsafe { &*user_data.cast::<SecretMap>() };
    let key = unsafe { CStr::from_ptr(key) }.to_str().unwrap();
    map.0.lock().unwrap().remove(key);
    0
}

#[test]
fn the_hosts_own_secret_store_holds_the_device_credential_and_key() {
    let server = start_server(working_routes());
    let dir = temp_dir("secrets");
    let secrets = Box::into_raw(Box::new(SecretMap(Mutex::new(HashMap::new()))));
    let options = CString::new(options(
        &server,
        &dir,
        json!({ "type": "app", "appClientId": "app", "appClientSecret": "app-secret" }),
    ))
    .unwrap();
    let mut error: *mut c_char = std::ptr::null_mut();
    // Safety: valid strings, callbacks that stay valid, a writable out-pointer.
    let client = unsafe {
        tn_client_new_with_secure_store(
            options.as_ptr(),
            secret_get,
            secret_set,
            secret_delete,
            secrets.cast::<c_void>(),
            &mut error,
        )
    };
    assert!(!client.is_null(), "{}", take(error));

    let sync = call(client, "sync", json!({}));
    assert_eq!(sync["ok"]["ok"], true, "{sync}");

    // Safety: still owned by this test.
    let stored = unsafe { &*secrets }.0.lock().unwrap().clone();
    assert_eq!(
        stored.get("device.clientId").map(String::as_str),
        Some("device-77")
    );
    assert_eq!(
        stored.get("device.clientSecret").map(String::as_str),
        Some("device-secret")
    );
    assert!(stored.contains_key("device.privateKey"));
    assert_eq!(server.requests_to("POST /v1/devices/register").len(), 1);
    // And the default file store was not used.
    assert!(!std::path::Path::new(&dir)
        .join("secure-store.json")
        .exists());
    unsafe {
        tn_client_free(client);
        drop(Box::from_raw(secrets));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn starting_and_stopping_realtime_does_not_crash_and_is_idempotent() {
    let server = start_server(working_routes());
    let dir = temp_dir("realtime");
    let client = new_client(&options(&server, &dir, device_credentials()));

    // Safety: a live handle.
    let status = unsafe { tn_client_start_realtime(client) };
    assert_eq!(status, 0);
    // A second start while one is already running is a no-op, not a leak
    // of a second background task.
    let status_again = unsafe { tn_client_start_realtime(client) };
    assert_eq!(status_again, 0);

    // NULL is documented as safe for both.
    assert_eq!(
        unsafe { tn_client_start_realtime(std::ptr::null_mut()) },
        -1
    );
    unsafe { tn_client_stop_realtime(std::ptr::null_mut()) };

    unsafe { tn_client_stop_realtime(client) };
    // Stopping twice is also a no-op.
    unsafe { tn_client_stop_realtime(client) };

    // The background task (if it got that far) holds its own reference to
    // the client — freeing the handle right away must still be safe.
    unsafe { tn_client_free(client) };
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_library_version_is_a_string() {
    let version = tn_library_version();
    // Safety: a string this library returned.
    let text = unsafe { CStr::from_ptr(version) }
        .to_str()
        .unwrap()
        .to_string();
    unsafe { tn_free_string(version) };
    assert!(text.starts_with("0."), "{text}");
}
