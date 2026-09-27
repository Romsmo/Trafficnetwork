//! Client-local withholding detection (F-C0 plan §1.5) — server-side
//! anti-entropy has no equivalent check
//! (`server/docs/federation-protocol.md` §7 lists withholding detection as
//! explicitly out of scope for the server), so this is purely a client
//! self-protection heuristic: occasionally cross-check a primary server's
//! delta answer against a second pool server for the identical `since`
//! query, and treat events the second server had that the primary silently
//! omitted as a reputation malus on the primary
//! (`discovery::pool::KnownServer::withholding_strikes`) — never shared
//! with anyone else, never a network-wide judgment.

use crate::discovery::{DiscoveryError, DiscoveryService, KnownServer};
use crate::platform::HttpRequest;

use super::types::{DeltaPage, EventLogEntry};

/// F-C0 plan §1.5: "mit niedriger Wahrscheinlichkeit ... Standard 10%".
pub const DEFAULT_SAMPLE_RATE: f64 = 0.1;

/// Events at least this old (`occurredAt` vs. now) that a second server had
/// but the primary's answer omitted count as a withholding signal — recent
/// events can legitimately differ by a few seconds of replication lag, so
/// this is a tolerance window, not zero (F-C0 plan §1.5: "älter als ein
/// Toleranzfenster, z. B. 5 Minuten").
pub const TOLERANCE_WINDOW_MS: i64 = 5 * 60 * 1000;

/// `true` roughly `sample_rate` of the time. `roll` is caller-supplied
/// (`0.0..=1.0`) rather than read internally — same "inject randomness,
/// don't hide it" convention as `discovery::scoring`'s jitter — so this
/// stays unit-testable without mocking a global RNG.
pub fn should_sample(roll: f64, sample_rate: f64) -> bool {
    roll < sample_rate
}

fn is_older_than_tolerance(event: &EventLogEntry, now_unix_ms: i64) -> bool {
    match super::server_time::parse_unix_ms(&event.occurred_at) {
        Some(ms) => now_unix_ms - ms > TOLERANCE_WINDOW_MS,
        // Can't tell how old it is — treat as not old enough to count,
        // rather than false-flagging a healthy server over a parse edge case.
        None => false,
    }
}

/// `true` if `secondary_page` contains an event — older than
/// [`TOLERANCE_WINDOW_MS`] — that `primary_page` didn't include at all.
pub fn detects_withholding(
    primary_page: &DeltaPage,
    secondary_page: &DeltaPage,
    now_unix_ms: i64,
) -> bool {
    let primary_sequences: std::collections::HashSet<u64> =
        primary_page.events.iter().map(|e| e.sequence).collect();
    secondary_page.events.iter().any(|event| {
        !primary_sequences.contains(&event.sequence) && is_older_than_tolerance(event, now_unix_ms)
    })
}

/// Fetches the identical `since` query from a second pool server (any
/// server other than `primary`) and, if it reveals an omission, records a
/// withholding strike against `primary`. `Ok(false)` covers every case
/// where nothing could be concluded either way: no second server to
/// cross-check against (a pool of one can't sample anything), the
/// secondary itself unreachable this cycle, or an unparseable response —
/// none of that is evidence the primary withheld anything.
pub async fn sample_check(
    discovery: &DiscoveryService,
    primary: &KnownServer,
    primary_page: &DeltaPage,
    since: u64,
    tiles: &[String],
    bearer_token: &str,
    now_unix_ms: i64,
) -> Result<bool, DiscoveryError> {
    let secondary = discovery
        .current_pool()
        .into_iter()
        .find(|s| s.node_id != primary.node_id);
    let secondary = match secondary {
        Some(s) => s,
        None => return Ok(false),
    };

    let mut url = format!(
        "{}/v1/delta?since={since}&limit=500",
        secondary.address.trim_end_matches('/')
    );
    if !tiles.is_empty() {
        url.push_str("&tiles=");
        url.push_str(&tiles.join(","));
    }
    let request =
        HttpRequest::get(url).with_header("Authorization", format!("Bearer {bearer_token}"));
    let response = match discovery.request_to_server(&secondary, request).await {
        Ok(r) if r.is_success() => r,
        _ => return Ok(false),
    };
    let parsed = response
        .json()
        .ok()
        .and_then(|v| serde_json::from_value::<DeltaPage>(v).ok());
    let secondary_page = match parsed {
        Some(p) => p,
        None => return Ok(false),
    };

    let withheld = detects_withholding(primary_page, &secondary_page, now_unix_ms);
    if withheld {
        discovery.record_withholding_suspicion(&primary.node_id);
    }
    Ok(withheld)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(sequence: u64, occurred_at: &str) -> EventLogEntry {
        EventLogEntry {
            sequence,
            occurred_at: occurred_at.to_string(),
            event_type: "ReportCreated".to_string(),
            entity_type: "hazardReport".to_string(),
            entity_id: format!("hr{sequence}"),
            payload: serde_json::json!({}),
            region_tile: Some("tile1".to_string()),
            source: "community".to_string(),
        }
    }

    fn now() -> i64 {
        chrono::DateTime::parse_from_rfc3339("2026-01-01T01:00:00Z")
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn should_sample_rolls_below_the_rate() {
        assert!(should_sample(0.05, 0.1));
        assert!(!should_sample(0.5, 0.1));
    }

    #[test]
    fn detects_an_old_event_the_primary_silently_omitted() {
        let primary = DeltaPage {
            events: vec![event(1, "2026-01-01T00:59:00Z")],
            next_since: Some(2),
            has_more: false,
        };
        let secondary = DeltaPage {
            events: vec![
                event(1, "2026-01-01T00:59:00Z"),
                event(2, "2026-01-01T00:00:00Z"),
            ],
            next_since: Some(3),
            has_more: false,
        };
        assert!(detects_withholding(&primary, &secondary, now()));
    }

    #[test]
    fn does_not_flag_a_recent_event_still_within_the_tolerance_window() {
        let primary = DeltaPage {
            events: vec![],
            next_since: Some(1),
            has_more: false,
        };
        let secondary = DeltaPage {
            events: vec![event(1, "2026-01-01T00:59:50Z")],
            next_since: Some(2),
            has_more: false,
        };
        assert!(!detects_withholding(&primary, &secondary, now()));
    }

    #[test]
    fn does_not_flag_when_both_pages_agree() {
        let page = DeltaPage {
            events: vec![event(1, "2026-01-01T00:00:00Z")],
            next_since: Some(2),
            has_more: false,
        };
        assert!(!detects_withholding(&page, &page, now()));
    }
}
