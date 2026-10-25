// Makes context-sign-vectors.json: entries, queries and the answers `getContextSigns` must give.
//
// This is the INDEPENDENT REFERENCE of the rules in server/docs/context-signs.md D12 - plain JavaScript with its own geometry and
// its own reading of time zones (Intl, minute by minute), sharing no code with the Rust library. The library and the app run the
// JSON it writes. Run it with `node make-context-sign-vectors.mjs` (it rewrites the JSON next to it).
//
// Rules in short:
//  * space: the position is projected on the stretch; within 30 m it is ON it (half-open: [first vertex, last vertex)).
//    `startsInM` is minus the metres driven along the stretch in the direction of travel, `endsInM` the metres left.
//    Ahead: the first vertex (in travel direction) within `aheadM`, bearing from the position within 60 degrees of the heading, and the
//    stretch must run within 60 degrees of the heading there.
//  * direction: `along` needs a known heading within 60 degrees of the stretch's bearing at the position; `both` is read the way the
//    heading points (within 90 degrees of the stored order, else reversed); without a heading only `both` entries that contain
//    the position are delivered, in stored order, and nothing ahead.
//  * time: period (local dates, inclusive), then windows (local time, [from, to), over midnight belongs to the day it starts on).
//    `validUntil` = the next instant the state changes (null if none within 8 days; period edges count at any distance).
import { writeFileSync } from "node:fs";

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const haversine = (a, b) => {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const bearing = (a, b) => {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
};
const angle = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

// ---- time -------------------------------------------------------------------------------------------------------
const formatters = new Map();
function local(tz, ms) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }));
  }
  const parts = Object.fromEntries(formatters.get(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday };
}
const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
function covers(w, weekday, minutes) {
  const from = toMinutes(w.from);
  const to = toMinutes(w.to);
  const on = (d) => w.days.includes(d);
  if (from < to) return on(weekday) && minutes >= from && minutes < to;
  if (from > to) return (on(weekday) && minutes >= from) || (on(weekday === 1 ? 7 : weekday - 1) && minutes < to);
  return false;
}
function activeAt(validity, ms) {
  const l = local(validity.tz, ms);
  if (validity.period) {
    if (l.date < validity.period.from) return false;
    if (validity.period.to && l.date > validity.period.to) return false;
  }
  if (validity.windows?.length) return validity.windows.some((w) => covers(w, l.weekday, l.minutes));
  return true;
}
const MIN = 60_000;
function nextChange(validity, ms) {
  const state = activeAt(validity, ms);
  const start = Math.ceil((ms + 1) / MIN) * MIN;
  for (let t = start; t <= ms + 8 * 86_400_000; t += MIN) if (activeAt(validity, t) !== state) return t;
  if (validity.period) {
    for (let t = ms + 8 * 86_400_000; t <= ms + 400 * 86_400_000; t += 3_600_000) {
      if (activeAt(validity, t) !== state) {
        for (let m = t - 3_600_000; m <= t; m += MIN) if (activeAt(validity, m) !== state) return m;
      }
    }
  }
  return null;
}

// ---- space ------------------------------------------------------------------------------------------------------
function locate(geometry, [lng, lat]) {
  const mLat = 111194.9;
  const mLng = mLat * Math.cos(rad(lat));
  let cumulative = 0;
  let best = null;
  for (let i = 0; i + 1 < geometry.length; i++) {
    const a = geometry[i];
    const b = geometry[i + 1];
    const ax = (a[0] - lng) * mLng, ay = (a[1] - lat) * mLat, bx = (b[0] - lng) * mLng, by = (b[1] - lat) * mLat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
    const distance = Math.hypot(ax + t * dx, ay + t * dy);
    const segment = haversine(a, b);
    if (!best || distance < best.distance) best = { distance, along: cumulative + t * segment, bearing: bearing(a, b) };
    cumulative += segment;
  }
  return { ...best, length: cumulative };
}

