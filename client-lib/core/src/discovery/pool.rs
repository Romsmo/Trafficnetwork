//! `ServerPool`: the failover state machine (F-C0 plan §1.3) — tracks every
//! server this library has ever heard of, their measured latency/error
//! history, and which ones are currently in backoff, then hands out a
//! ranked "current pool" (§1.2) for the sync engine (F-C3) to actually use.
//! Pure/deterministic given its inputs (no direct clock/RNG calls inside the
//! scoring path itself) so it's fully unit-testable without real time or
//! randomness — `now_unix_ms` and `jitter_source` are passed in.

use std::collections::{HashMap, VecDeque};

use super::scoring::{score, ScoreInputs};
use super::types::{NetworkDirectory, ReputationTier};

/// How many recent outcomes feed the error-rate signal — a small ring
/// buffer, not the server's own long-lived reputation counters (this is a
/// purely local, short-memory client-side view of "has this server been
/// working *for me* lately").
const ERROR_WINDOW_SIZE: usize = 20;

const BASE_BACKOFF_MS: i64 = 1_000;
const MAX_BACKOFF_MS: i64 = 5 * 60 * 1_000;

#[derive(Debug, Clone)]
pub struct KnownServer {
    pub node_id: String,
    pub public_key: String,
    pub address: String,
    pub tier: ReputationTier,
    pub latency_ema_ms: Option<f64>,
    recent_outcomes: VecDeque<bool>,
    pub consecutive_failures: u32,
    pub backoff_until_unix_ms: Option<i64>,
    /// Set by `record_withholding_suspicion` (F-C0 plan §1.5, wired up in
    /// F-C3 once the sync engine can actually cross-check peers) — a purely
    /// local, non-binding malus, never sent anywhere.
    pub withholding_strikes: u32,
}

impl KnownServer {
    fn new(node_id: String, public_key: String, address: String, tier: ReputationTier) -> Self {
        Self {
            node_id,
            public_key,
            address,
            tier,
            latency_ema_ms: None,
            recent_outcomes: VecDeque::with_capacity(ERROR_WINDOW_SIZE),
            consecutive_failures: 0,
            backoff_until_unix_ms: None,
            withholding_strikes: 0,
        }
    }

    fn error_rate(&self) -> f64 {
        if self.recent_outcomes.is_empty() {
            return 0.0;
        }
        let failures = self.recent_outcomes.iter().filter(|ok| !**ok).count();
        failures as f64 / self.recent_outcomes.len() as f64
    }

    fn push_outcome(&mut self, ok: bool) {
        if self.recent_outcomes.len() == ERROR_WINDOW_SIZE {
            self.recent_outcomes.pop_front();
        }
        self.recent_outcomes.push_back(ok);
    }

    pub fn is_backed_off(&self, now_unix_ms: i64) -> bool {
        self.backoff_until_unix_ms.map(|until| now_unix_ms < until).unwrap_or(false)
    }
}

pub struct ServerPool {
    servers: HashMap<String, KnownServer>,
    pool_size: usize,
}

impl ServerPool {
    pub fn new(pool_size: usize) -> Self {
        Self { servers: HashMap::new(), pool_size }
    }

    /// Merges a freshly fetched directory in — new servers are added, and
    /// existing ones keep their accumulated latency/error/backoff history
    /// (only their `tier`/`address` are refreshed) rather than being reset,
    /// since that history is exactly what selection depends on.
    pub fn ingest_directory(&mut self, directory: &NetworkDirectory) {
        for peer in &directory.peers {
            self.servers
                .entry(peer.node_id.clone())
                .and_modify(|s| {
                    s.tier = peer.tier;
                    s.address = peer.address.clone();
                })
                .or_insert_with(|| {
                    KnownServer::new(peer.node_id.clone(), peer.public_key.clone(), peer.address.clone(), peer.tier)
                });
        }
    }

    /// For seeding the pool with a server reached directly (a built-in seed,
    /// or a host-app-supplied fixed `nodes[]` entry) before any directory
    /// has ever been fetched from it.
    pub fn add_known_server(&mut self, node_id: String, public_key: String, address: String, tier: ReputationTier) {
        self.servers
            .entry(node_id.clone())
            .or_insert_with(|| KnownServer::new(node_id, public_key, address, tier));
    }

