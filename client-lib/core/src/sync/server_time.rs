//! Parsing timestamps the *server* sends back (`reportedAt`/`expiresAt` in a
//! snapshot, `occurredAt` in a delta page) — as opposed to timestamps this
//! device signs itself (`crypto::envelope::is_fresh_timestamp`), which are
//! always proper RFC 3339 because this client wrote them.
//!
//! Confirmed against a real running server in
//! `client-lib/core/tests/multi_node.rs` (add-on B2): several of these
//! columns come straight off the database driver as its own default
//! `timestamptz` text output — e.g. `"2026-09-27 14:45:15.923718+00"` — not
//! the RFC 3339 the rest of the API documents and that every other signed
//! timestamp in this codebase uses (space instead of `T`, and a bare
//! two-digit UTC offset instead of `+00:00`). A client that only ever tries
//! [`chrono::DateTime::parse_from_rfc3339`] silently fails to parse every
//! such value — which is worse than it sounds here, because both call sites
//! ([`crate::sync::expiry::is_expired`] and
//! [`crate::sync::withholding::detects_withholding`]) treat an unparseable
//! timestamp as a safe default rather than an error, so the failure never
//! surfaces as anything a caller would notice: reports just silently read as
//! already-expired, and withholding detection silently never fires.
//!
//! This is a real server-side inconsistency (`server/docs/api.md` documents
//! RFC 3339 throughout) worth fixing at the source, but this client-lib
//! milestone doesn't touch server code (see `docs/status.md`'s B2 note) — so
//! until it is, every place that reads a server-emitted timestamp goes
//! through this instead of `parse_from_rfc3339` directly, accepting either
//! form.

/// The server-emitted timestamp as Unix milliseconds, or `None` if it
/// matches neither RFC 3339 nor the Postgres default `timestamptz` text
/// format.
pub fn parse_unix_ms(raw: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Some(dt.timestamp_millis());
    }
    chrono::DateTime::parse_from_rfc3339(&normalize_postgres_timestamptz(raw))
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// `"2026-09-27 14:45:15.923718+00"` -> `"2026-09-27T14:45:15.923718+00:00"`:
/// the space/'T' separator and the offset's missing minutes are the only two
/// ways this format actually differs from RFC 3339 — both fixed up literally
/// rather than parsed field-by-field, so this stays a thin compatibility
/// shim instead of a second date parser.
fn normalize_postgres_timestamptz(raw: &str) -> String {
    let with_t = raw.replacen(' ', "T", 1);
    match with_t.rfind(['+', '-']) {
        // The date portion's own hyphens sit before any space/'T', so the
        // *last* '+'/'-' is always the offset sign once one has been
        // inserted above — never a false match against "2026-09-27".
        Some(pos)
            if with_t.len() - pos == 3 && with_t[pos + 1..].bytes().all(|b| b.is_ascii_digit()) =>
        {
            format!("{with_t}:00")
        }
        _ => with_t,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proper_rfc3339() {
        let reference = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(parse_unix_ms("2026-01-01T00:00:00Z"), Some(reference));
        assert_eq!(
            parse_unix_ms("2026-01-01T00:00:00+02:00"),
            Some(reference - 2 * 60 * 60 * 1000)
        );
    }

    #[test]
    fn parses_the_real_postgres_timestamptz_default_format() {
        // The exact shape seen from a real server in multi_node.rs.
        assert_eq!(
            parse_unix_ms("2026-09-27 14:45:15.923718+00"),
            parse_unix_ms("2026-09-27T14:45:15.923718Z"),
        );
    }

    #[test]
    fn parses_a_non_utc_postgres_offset() {
        assert_eq!(
            parse_unix_ms("2026-01-01 00:00:00+02"),
            parse_unix_ms("2026-01-01T00:00:00+02:00"),
        );
        assert_eq!(
            parse_unix_ms("2026-01-01 00:00:00-05"),
            parse_unix_ms("2026-01-01T00:00:00-05:00"),
        );
    }

    #[test]
    fn parses_without_a_fractional_second() {
        assert_eq!(
            parse_unix_ms("2026-01-01 00:00:00+00"),
            parse_unix_ms("2026-01-01T00:00:00Z"),
        );
    }

    #[test]
    fn garbage_is_unparseable() {
        assert_eq!(parse_unix_ms("not-a-timestamp"), None);
        assert_eq!(parse_unix_ms(""), None);
    }
}