function evaluate(entries, q) {
  const at = Date.parse(q.at);
  const ahead = q.aheadM ?? 1500;
  const heading = q.headingDeg ?? null;
  const out = [];
  for (const e of entries) {
    if (!["proposed", "confirmed"].includes(e.status)) continue;
    if (!e.confirmed && !q.includeUnconfirmed) continue;
    if (e.expiresAt && Date.parse(e.expiresAt) <= at) continue;
    const active = activeAt(e.validity, at);
    if (!active && !q.includeInactive) continue;
    const loc = locate(e.geometry, [q.lng, q.lat]);
    let placement = null;
    if (loc.distance <= 30) {
      let forward;
      if (e.direction === "along") {
        if (heading === null || angle(loc.bearing, heading) > 60) continue;
        forward = true;
      } else {
        forward = heading === null ? true : angle(loc.bearing, heading) <= 90;
      }
      const driven = forward ? loc.along : loc.length - loc.along;
      const remaining = loc.length - driven;
      if (remaining < 0.5) continue;
      placement = [-driven, remaining];
    } else if (heading !== null) {
      const first = e.geometry[0];
      const last = e.geometry.at(-1);
      const candidates = e.direction === "along" ? [[true, first]] : [[true, first], [false, last]];
      let best = null;
      for (const [forward, start] of candidates) {
        const distance = haversine([q.lng, q.lat], start);
        if (distance > ahead) continue;
        if (angle(bearing([q.lng, q.lat], start), heading) > 60) continue;
        const [a, b] = forward ? [e.geometry[0], e.geometry[1]] : [e.geometry.at(-1), e.geometry.at(-2)];
        if (angle(bearing(a, b), heading) > 60) continue;
        if (best === null || distance < best) best = distance;
      }
      if (best !== null) placement = [best, best + loc.length];
    }
    if (!placement) continue;
    const change = nextChange(e.validity, at);
    const iso = (t) => (t === null ? null : new Date(t).toISOString().replace(".000Z", "Z"));
    out.push({
      id: e.id,
      startsInM: Math.round(placement[0] * 10) / 10,
      endsInM: Math.round(placement[1] * 10) / 10,
      activeNow: active,
      validUntil: active ? iso(change) : null,
      nextActiveAt: active ? null : iso(change),
    });
  }
  out.sort((a, b) => a.startsInM - b.startsInM || (a.id < b.id ? -1 : 1));
  return out;
}

// ---- the world ---------------------------------------------------------------------------------------------------
const LAT = 50.0;
const road = (west, east) => [[west, LAT], [east, LAT]];
const base = (id, signType, geometry, extra = {}) => ({
  id,
  signType,
  geometry,
  direction: "both",
  validity: { v: 1, tz: "Europe/Berlin" },
  value: null,
  unit: null,
  lengthM: Math.round(haversine(geometry[0], geometry.at(-1)) * 10) / 10,
  status: "confirmed",
  confirmed: true,
  confirmations: 3,
  denials: 0,
  lastConfirmedAt: null,
  expiresAt: null,
  ...extra,
});

const entries = [
  base("e1-overtaking", "DE:276", road(10.0, 10.01), { direction: "along" }),
  base("e2-weekday-stop", "DE:283", road(10.004, 10.006), { validity: { v: 1, tz: "Europe/Berlin", windows: [{ days: [1, 2, 3, 4, 5], from: "07:00", to: "17:00" }] } }),
  base("e3-friday-night", "DE:277", road(10.012, 10.016), { direction: "along", validity: { v: 1, tz: "Europe/Berlin", windows: [{ days: [5], from: "22:00", to: "06:00" }] } }),
  base("e4-roadworks", "DE:123", road(10.002, 10.003), { validity: { v: 1, tz: "Europe/Berlin", period: { from: "2026-10-01", to: "2026-11-30" } } }),
  base("e5-unconfirmed", "DE:142-10", road(10.008, 10.009), { status: "proposed", confirmed: false, confirmations: 1 }),
  base("e6-expired", "DE:101-15", road(10.0, 10.001), { expiresAt: "2026-10-01T00:00:00Z" }),
  base("e7-disputed", "DE:101-14", road(10.0, 10.001), { status: "disputed", confirmed: false, confirmations: 1, denials: 2 }),
  base("e8-westbound", "DE:276", [[10.0105, LAT], [10.0095, LAT]], { direction: "along" }),
  base("e9-clock-back", "DE:283", road(10.0, 10.001), { validity: { v: 1, tz: "Europe/Berlin", windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: "01:30", to: "02:45" }] } }),
  base("e10-clock-forward", "DE:283", road(10.0, 10.001), { validity: { v: 1, tz: "Europe/Berlin", windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: "02:15", to: "03:30" }] } }),
  base("e11-until-revoked", "DE:101-52", road(10.018, 10.019), { validity: { v: 1, tz: "Europe/Berlin", period: { from: "2026-10-01", to: null } } }),
];

const m = 1 / (111194.9 * Math.cos(rad(LAT))); // degrees of longitude per metre at this latitude
const lng = (metresFromWest) => Math.round((10.0 + metresFromWest * m) * 1e7) / 1e7;
const q = (at, extra = {}) => ({ lat: LAT, lng: 10.0, at, ...extra });
const NOON = "2026-10-14T10:00:00Z"; // a Wednesday, 12:00 in Berlin (CEST)

