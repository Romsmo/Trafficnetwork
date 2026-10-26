//! Which context signs apply here and just ahead — evaluated locally and offline (server 1.4.0, `server/docs/context-signs.md` D12).
//!
//! Input: the entries the device holds (`sync::context_signs`), a position, a heading, a time. Output: the entries that apply now
//! at the position or begin within the look-ahead, nearest first, each with the metres to its start and end and the instant its
//! validity ends. Nothing here touches a network or a store; the rules are fixed by `fixtures/context-sign-vectors.json`, which
//! the app runs too.
//!
//! * **Space.** The position is projected onto the stretch (nearest segment). It is *on* the stretch within [`ON_ROAD_METERS`];
//!   the stretch is half-open: it applies from its first vertex (`startsInM <= 0`) up to, but not including, its last.
//! * **Direction.** The heading is compared with the bearing of the stretch where the position is. A sign that applies one way
//!   (`along`) is delivered within [`ALONG_TOLERANCE_DEG`] of the stretch's bearing; one that applies both ways is read in the
//!   direction of travel. **Unknown heading:** only both-way entries that contain the position are delivered (read in the stored
//!   order), one-way entries are not, and nothing "ahead" is told.
//! * **Time.** The validity (period, then weekday/time windows) is read in the entry's own time zone, so a rule means the same
//!   after the clock changes. A window that crosses midnight belongs to the day it starts on.

use std::collections::BTreeSet;

use chrono::{
    DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike, Utc,
};
use chrono_tz::Tz;
use serde::Serialize;

use super::context_signs::{ContextSignEntry, Direction, TimeWindow, Validity};
use super::matching::haversine_distance_meters;

/// A position this close to a stretch is on it (GPS error).
pub const ON_ROAD_METERS: f64 = 30.0;
/// A one-way sign applies to a heading within this many degrees of the stretch's bearing; the start of a stretch is "ahead"
/// when it lies within this many degrees of the heading.
pub const ALONG_TOLERANCE_DEG: f64 = 60.0;
/// How far ahead an inactive entry's next start is looked for (days).
const HORIZON_DAYS: i64 = 8;
/// The look-ahead used when the caller names none.
pub const DEFAULT_AHEAD_METERS: f64 = 1500.0;
pub const MAX_AHEAD_METERS: f64 = 10_000.0;

#[derive(Debug, Clone, PartialEq)]
pub struct ContextSignQuery {
    pub lat: f64,
    pub lng: f64,
    /// Compass heading in degrees (0 = north), if known.
    pub heading_deg: Option<f64>,
    pub ahead_m: f64,
    pub at_unix_ms: i64,
    pub include_unconfirmed: bool,
    pub include_inactive: bool,
}

/// One sign that applies here or begins ahead.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSign {
    pub id: String,
    pub sign_type: String,
    pub value: Option<f64>,
    pub unit: Option<String>,
    /// Metres to where it starts, along the direction of travel. `<= 0`: it applies already (minus the metres driven along it).
    pub starts_in_m: f64,
    /// Metres to where it ends. `null`: unknown or open (not used by this version: every stretch has an end).
    pub ends_in_m: Option<f64>,
    /// The instant (RFC 3339, UTC) its current validity ends; `null`: no end (always, or "until revoked").
    pub valid_until: Option<String>,
    /// For an entry that does not apply now (only with `includeInactive`): when it next does, within eight days.
    pub next_active_at: Option<String>,
    pub active_now: bool,
    pub confirmed: bool,
    pub confirmations: u32,
    pub direction: Direction,
    pub length_m: f64,
}

// ---------------------------------------------------------------- geometry

fn bearing_deg(from: (f64, f64), to: (f64, f64)) -> f64 {
    // (lat, lng)
    let (lat1, lat2) = (from.0.to_radians(), to.0.to_radians());
    let dlng = (to.1 - from.1).to_radians();
    let y = dlng.sin() * lat2.cos();
    let x = lat1.cos() * lat2.sin() - lat1.sin() * lat2.cos() * dlng.cos();
    (y.atan2(x).to_degrees() + 360.0) % 360.0
}

fn angle_diff(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 {
        360.0 - d
    } else {
        d
    }
}

struct Located {
    /// Distance from the position to the stretch (m).
    distance_m: f64,
    /// Metres along the stretch, from its first vertex, at the foot of the perpendicular.
    along_m: f64,
    /// Bearing of the segment the position projects onto.
    bearing: f64,
}

