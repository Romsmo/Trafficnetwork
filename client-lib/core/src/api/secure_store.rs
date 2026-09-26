//! Where the device's secrets live. The host app supplies the real thing
//! (Keychain, Android Keystore, a browser's WebCrypto/IndexedDB, ...); the
//! library only stores three things through it: the device credential
//! (`clientId`, `clientSecret`) and the device's signing key.

use std::collections::HashMap;
use std::sync::Mutex;

pub const KEY_CLIENT_ID: &str = "device.clientId";
pub const KEY_CLIENT_SECRET: &str = "device.clientSecret";
pub const KEY_PUBLIC_KEY: &str = "device.publicKey";
pub const KEY_PRIVATE_KEY: &str = "device.privateKey";
/// The public key the server has accepted as this device's bound key.
pub const KEY_BOUND_PUBLIC_KEY: &str = "device.boundPublicKey";

pub trait SecureStore: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

/// Keeps secrets in memory only — for tests, or an app that wants a new
/// device identity on every start.
#[derive(Default)]
pub struct MemorySecureStore {
    values: Mutex<HashMap<String, String>>,
}

impl MemorySecureStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecureStore for MemorySecureStore {
    fn get(&self, key: &str) -> Option<String> {
        self.values.lock().unwrap().get(key).cloned()
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.values
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.values.lock().unwrap().remove(key);
        Ok(())
    }
}

/// A JSON file readable only by the current user (mode 0600 on Unix, the
/// user's own profile directory on Windows). **Not hardware-backed** — a
/// stand-in for platforms without a keystore the app wires in (desktop tools,
/// servers, tests); a phone app should pass the platform's own.
#[cfg(not(target_arch = "wasm32"))]
pub struct FileSecureStore {
    path: std::path::PathBuf,
    lock: Mutex<()>,
}

#[cfg(not(target_arch = "wasm32"))]
impl FileSecureStore {
    pub fn new(path: impl Into<std::path::PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
        }
    }

    fn read_all(&self) -> HashMap<String, String> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write_all(&self, values: &HashMap<String, String>) -> Result<(), String> {
        let bytes = serde_json::to_vec(values).map_err(|e| e.to_string())?;
        let temporary = self.path.with_extension("tmp");
        std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&temporary, &self.path).map_err(|e| e.to_string())
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl SecureStore for FileSecureStore {
    fn get(&self, key: &str) -> Option<String> {
        let _guard = self.lock.lock().unwrap();
        self.read_all().get(key).cloned()
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap();
        let mut values = self.read_all();
        values.insert(key.to_string(), value.to_string());
        self.write_all(&values)
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap();
        let mut values = self.read_all();
        values.remove(key);
        self.write_all(&values)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_memory_store_keeps_and_forgets_values() {
        let store = MemorySecureStore::new();
        assert_eq!(store.get("a"), None);
        store.set("a", "1").unwrap();
        assert_eq!(store.get("a").as_deref(), Some("1"));
        store.delete("a").unwrap();
        assert_eq!(store.get("a"), None);
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn a_file_store_survives_being_opened_again() {
        let path = std::env::temp_dir().join(format!("tn-secure-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let store = FileSecureStore::new(&path);
            store.set(KEY_CLIENT_ID, "device-1").unwrap();
            store.set(KEY_CLIENT_SECRET, "s3cret").unwrap();
            store.delete(KEY_CLIENT_SECRET).unwrap();
        }
        let store = FileSecureStore::new(&path);
        assert_eq!(store.get(KEY_CLIENT_ID).as_deref(), Some("device-1"));
        assert_eq!(store.get(KEY_CLIENT_SECRET), None);
        let _ = std::fs::remove_file(&path);
    }
}
