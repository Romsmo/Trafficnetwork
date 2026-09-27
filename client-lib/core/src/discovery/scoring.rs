//! Server-selection score (F-C0 plan §1.2): reputation tier + measured
//! latency + recent error rate + a small random jitter. Deliberately *not*
//! based on anything a server claims about itself beyond its reputation
//! tier (which the server itself computes from signals *other* peers
//! measured, per `server/docs/federation-protocol.md` §4.3) — "closeness"
//! in particular is measured by this client's own round-trip time to
//! `GET /v1/network/node-info`, never read from the directory (which
//! carries no geo field at all).

use super::types::ReputationTier;

/// Latency above this is treated as "as bad as it gets" for scoring
/// purposes — avoids one very slow server producing an unbounded penalty
/// that swamps the other factors.
const LATENCY_SATURATION_MS: f64 = 3000.0;

#[derive(Debug, Clone, Copy)]
pub struct ScoreInputs {
    pub tier: ReputationTier,
    /// Exponentially-weighted moving average of recent round-trip times, or
    /// `None` if this server has never successfully responded yet.
    pub latency_ema_ms: Option<f64>,
    /// Fraction of recent attempts that failed, `0.0..=1.0`.
    pub error_rate: f64,
    /// `0.0..=1.0`, regenerated periodically by the pool (not per score
    /// calculation) — breaks ties between otherwise-similar servers so
    /// load/observability spreads across more than just "the one best
    /// server", per the privacy-spreading goal in `docs/federation.md`.
    pub jitter: f64,
}

/// Higher is better. Not calibrated to any particular unit — only
/// meaningful for ranking servers against each other.
pub fn score(inputs: &ScoreInputs) -> f64 {
    let reputation = inputs.tier.base_weight();

    // No measurement yet is treated as a moderate (not maximal) penalty —
    // an unmeasured server should get a chance to be tried, but a proven
    // fast one should still usually rank higher than a complete unknown.
    let latency_ms = inputs
        .latency_ema_ms
        .unwrap_or(LATENCY_SATURATION_MS / 2.0)
        .min(LATENCY_SATURATION_MS);
    let latency_penalty = (latency_ms / LATENCY_SATURATION_MS) * reputation_scale(reputation);

    let error_penalty = inputs.error_rate.clamp(0.0, 1.0) * reputation_scale(reputation) * 2.0;

    reputation - latency_penalty - error_penalty + inputs.jitter
}

/// Scales latency/error penalties relative to the reputation weight in play
/// so a `trusted` server's occasional slow response doesn't outweigh its
/// tier the way the same absolute penalty would for a `probation` server —
/// penalties are proportional, not a fixed subtraction.
fn reputation_scale(reputation_weight: f64) -> f64 {
    reputation_weight * 0.3
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(tier: ReputationTier, latency_ms: Option<f64>, error_rate: f64) -> ScoreInputs {
        ScoreInputs {
            tier,
            latency_ema_ms: latency_ms,
            error_rate,
            jitter: 0.0,
        }
    }

    #[test]
    fn trusted_beats_active_beats_probation_at_equal_latency_and_error_rate() {
        let trusted = score(&inputs(ReputationTier::Trusted, Some(50.0), 0.0));
        let active = score(&inputs(ReputationTier::Active, Some(50.0), 0.0));
        let probation = score(&inputs(ReputationTier::Probation, Some(50.0), 0.0));
        assert!(trusted > active);
        assert!(active > probation);
    }

    #[test]
    fn lower_latency_scores_higher_at_the_same_tier() {
        let fast = score(&inputs(ReputationTier::Active, Some(20.0), 0.0));
        let slow = score(&inputs(ReputationTier::Active, Some(2000.0), 0.0));
        assert!(fast > slow);
    }

    #[test]
    fn higher_error_rate_scores_lower_at_the_same_tier_and_latency() {
        let reliable = score(&inputs(ReputationTier::Active, Some(100.0), 0.0));
        let flaky = score(&inputs(ReputationTier::Active, Some(100.0), 0.5));
        assert!(reliable > flaky);
    }

    #[test]
    fn an_unmeasured_server_is_not_penalized_as_harshly_as_a_confirmed_slow_one() {
        let unmeasured = score(&inputs(ReputationTier::Active, None, 0.0));
        let confirmed_slow = score(&inputs(
            ReputationTier::Active,
            Some(LATENCY_SATURATION_MS),
            0.0,
        ));
        assert!(unmeasured > confirmed_slow);
    }

    #[test]
    fn probation_server_is_never_scored_below_zero_by_latency_alone_at_zero_error_rate() {
        // Discoverable, not unusable — matches the server directory's own
        // "capped share, not hidden" design for probation-tier peers.
        let worst_case = score(&inputs(
            ReputationTier::Probation,
            Some(LATENCY_SATURATION_MS),
            0.0,
        ));
        assert!(worst_case > 0.0);
    }
}