/// Cumulative lengths of the vertices (lat/lng order of `geometry` is [lng, lat]).
fn cumulative(geometry: &[[f64; 2]]) -> Vec<f64> {
    let mut out = Vec::with_capacity(geometry.len());
    let mut total = 0.0;
    out.push(0.0);
    for pair in geometry.windows(2) {
        total += haversine_distance_meters(pair[0][1], pair[0][0], pair[1][1], pair[1][0]);
        out.push(total);
    }
    out
}

fn locate(geometry: &[[f64; 2]], cumulative: &[f64], lat: f64, lng: f64) -> Option<Located> {
    let k = lat.to_radians().cos();
    let m_per_deg_lat = 111_194.9;
    let m_per_deg_lng = m_per_deg_lat * k;
    let mut best: Option<Located> = None;
    for (i, pair) in geometry.windows(2).enumerate() {
        let ax = (pair[0][0] - lng) * m_per_deg_lng;
        let ay = (pair[0][1] - lat) * m_per_deg_lat;
        let bx = (pair[1][0] - lng) * m_per_deg_lng;
        let by = (pair[1][1] - lat) * m_per_deg_lat;
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = dx * dx + dy * dy;
        let t = if len2 == 0.0 {
            0.0
        } else {
            (-(ax * dx + ay * dy) / len2).clamp(0.0, 1.0)
        };
        let distance = (ax + t * dx).hypot(ay + t * dy);
        if best.as_ref().is_none_or(|b| distance < b.distance_m) {
            let segment = cumulative[i + 1] - cumulative[i];
            best = Some(Located {
                distance_m: distance,
                along_m: cumulative[i] + t * segment,
                bearing: bearing_deg((pair[0][1], pair[0][0]), (pair[1][1], pair[1][0])),
            });
        }
    }
    best
}

// ---------------------------------------------------------------- time

