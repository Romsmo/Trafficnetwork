//! What this crate adds on top of the core, checked without a network: the
//! result envelope, creation errors, the async call, and the host's secret
//! store and listener being contained when they fail. The full behavior of
//! the API is the conformance scenarios' business (run through the generated
//! Kotlin and Swift code in CI).

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};

use super::*;

fn temp_dir(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("tn-uniffi-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir.display().to_string()
}

fn options(dir: &str) -> String {
    json!({ "storagePath": dir, "nodes": ["http://127.0.0.1:9"], "discovery": false }).to_string()
}

fn parsed(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn client(name: &str) -> (Arc<TrafficNetworkClient>, String) {
    let dir = temp_dir(name);
    let client = TrafficNetworkClient::new(options(&dir), None).expect("a client");
    (client, dir)
}

#[test]
fn a_call_returns_the_result_envelope() {
    let (client, dir) = client("call");
    let version = parsed(&client.call("version".to_string(), String::new()));
    assert_eq!(version["ok"]["libraryVersion"], library_version());
    let unknown = parsed(&client.call("noSuchMethod".to_string(), "{}".to_string()));
    assert_eq!(unknown["error"]["code"], "invalidArgument");
    let bad_args = parsed(&client.call("getSpeedLimitAt".to_string(), "{nope".to_string()));
    assert_eq!(bad_args["error"]["code"], "invalidArgument");
    drop(client);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_async_call_gives_the_same_answer() {
    let (client, dir) = client("async");
    let text = runtime().block_on(client.call_async("version".to_string(), String::new()));
    assert!(parsed(&text)["ok"]["apiVersion"].is_number());
    drop(client);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn creation_errors_name_their_code() {
    for bad in ["{ not json", r#"{"nodes":["http://x"],"discovery":false}"#] {
        let Err(ClientError::Failed { error_code, .. }) =
            TrafficNetworkClient::new(bad.to_string(), None)
        else {
            panic!("a client was created from {bad}");
        };
        assert_eq!(error_code, "invalidArgument");
    }
}

#[test]
fn closing_the_last_reference_leaves_the_data_and_a_closed_client_says_so() {
    let (client, dir) = client("closed");
    assert!(parsed(&client.call("close".to_string(), String::new()))["ok"].is_object());
    let status = parsed(&client.call("getSyncStatus".to_string(), String::new()));
    assert_eq!(status["error"]["code"], "closed");
    drop(client);
    assert!(std::path::Path::new(&dir)
        .join("trafficnetwork.db")
        .exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn realtime_can_be_started_and_stopped_any_number_of_times() {
    let (client, dir) = client("realtime");
    client.start_realtime();
    client.start_realtime();
    client.stop_realtime();
    client.stop_realtime();
    client.start_realtime();
    drop(client);
    let _ = std::fs::remove_dir_all(&dir);
}

#[derive(Default)]
struct MapStore(Mutex<HashMap<String, String>>);

impl SecureStore for MapStore {
    fn get(&self, key: String) -> Result<Option<String>, HostError> {
        Ok(self.0.lock().unwrap().get(&key).cloned())
    }

    fn set(&self, key: String, value: String) -> Result<(), HostError> {
        self.0.lock().unwrap().insert(key, value);
        Ok(())
    }

    fn delete(&self, key: String) -> Result<(), HostError> {
        self.0.lock().unwrap().remove(&key);
        Ok(())
    }
}

struct BrokenStore;

impl SecureStore for BrokenStore {
    fn get(&self, _key: String) -> Result<Option<String>, HostError> {
        panic!("the keystore crashed");
    }

    fn set(&self, _key: String, _value: String) -> Result<(), HostError> {
        Err(HostError::Failed {
            detail: "the keystore is locked".to_string(),
        })
    }

    fn delete(&self, _key: String) -> Result<(), HostError> {
        panic!("the keystore crashed");
    }
}

#[test]
fn the_hosts_secret_store_is_reached_through_the_core_seam() {
    let store = HostSecureStore(Arc::new(MapStore::default()));
    assert_eq!(store.get("k"), None);
    store.set("k", "v").unwrap();
    assert_eq!(store.get("k"), Some("v".to_string()));
    store.delete("k").unwrap();
    assert_eq!(store.get("k"), None);
}

#[test]
fn a_failing_or_crashing_host_store_answers_not_there_or_refused() {
    let store = HostSecureStore(Arc::new(BrokenStore));
    assert_eq!(store.get("k"), None);
    assert!(store.set("k", "v").unwrap_err().contains("locked"));
    assert!(store.delete("k").is_err());
}

#[test]
fn a_client_can_be_created_with_the_hosts_secret_store() {
    let dir = temp_dir("host-store");
    let store: Arc<dyn SecureStore> = Arc::new(MapStore::default());
    let client = TrafficNetworkClient::new(options(&dir), Some(store)).expect("a client");
    assert!(parsed(&client.call("version".to_string(), String::new()))["ok"].is_object());
    drop(client);
    let _ = std::fs::remove_dir_all(&dir);
}
