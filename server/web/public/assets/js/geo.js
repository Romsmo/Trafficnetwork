/**
 * Small geometry helpers for the location arrow and the speed-limit lookup. Pure functions on {lat, lng} / [lng, lat] — no
 * Leaflet, no DOM — so they can be tested in Node.
 */
const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg) => (deg * Math.PI) / 180;
const deg = (radians) => (radians * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distanceMeters(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b in degrees, 0 = north, clockwise, [0, 360). */
export function bearingDegrees(a, b) {
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest signed difference from `from` to `to` in degrees, (-180, 180]. */
export function angleDelta(from, to) {
  let d = ((to - from) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** Moves `previous` towards `next` by `alpha` (0..1) along the shorter way round: a heading that does not jitter. */
export function smoothHeading(previous, next, alpha = 0.5) {
  if (previous === null || previous === undefined) return next;
  return (previous + angleDelta(previous, next) * alpha + 360) % 360;
}

/**
 * The direction of travel for a new position fix.
 * 1. the device's own heading, when it gives one (the browser reports `null`, or NaN while standing still, and omits it on desktops),
 * 2. otherwise the direction from the previous fix, when it moved more than `minMeters` — GPS noise while standing still must not
 *    spin the arrow,
 * 3. otherwise the heading we already had (the arrow keeps pointing where the last movement went), or null if there never was one.
 * `fix`: { lat, lng, heading?, speed? }; `previous`: the fix before it (or null); `current`: the heading shown so far (or null).
 */
export function nextHeading({ fix, previous, current, minMeters = 6 }) {
  const own = fix.heading;
  const standingStill = typeof fix.speed === "number" && Number.isFinite(fix.speed) && fix.speed < 0.5;
  if (typeof own === "number" && Number.isFinite(own) && !standingStill) return smoothHeading(current, ((own % 360) + 360) % 360, 0.6);
  if (previous && distanceMeters(previous, fix) >= minMeters) return smoothHeading(current, bearingDegrees(previous, fix), 0.6);
  return current ?? null;
}

/**
 * The "centre on me" button: off -> centred (the arrow is shown, the map moved there once) -> following (the map keeps the arrow in
 * view) -> off. Panning the map yourself drops "following" back to "centred"; losing the permission switches everything off.
 */
export function nextLocateState(state, event) {
  switch (event) {
    case "press":
      return state === "off" ? "centered" : state === "centered" ? "following" : "off";
    case "drag":
      return state === "following" ? "centered" : state;
    case "error":
      return "off";
    default:
      return state;
  }
}

/** Metres per screen pixel of a Web-Mercator map at `zoom` and latitude (256 px tiles). */
export function metersPerPixel(zoom, lat) {
  return (156_543.03392 * Math.cos(rad(lat))) / 2 ** zoom;
}

/** How far from a road a tap still counts as "on that road": about 18 px of the current map, but never less than 12 m. */
export function tapToleranceMeters(zoom, lat, pixels = 18) {
  return Math.max(12, metersPerPixel(zoom, lat) * pixels);
}

/** Shortest distance in metres from `point` to a polyline given as GeoJSON-style [lng, lat] pairs (local flat approximation). */
export function distanceToLineMeters(point, coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return Infinity;
  const cosLat = Math.cos(rad(point.lat));
  const toXY = ([lng, lat]) => [rad(lng - point.lng) * cosLat * EARTH_RADIUS_M, rad(lat - point.lat) * EARTH_RADIUS_M];
  const pts = coordinates.map(toXY);
  if (pts.length === 1) return Math.hypot(pts[0][0], pts[0][1]);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** The two ends of a straight stretch of `lengthM` metres through `center` running along `bearing` (either direction). */
export function lineThrough(center, bearing, lengthM) {
  const half = lengthM / 2;
  const cosLat = Math.cos(rad(center.lat));
  const dNorth = Math.cos(rad(bearing)) * half;
  const dEast = Math.sin(rad(bearing)) * half;
  const dLat = deg(dNorth / EARTH_RADIUS_M);
  const dLng = deg(dEast / (EARTH_RADIUS_M * cosLat));
  return [
    { lat: center.lat - dLat, lng: center.lng - dLng },
    { lat: center.lat + dLat, lng: center.lng + dLng },
  ];
}

/** Compass point for a heading, in the given language's order of letters ("NO" in German, "NE" in English). */
export function compassPoint(headingDegrees, lang = "de") {
  const names = lang === "en" ? ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] : ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];
  return names[Math.round((((headingDegrees % 360) + 360) % 360) / 45) % 8];
}