fn parse_time(text: &str) -> Option<u32> {
    let (h, m) = text.split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

fn parse_date(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()
}

fn window_covers(window: &TimeWindow, weekday: u32, minutes: u32) -> bool {
    let (Some(from), Some(to)) = (parse_time(&window.from), parse_time(&window.to)) else {
        return false;
    };
    let on = |day: u32| window.days.iter().any(|d| u32::from(*d) == day);
    if from < to {
        on(weekday) && minutes >= from && minutes < to
    } else if from > to {
        // over midnight: the evening of a listed day, and the morning after it
        let previous = if weekday == 1 { 7 } else { weekday - 1 };
        (on(weekday) && minutes >= from) || (on(previous) && minutes < to)
    } else {
        false
    }
}

/// Is the validity in force at this instant?
fn active_at(validity: &Validity, tz: Tz, instant: DateTime<Utc>) -> bool {
    let local = instant.with_timezone(&tz);
    if let Some(period) = &validity.period {
        let date = local.date_naive();
        match parse_date(&period.from) {
            Some(from) if date >= from => {}
            _ => return false,
        }
        if let Some(to) = &period.to {
            match parse_date(to) {
                Some(to) if date <= to => {}
                _ => return false,
            }
        }
    }
    match &validity.windows {
        Some(windows) if !windows.is_empty() => {
            let minutes = local.hour() * 60 + local.minute();
            windows
                .iter()
                .any(|w| window_covers(w, local.weekday().number_from_monday(), minutes))
        }
        _ => true,
    }
}

/// A local wall-clock time as instants: both of them if it happens twice, the first existing minute if it does not happen
/// (the hour that is skipped when the clock moves forward).
fn local_to_utc(tz: Tz, naive: NaiveDateTime) -> Vec<DateTime<Utc>> {
    for extra in 0..=120 {
        let result = tz.from_local_datetime(&(naive + Duration::minutes(extra)));
        // (an hour that happens twice names two instants, and the state can flip at either)
        let found: Vec<DateTime<Utc>> = [result.earliest(), result.latest()]
            .into_iter()
            .flatten()
            .map(|l| l.with_timezone(&Utc))
            .collect();
        if !found.is_empty() {
            return found;
        }
    }
    Vec::new()
}

fn offset_seconds(tz: Tz, instant: DateTime<Utc>) -> i32 {
    use chrono::Offset;
    tz.offset_from_utc_datetime(&instant.naive_utc())
        .fix()
        .local_minus_utc()
}

/// Instants at which the validity may change, from yesterday on for the horizon, plus the edges of the period.
fn boundaries(validity: &Validity, tz: Tz, from: DateTime<Utc>) -> BTreeSet<DateTime<Utc>> {
    let mut out = BTreeSet::new();
    let today = from.with_timezone(&tz).date_naive();
    if let Some(windows) = &validity.windows {
        for offset in -1..=HORIZON_DAYS + 1 {
            let date = today + Duration::days(offset);
            for w in windows {
                for text in [&w.from, &w.to] {
                    if let Some(minutes) = parse_time(text) {
                        let naive = date.and_time(
                            NaiveTime::from_hms_opt(minutes / 60, minutes % 60, 0)
                                .unwrap_or_default(),
                        );
                        out.extend(local_to_utc(tz, naive));
                    }
                }
            }
        }
    }
    // the clock changes: the wall-clock rules above do not name these instants, but the state can flip there (an hour that repeats)
    let horizon = from + Duration::days(HORIZON_DAYS);
    let mut hour = from;
    while hour < horizon {
        let next = hour + Duration::hours(1);
        if offset_seconds(tz, hour) != offset_seconds(tz, next) {
            let mut minute = hour;
            while minute < next {
                minute += Duration::minutes(1);
                if offset_seconds(tz, minute) != offset_seconds(tz, hour) {
                    out.insert(minute);
                    break;
                }
            }
        }
        hour = next;
    }
    if let Some(period) = &validity.period {
        if let Some(start) = parse_date(&period.from) {
            out.extend(local_to_utc(tz, start.and_time(NaiveTime::MIN)));
        }
        if let Some(end) = period.to.as_deref().and_then(parse_date) {
            out.extend(local_to_utc(
                tz,
                (end + Duration::days(1)).and_time(NaiveTime::MIN),
            ));
        }
    }
    out
}

/// What the validity says at `at`: whether it is in force, and the next instant that flips that (within the horizon).
pub struct Activity {
    pub active_now: bool,
    pub next_change: Option<DateTime<Utc>>,
}

pub fn activity(validity: &Validity, at: DateTime<Utc>) -> Option<Activity> {
    let tz: Tz = validity.tz.parse().ok()?;
    let active_now = active_at(validity, tz, at);
    let horizon = at + Duration::days(HORIZON_DAYS);
    let has_period = validity.period.is_some();
    let next_change = boundaries(validity, tz, at)
        .into_iter()
        .filter(|b| *b > at && (has_period || *b <= horizon))
        .find(|b| active_at(validity, tz, *b) != active_now);
    Some(Activity {
        active_now,
        next_change,
    })
}

fn rfc3339(instant: DateTime<Utc>) -> String {
    instant.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---------------------------------------------------------------- evaluation

fn round_m(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// The signs of `entries` that apply at the query's position and time or begin within its look-ahead, nearest first.
pub fn evaluate(entries: &[ContextSignEntry], query: &ContextSignQuery) -> Vec<ContextSign> {
    let Some(at) = DateTime::from_timestamp_millis(query.at_unix_ms) else {
        return Vec::new();
    };
    let ahead = if query.ahead_m.is_finite() {
        query.ahead_m.clamp(0.0, MAX_AHEAD_METERS)
    } else {
        DEFAULT_AHEAD_METERS
    };
    let heading = query
        .heading_deg
        .filter(|h| h.is_finite())
        .map(|h| h.rem_euclid(360.0));
    let mut out = Vec::new();

    for entry in entries {
        if entry.geometry.len() < 2 || !(entry.status == "proposed" || entry.status == "confirmed")
        {
            continue;
        }
        if !entry.confirmed && !query.include_unconfirmed {
            continue;
        }
        if let Some(expires) = entry
            .expires_at
            .as_deref()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        {
            if expires.with_timezone(&Utc) <= at {
                continue;
            }
        }
        let Some(act) = activity(&entry.validity, at) else {
            continue;
        };
        if !act.active_now && !query.include_inactive {
            continue;
        }

        let geometry = &entry.geometry;
        let cumulative = cumulative(geometry);
        let length = *cumulative.last().unwrap_or(&0.0);
        let Some(located) = locate(geometry, &cumulative, query.lat, query.lng) else {
            continue;
        };

        // (starts, ends) in the direction of travel
        let placement = if located.distance_m <= ON_ROAD_METERS {
            on_stretch(entry.direction, heading, &located, length)
        } else {
            heading.and_then(|h| ahead_of(entry.direction, h, geometry, length, query, ahead))
        };
        let Some((starts, ends)) = placement else {
            continue;
        };

        out.push(ContextSign {
            id: entry.id.clone(),
            sign_type: entry.sign_type.clone(),
            value: entry.value,
            unit: entry.unit.clone(),
            starts_in_m: round_m(starts),
            ends_in_m: Some(round_m(ends)),
            valid_until: if act.active_now {
                act.next_change.map(rfc3339)
            } else {
                None
            },
            next_active_at: if act.active_now {
                None
            } else {
                act.next_change.map(rfc3339)
            },
            active_now: act.active_now,
            confirmed: entry.confirmed,
            confirmations: entry.confirmations,
            direction: entry.direction,
            length_m: round_m(length),
        });
    }
    out.sort_by(|a, b| {
        a.starts_in_m
            .partial_cmp(&b.starts_in_m)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

/// The position is on the stretch: where it is in the direction of travel, or `None` when the sign does not apply to this heading.
fn on_stretch(
    direction: Direction,
    heading: Option<f64>,
    located: &Located,
    length: f64,
) -> Option<(f64, f64)> {
    let forward = match (direction, heading) {
        (Direction::Along, Some(h)) => {
            if angle_diff(located.bearing, h) > ALONG_TOLERANCE_DEG {
                return None;
            }
            true
        }
        (Direction::Along, None) => return None,
        (Direction::Both, Some(h)) => angle_diff(located.bearing, h) <= 90.0,
        (Direction::Both, None) => true,
    };
    let driven = if forward {
        located.along_m
    } else {
        length - located.along_m
    };
    let remaining = length - driven;
    // half-open: a position at the very end is past the stretch
    if remaining < 0.5 {
        return None;
    }
    Some((-driven, remaining))
}

/// The stretch lies ahead: its first vertex (in the direction of travel) within the look-ahead and in front of the heading.
fn ahead_of(
    direction: Direction,
    heading: f64,
    geometry: &[[f64; 2]],
    length: f64,
    query: &ContextSignQuery,
    ahead: f64,
) -> Option<(f64, f64)> {
    let first = geometry[0];
    let last = geometry[geometry.len() - 1];
    let candidates: &[(bool, [f64; 2])] = match direction {
        Direction::Along => &[(true, first)],
        Direction::Both => &[(true, first), (false, last)],
    };
    let mut best: Option<f64> = None;
    for (forward, start) in candidates {
        let distance = haversine_distance_meters(query.lat, query.lng, start[1], start[0]);
        if distance > ahead {
            continue;
        }
        let to_start = bearing_deg((query.lat, query.lng), (start[1], start[0]));
        if angle_diff(to_start, heading) > ALONG_TOLERANCE_DEG {
            continue;
        }
        // the stretch must also run the way the driver is going when it starts
        let (a, b) = if *forward {
            (geometry[0], geometry[1])
        } else {
            (geometry[geometry.len() - 1], geometry[geometry.len() - 2])
        };
        let run = bearing_deg((a[1], a[0]), (b[1], b[0]));
        if angle_diff(run, heading) > ALONG_TOLERANCE_DEG {
            continue;
        }
        if best.is_none_or(|d| distance < d) {
            best = Some(distance);
        }
    }
    best.map(|distance| (distance, distance + length))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const VECTORS: &str = include_str!("../../../fixtures/context-sign-vectors.json");

    fn at(text: &str) -> i64 {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .timestamp_millis()
    }

    /// The shared vectors (`client-lib/fixtures/context-sign-vectors.json`, made by an independent JavaScript reference): every
    /// case, position and time, must come out the same - the app runs the same file.
    #[test]
    fn the_shared_vectors_all_hold() {
        let vectors: Value = serde_json::from_str(VECTORS).unwrap();
        let tolerance = vectors["toleranceM"].as_f64().unwrap();
        let entries: Vec<ContextSignEntry> =
            serde_json::from_value(vectors["entries"].clone()).unwrap();
        let cases = vectors["cases"].as_array().unwrap();
        assert!(cases.len() >= 40);
        let mut with_signs = 0;
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let used: Vec<ContextSignEntry> = case["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| {
                    entries
                        .iter()
                        .find(|e| e.id == id.as_str().unwrap())
                        .unwrap()
                        .clone()
                })
                .collect();
            let q = &case["query"];
            let query = ContextSignQuery {
                lat: q["lat"].as_f64().unwrap(),
                lng: q["lng"].as_f64().unwrap(),
                heading_deg: q["headingDeg"].as_f64(),
                ahead_m: q["aheadM"].as_f64().unwrap_or(DEFAULT_AHEAD_METERS),
                at_unix_ms: at(q["at"].as_str().unwrap()),
                include_unconfirmed: q["includeUnconfirmed"].as_bool().unwrap_or(false),
                include_inactive: q["includeInactive"].as_bool().unwrap_or(false),
            };
            let got = evaluate(&used, &query);
            let expect = case["expect"].as_array().unwrap();
            assert_eq!(
                got.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
                expect
                    .iter()
                    .map(|e| e["id"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                "{name}: which signs"
            );
            for (g, e) in got.iter().zip(expect) {
                with_signs += 1;
                assert!(
                    (g.starts_in_m - e["startsInM"].as_f64().unwrap()).abs() <= tolerance,
                    "{name}: startsInM {} vs {}",
                    g.starts_in_m,
                    e["startsInM"]
                );
                assert!(
                    (g.ends_in_m.unwrap() - e["endsInM"].as_f64().unwrap()).abs() <= tolerance,
                    "{name}: endsInM {:?} vs {}",
                    g.ends_in_m,
                    e["endsInM"]
                );
                assert_eq!(
                    g.active_now,
                    e["activeNow"].as_bool().unwrap(),
                    "{name}: activeNow"
                );
                assert_eq!(
                    g.valid_until.as_deref(),
                    e["validUntil"].as_str(),
                    "{name}: validUntil"
                );
                assert_eq!(
                    g.next_active_at.as_deref(),
                    e["nextActiveAt"].as_str(),
                    "{name}: nextActiveAt"
                );
            }
        }
        assert!(with_signs >= 25);
    }

    #[test]
    fn an_unknown_time_zone_or_a_broken_time_never_panics() {
        let vectors: Value = serde_json::from_str(VECTORS).unwrap();
        let mut entries: Vec<ContextSignEntry> =
            serde_json::from_value(vectors["entries"].clone()).unwrap();
        entries[0].validity.tz = "Mars/Olympus".to_string();
        entries[1].validity.windows = Some(vec![TimeWindow {
            days: vec![1],
            from: "25:99".to_string(),
            to: "x".to_string(),
        }]);
        let query = ContextSignQuery {
            lat: 50.0,
            lng: 10.003,
            heading_deg: Some(90.0),
            ahead_m: 1500.0,
            at_unix_ms: at("2026-10-14T10:00:00Z"),
            include_unconfirmed: true,
            include_inactive: true,
        };
        let got = evaluate(&entries, &query);
        assert!(
            got.iter().all(|s| s.id != entries[0].id),
            "an entry in an unknown zone is left out"
        );
        for time in [i64::MIN, i64::MAX, 0] {
            let _ = evaluate(
                &entries,
                &ContextSignQuery {
                    at_unix_ms: time,
                    ..query.clone()
                },
            );
        }
        let nan = ContextSignQuery {
            lat: f64::NAN,
            lng: f64::NAN,
            heading_deg: Some(f64::NAN),
            ahead_m: f64::NAN,
            ..query
        };
        let _ = evaluate(&entries, &nan);
    }

    #[test]
    fn an_entry_that_expired_on_the_server_is_not_delivered() {
        let vectors: Value = serde_json::from_str(VECTORS).unwrap();
        let mut entries: Vec<ContextSignEntry> =
            serde_json::from_value(vectors["entries"].clone()).unwrap();
        entries.retain(|e| e.id == "e1-overtaking");
        let query = ContextSignQuery {
            lat: 50.0,
            lng: 10.003,
            heading_deg: Some(90.0),
            ahead_m: 1500.0,
            at_unix_ms: at("2026-10-14T10:00:00Z"),
            include_unconfirmed: false,
            include_inactive: false,
        };
        assert_eq!(evaluate(&entries, &query).len(), 1);
        entries[0].expires_at = Some("2026-10-14T09:59:59Z".to_string());
        assert!(evaluate(&entries, &query).is_empty());
    }
}
