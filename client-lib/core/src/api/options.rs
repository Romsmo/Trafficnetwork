//! What a host app gives [`super::TrafficNetworkClient`] when it starts one.

use serde::{Deserialize, Serialize};

/// The seed servers a client asks for the network's server list when the
/// host app names none. The domain is `trafficnetwork.info` (decided
/// 2026-09-27) — not yet in DNS, so nothing here is resolved by a test;
/// **the one place to change** once real seeds exist under it.
pub const DEFAULT_SEEDS: &[&str] = &[
    "https://seed1.trafficnetwork.info",
    "https://seed2.trafficnetwork.info",
];

/// The network's root public key (base64url, raw). None is built in yet —
/// the real key does not exist (only test keys do) — so without one from the
/// host app the signed network configuration cannot be verified and is
/// ignored, which only ever makes the client more restrictive (the network
/// configuration can narrow what is on, never widen it).
pub const DEFAULT_NETWORK_ROOT_KEY: Option<&str> = None;

/// How the client authenticates to servers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Credentials {
    /// A ready credential of scope `client` (a test tool, a server-side
    /// integration): used as is.
    #[serde(rename_all = "camelCase")]
    Client {
        client_id: String,
        client_secret: String,
    },
    /// The app's registration key (scope `device-registration`): the library
    /// registers this device with it once, keeps the resulting device
    /// credential in the secure store and uses that from then on.
    #[serde(rename_all = "camelCase")]
    App {
        app_client_id: String,
        app_client_secret: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientOptions {
    /// Fixed servers (base URLs). They are used directly, without asking a
    /// seed. With `discovery: false` they are the only servers ever used.
    pub nodes: Vec<String>,
    /// Look the network's servers up through the seeds' directory (default).
    /// Off: only `nodes`.
    pub discovery: bool,
    /// Seeds to start discovery from; empty means [`DEFAULT_SEEDS`].
    pub seeds: Vec<String>,
    /// The network root public key to verify the signed network
    /// configuration with — for a fork or a private network.
    pub network_root_key: Option<String>,
    pub credentials: Option<Credentials>,
    /// The host app's opt-in for the speed-camera namespace. Off by default,
    /// and it never overrides the server or the network configuration: all
    /// three have to allow it.
    pub camera_namespace_enabled: bool,
    /// How often [`super::TrafficNetworkClient::tick`] syncs, at the most.
    pub sync_interval_seconds: u64,
    /// How long a fetched `GET /v1/config` is used before it is fetched
    /// again. This is also how long a change of the network's camera policy
    /// can go unnoticed (a node whose packages were rebuilt is noticed
    /// earlier, at the next sync). `0` fetches it with every sync.
    pub config_refresh_seconds: u64,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            nodes: Vec::new(),
            discovery: true,
            seeds: Vec::new(),
            network_root_key: None,
            credentials: None,
            camera_namespace_enabled: false,
            sync_interval_seconds: 30,
            config_refresh_seconds: 120,
        }
    }
}

impl ClientOptions {
    /// The seeds discovery starts from.
    pub fn effective_seeds(&self) -> Vec<String> {
        if self.seeds.is_empty() {
            DEFAULT_SEEDS.iter().map(|s| (*s).to_string()).collect()
        } else {
            self.seeds.clone()
        }
    }

    /// The root key used to verify the network configuration, if any.
    pub fn effective_root_key(&self) -> Option<String> {
        self.network_root_key
            .clone()
            .or_else(|| DEFAULT_NETWORK_ROOT_KEY.map(str::to_string))
    }
}
