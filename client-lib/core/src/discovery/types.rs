//! Mirrors `GET /v1/network/directory` and `GET /v1/network/node-info`'s
//! response shapes exactly (`server/docs/api.md`) — field names via
//! `serde(rename)` rather than renaming on the Rust side, so these structs
//! deserialize the server's JSON with no translation layer to get wrong.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReputationTier {
    Probation,
    Active,
    Trusted,
}

impl ReputationTier {
    /// Base weight for server-selection scoring (`discovery::scoring`) —
    /// higher tiers are strongly preferred, but never to the point of
    /// making a probation-tier server completely unreachable (it's still
    /// discoverable per the server's own directory design, just deprioritized).
    pub fn base_weight(self) -> f64 {
        match self {
            ReputationTier::Trusted => 10.0,
            ReputationTier::Active => 5.0,
            ReputationTier::Probation => 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelfInfo {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    pub address: Option<String>,
    #[serde(rename = "federationEnabled")]
    pub federation_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryPeer {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    pub address: String,
    pub tier: ReputationTier,
    #[serde(rename = "discoveredVia")]
    pub discovered_via: String,
    #[serde(rename = "joinedAt")]
    pub joined_at: String,
    #[serde(rename = "lastSeenAt")]
    pub last_seen_at: String,
    #[serde(rename = "lastKnownVersion")]
    pub last_known_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkDirectory {
    #[serde(rename = "self")]
    pub self_info: SelfInfo,
    pub peers: Vec<DirectoryPeer>,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeInfo {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    #[serde(rename = "federationEnabled")]
    pub federation_enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_a_directory_response_shaped_like_the_server_docs() {
        let json = serde_json::json!({
            "self": { "nodeId": "abc123", "publicKey": "pub", "address": "https://a.example", "federationEnabled": true },
            "peers": [
                { "nodeId": "peer1", "publicKey": "pub1", "address": "https://b.example", "tier": "trusted",
                  "discoveredVia": "seed", "joinedAt": "2026-01-01T00:00:00Z", "lastSeenAt": "2026-01-02T00:00:00Z",
                  "lastKnownVersion": "0.1.0" }
            ],
            "generatedAt": "2026-01-02T00:00:00Z"
        });
        let directory: NetworkDirectory = serde_json::from_value(json).unwrap();
        assert_eq!(directory.self_info.node_id, "abc123");
        assert_eq!(directory.peers.len(), 1);
        assert_eq!(directory.peers[0].tier, ReputationTier::Trusted);
    }

    #[test]
    fn tier_order_prefers_trusted_over_active_over_probation() {
        assert!(ReputationTier::Trusted.base_weight() > ReputationTier::Active.base_weight());
        assert!(ReputationTier::Active.base_weight() > ReputationTier::Probation.base_weight());
    }
}