    pub fn record_success(&mut self, node_id: &str, latency_ms: f64) {
        let Some(server) = self.servers.get_mut(node_id) else { return };
        server.consecutive_failures = 0;
        server.backoff_until_unix_ms = None;
        server.push_outcome(true);
        // EMA with alpha=0.3 — recent measurements dominate but one slow
        // request doesn't swing the score to the same degree a sustained
        // trend does.
        server.latency_ema_ms = Some(match server.latency_ema_ms {
            Some(prev) => prev * 0.7 + latency_ms * 0.3,
            None => latency_ms,
        });
    }

    /// `jitter_fraction` must be `0.0..=1.0` from the caller's own random
    /// source — kept out of this function so the backoff math itself stays
    /// deterministic and unit-testable.
    pub fn record_failure(&mut self, node_id: &str, now_unix_ms: i64, jitter_fraction: f64) {
        let Some(server) = self.servers.get_mut(node_id) else { return };
        server.push_outcome(false);
        server.consecutive_failures += 1;
        let exponent = server.consecutive_failures.min(20); // guards against overflow in 2^n at high counts
        let raw_backoff = (BASE_BACKOFF_MS as f64) * 2f64.powi(exponent as i32 - 1);
        let backoff_ms = raw_backoff.min(MAX_BACKOFF_MS as f64);
        let jittered_ms = backoff_ms * (0.5 + jitter_fraction.clamp(0.0, 1.0) * 0.5);
        server.backoff_until_unix_ms = Some(now_unix_ms + jittered_ms as i64);
    }

    pub fn record_withholding_suspicion(&mut self, node_id: &str) {
        if let Some(server) = self.servers.get_mut(node_id) {
            server.withholding_strikes += 1;
        }
    }

    pub fn get(&self, node_id: &str) -> Option<&KnownServer> {
        self.servers.get(node_id)
    }

    pub fn node_ids(&self) -> impl Iterator<Item = &String> {
        self.servers.keys()
    }

    /// The ranked pool the sync engine should actually use right now —
    /// servers currently in backoff are excluded entirely (not just
    /// deprioritized), everything else is ranked by `scoring::score`
    /// (withholding strikes apply an additional flat penalty per strike,
    /// on top of the usual reputation/latency/error factors) and truncated
    /// to `pool_size`. `jitter_fractions` supplies one `0.0..=1.0` value per
    /// eligible server (order-independent — matched up by node_id), from
    /// the caller's own random source.
    pub fn current_pool(&self, now_unix_ms: i64, jitter_fractions: &HashMap<String, f64>) -> Vec<String> {
        let mut ranked: Vec<(String, f64)> = self
            .servers
            .values()
            .filter(|s| !s.is_backed_off(now_unix_ms))
            .map(|s| {
                let jitter = jitter_fractions.get(&s.node_id).copied().unwrap_or(0.0);
                let inputs = ScoreInputs { tier: s.tier, latency_ema_ms: s.latency_ema_ms, error_rate: s.error_rate(), jitter };
                let withholding_penalty = s.withholding_strikes as f64 * 2.0;
                (s.node_id.clone(), score(&inputs) - withholding_penalty)
            })
            .collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ranked.into_iter().take(self.pool_size).map(|(id, _)| id).collect()
    }