const cases = [
  { name: "an empty stock gives an empty answer", use: [], query: q(NOON, { headingDeg: 90 }) },
  { name: "driving along a one-way stretch: it applies, the metres driven and left are told", use: ["e1-overtaking"], query: q(NOON, { lng: lng(200), headingDeg: 90 }) },
  { name: "driving the other way: a one-way sign does not apply", use: ["e1-overtaking"], query: q(NOON, { lng: lng(200), headingDeg: 270 }) },
  { name: "59 degrees off the stretch still applies", use: ["e1-overtaking"], query: q(NOON, { lng: lng(200), headingDeg: 149 }) },
  { name: "61 degrees off the stretch", use: ["e1-overtaking"], query: q(NOON, { lng: lng(200), headingDeg: 151 }) },
  { name: "unknown heading: a one-way sign is not delivered", use: ["e1-overtaking"], query: q(NOON, { lng: lng(200) }) },
  { name: "unknown heading: a both-way sign that contains the position is, in stored order", use: ["e1-overtaking", "e8-westbound", "e2-weekday-stop"], query: q(NOON, { lng: lng(350) }) },
  { name: "unknown heading: nothing ahead is told", use: ["e1-overtaking", "e2-weekday-stop"], query: q(NOON, { lng: lng(-100) }) },
  { name: "ahead: a stretch that starts 100 m in front", use: ["e1-overtaking"], query: q(NOON, { lng: lng(-100), headingDeg: 90 }) },
  { name: "ahead: farther than the look-ahead is not told", use: ["e1-overtaking"], query: q(NOON, { lng: lng(-600), headingDeg: 90, aheadM: 500 }) },
  { name: "ahead: within the default look-ahead of 1500 m", use: ["e1-overtaking"], query: q(NOON, { lng: lng(-1400), headingDeg: 90 }) },
  { name: "behind: the stretch is already passed", use: ["e1-overtaking"], query: q(NOON, { lng: lng(900), headingDeg: 90 }) },
  { name: "a stretch that ends exactly at the position is over", use: ["e1-overtaking"], query: q(NOON, { lng: 10.01, headingDeg: 90 }) },
  { name: "one metre before the end it still applies", use: ["e1-overtaking"], query: q(NOON, { lng: lng(714.2), headingDeg: 90 }) },
  { name: "at the very start it applies already (starts in 0)", use: ["e1-overtaking"], query: q(NOON, { lng: 10.0, headingDeg: 90 }) },
  { name: "beside the road (55 m) it does not count as on it", use: ["e1-overtaking"], query: { lat: LAT + 0.0005, lng: lng(200), at: NOON, headingDeg: 90 } },
  { name: "both ways: read in the direction of travel (east)", use: ["e2-weekday-stop"], query: q(NOON, { lng: lng(300), headingDeg: 90 }) },
  { name: "both ways: read in the direction of travel (west)", use: ["e2-weekday-stop"], query: q(NOON, { lng: lng(300), headingDeg: 270 }) },
  { name: "weekday window: inside it (Wednesday 12:00) it applies until 17:00 local", use: ["e2-weekday-stop"], query: q(NOON, { lng: lng(300), headingDeg: 90 }) },
  { name: "weekday window: at 16:59:30 local it still applies", use: ["e2-weekday-stop"], query: q("2026-10-14T14:59:30Z", { lng: lng(300), headingDeg: 90 }) },
  { name: "weekday window: at 17:00:00 local it is over", use: ["e2-weekday-stop"], query: q("2026-10-14T15:00:00Z", { lng: lng(300), headingDeg: 90 }) },
  { name: "weekday window: Saturday it is not delivered", use: ["e2-weekday-stop"], query: q("2026-10-17T10:00:00Z", { lng: lng(300), headingDeg: 90 }) },
  { name: "weekday window: Saturday, asked for inactive entries, it says when it next applies (Monday 07:00 local)", use: ["e2-weekday-stop"], query: q("2026-10-17T10:00:00Z", { lng: lng(300), headingDeg: 90, includeInactive: true }) },
  { name: "window over midnight (Friday 22:00-06:00): Friday 23:00 applies until Saturday 06:00 local", use: ["e3-friday-night"], query: q("2026-10-16T21:00:00Z", { lng: lng(1050), headingDeg: 90 }) },
  { name: "window over midnight: Saturday 05:00 local still belongs to Friday", use: ["e3-friday-night"], query: q("2026-10-17T03:00:00Z", { lng: lng(1050), headingDeg: 90 }) },
  { name: "window over midnight: Saturday 23:00 local does not (Saturday is not listed)", use: ["e3-friday-night"], query: q("2026-10-17T21:00:00Z", { lng: lng(1050), headingDeg: 90 }) },
  { name: "window over midnight: Friday 12:00 local is outside it", use: ["e3-friday-night"], query: q("2026-10-16T10:00:00Z", { lng: lng(1050), headingDeg: 90, includeInactive: true }) },
  { name: "period: roadworks inside the period apply until the end of the last day (local)", use: ["e4-roadworks"], query: q("2026-11-29T11:00:00Z", { lng: lng(180), headingDeg: 90 }) },
  { name: "period: the day after it ends it is over", use: ["e4-roadworks"], query: q("2026-12-01T11:00:00Z", { lng: lng(180), headingDeg: 90 }) },
  { name: "period: before it starts it says when it begins (midnight local)", use: ["e4-roadworks"], query: q("2026-09-30T11:00:00Z", { lng: lng(180), headingDeg: 90, includeInactive: true }) },
  { name: "until revoked: applies with no end", use: ["e11-until-revoked"], query: q(NOON, { lng: lng(1300), headingDeg: 90 }) },
  { name: "unconfirmed entries are left out", use: ["e5-unconfirmed"], query: q(NOON, { lng: lng(600), headingDeg: 90 }) },
  { name: "unconfirmed entries when asked for", use: ["e5-unconfirmed"], query: q(NOON, { lng: lng(600), headingDeg: 90, includeUnconfirmed: true }) },
  { name: "expired and disputed entries are never delivered", use: ["e6-expired", "e7-disputed"], query: q(NOON, { lng: lng(40), headingDeg: 90, includeUnconfirmed: true, includeInactive: true }) },
  { name: "opposite direction: the same road, a sign for the westbound lane", use: ["e1-overtaking", "e8-westbound"], query: q(NOON, { lng: lng(690), headingDeg: 270 }) },
  { name: "sorted by distance, nearest first", use: ["e1-overtaking", "e2-weekday-stop", "e4-roadworks", "e5-unconfirmed"], query: q(NOON, { lng: lng(-80), headingDeg: 90, includeUnconfirmed: true }) },
  { name: "clock change back (2026-10-25): 02:40 CEST is inside 01:30-02:45 and the window ends at the first 02:45", use: ["e9-clock-back"], query: q("2026-10-25T00:40:00Z", { lng: lng(40), headingDeg: 90 }) },
  { name: "clock change back: 02:50 CEST is outside, and at 02:00 CET (the hour repeats) it applies again", use: ["e9-clock-back"], query: q("2026-10-25T00:50:00Z", { lng: lng(40), headingDeg: 90, includeInactive: true }) },
  { name: "clock change back: 02:30 CET (second pass) applies until 02:45 CET", use: ["e9-clock-back"], query: q("2026-10-25T01:30:00Z", { lng: lng(40), headingDeg: 90 }) },
  { name: "clock change forward (2026-03-29): the window starting at the non-existent 02:15 begins when 03:00 CEST comes", use: ["e10-clock-forward"], query: q("2026-03-29T00:30:00Z", { lng: lng(40), headingDeg: 90, includeInactive: true }) },
  { name: "clock change forward: at 03:10 CEST it applies until 03:30 CEST", use: ["e10-clock-forward"], query: q("2026-03-29T01:10:00Z", { lng: lng(40), headingDeg: 90 }) },
  { name: "a look-ahead of zero still tells what applies here", use: ["e1-overtaking"], query: q("2026-10-14T10:00:00Z", { lng: lng(200), headingDeg: 90, aheadM: 0 }) },
];

const byId = new Map(entries.map((e) => [e.id, e]));
const out = {
  description:
    "Context-sign test vectors (server/docs/context-signs.md D12). Entries as the server delivers them, queries (position, heading, time, flags) and the answer getContextSigns must give. Made by make-context-sign-vectors.mjs, an independent JavaScript reference. Distances are compared within toleranceM; instants and flags exactly.",
  toleranceM: 1.5,
  entries,
  cases: cases.map((c) => ({ name: c.name, entries: c.use, query: c.query, expect: evaluate(c.use.map((id) => byId.get(id)), c.query) })),
};
writeFileSync(new URL("./context-sign-vectors.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`${out.cases.length} cases, ${out.cases.filter((c) => c.expect.length > 0).length} with signs`);