    pub fn known_server_count(&self) -> usize {
        self.servers.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory_with_peers(peers: &[(&str, ReputationTier)]) -> NetworkDirectory {
        use super::super::types::{DirectoryPeer, SelfInfo};
        NetworkDirectory {
            self_info: SelfInfo {
                node_id: "self".into(),
                public_key: "selfkey".into(),
                address: None,
                federation_enabled: true,
            },
            peers: peers
                .iter()
                .map(|(id, tier)| DirectoryPeer {
                    node_id: id.to_string(),
                    public_key: format!("{id}-key"),
                    address: format!("https://{id}.example"),
                    tier: *tier,
                    discovered_via: "seed".into(),
                    joined_at: "2026-01-01T00:00:00Z".into(),
                    last_seen_at: "2026-01-01T00:00:00Z".into(),
                    last_known_version: None,
                })
                .collect(),
            generated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn ingesting_a_directory_adds_new_servers() {
        let mut pool = ServerPool::new(3);
        pool.ingest_directory(&directory_with_peers(&[("a", ReputationTier::Active), ("b", ReputationTier::Trusted)]));
        assert_eq!(pool.known_server_count(), 2);
    }

    #[test]
    fn re_ingesting_preserves_accumulated_latency_history() {
        let mut pool = ServerPool::new(3);
        pool.ingest_directory(&directory_with_peers(&[("a", ReputationTier::Active)]));
        pool.record_success("a", 42.0);
        pool.ingest_directory(&directory_with_peers(&[("a", ReputationTier::Trusted)])); // tier changed upstream
        let server = pool.get("a").unwrap();
        assert_eq!(server.tier, ReputationTier::Trusted); // refreshed
        assert_eq!(server.latency_ema_ms, Some(42.0)); // preserved, not reset
    }

    #[test]
    fn a_backed_off_server_is_excluded_from_the_current_pool() {
        let mut pool = ServerPool::new(3);
        pool.ingest_directory(&directory_with_peers(&[("a", ReputationTier::Trusted), ("b", ReputationTier::Probation)]));
        pool.record_failure("a", 1_000, 0.0);
        let jitters = HashMap::new();
        let selected = pool.current_pool(1_000, &jitters); // still within backoff window
        assert!(!selected.contains(&"a".to_string()));
        assert!(selected.contains(&"b".to_string()));
    }

    #[test]
    fn backoff_expires_after_its_window() {
        let mut pool = ServerPool::new(3);
        pool.ingest_directory(&directory_with_peers(&[("a", ReputationTier::Trusted)]));
        pool.record_failure("a", 0, 0.0);
        let until = pool.get("a").unwrap().backoff_until_unix_ms.unwrap();
        assert!(!pool.get("a").unwrap().is_backed_off(until + 1));
    }

    #[test]
    fn backoff_grows_with_consecutive_failures() {
        let mut pool = ServerPool::new(3);
        pool.ingest_directory(&directory_with_peers(&[("a", ReputationTier::Trusted)]));
        pool.record_failure("a", 0, 0.0);
        let first_backoff = pool.get("a").unwrap().backoff_until_unix_ms.unwrap();
        pool.record_failure("a", first_backoff, 0.0);
        let second_backoff = pool.get("a").unwrap().backoff_until_unix_ms.unwrap() - first_backoff;
        assert!(second_backoff > first_backoff); // grew relative to the first (exponential)
    }

    #[test]
    fn a_success_resets_consecutive_failures_and_backoff() {
        let mut pool = ServerPool::new(3);
        pool.ingest_directory(&directory_with_peers(&[("a", ReputationTier::Trusted)]));
        pool.record_failure("a", 0, 0.0);
        pool.record_success("a", 10.0);
        let server = pool.get("a").unwrap();
        assert_eq!(server.consecutive_failures, 0);
        assert!(server.backoff_until_unix_ms.is_none());
    }

    #[test]
    fn current_pool_is_capped_at_pool_size_and_ranked_best_first() {
        let mut pool = ServerPool::new(2);
        pool.ingest_directory(&directory_with_peers(&[
            ("probation", ReputationTier::Probation),
            ("active", ReputationTier::Active),
            ("trusted", ReputationTier::Trusted),
        ]));
        let jitters = HashMap::new();
        let selected = pool.current_pool(0, &jitters);
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0], "trusted");
        assert_eq!(selected[1], "active");
    }

    #[test]
    fn withholding_strikes_reduce_a_servers_effective_rank() {
        let mut pool = ServerPool::new(1);
        pool.ingest_directory(&directory_with_peers(&[("a", ReputationTier::Trusted), ("b", ReputationTier::Trusted)]));
        for _ in 0..10 {
            pool.record_withholding_suspicion("a");
        }
        let jitters = HashMap::new();
        let selected = pool.current_pool(0, &jitters);
        assert_eq!(selected, vec!["b".to_string()]);
    }
}
