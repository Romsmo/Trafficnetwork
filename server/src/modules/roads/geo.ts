/**
 * Plane geometry on small areas for the road network (docs/road-network.md): distances, projections of a point onto a line and the
 * quantised references two picked points are named by. Everything is a pure function; nothing here knows about a database.
 *
 * Positions are `[lng, lat]` pairs as in GeoJSON. A local equirectangular projection around a reference latitude is exact enough
 * for the few kilometres an interval is allowed to span (error well below a metre at mid latitudes).
 */
export type Position = readonly [number, number];

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

export function haversineMeters(a: Position, b: Position): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineLengthMeters(line: readonly Position[]): number {
  let total = 0;
  for (let i = 0; i + 1 < line.length; i += 1) total += haversineMeters(line[i]!, line[i + 1]!);
  return total;
}

export interface Projection {
  /** The closest point on the segment. */
  point: [number, number];
  /** 0..1 along the segment. */
  t: number;
  distanceM: number;
}

/** Projects `p` onto the segment a-b (local metric plane around `p`'s latitude). */
export function projectOnSegment(p: Position, a: Position, b: Position): Projection {
  const k = Math.cos(p[1] * RAD);
  const mPerDegLat = EARTH_RADIUS_M * RAD;
  const mPerDegLng = mPerDegLat * k;
  const ax = (a[0] - p[0]) * mPerDegLng;
  const ay = (a[1] - p[1]) * mPerDegLat;
  const bx = (b[0] - p[0]) * mPerDegLng;
  const by = (b[1] - p[1]) * mPerDegLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return {
    point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    t,
    distanceM: Math.hypot(x, y),
  };
}

/** Quantises to 1e-5 degrees (~1.1 m): the precision picked points are named at, in references and in the vote a device signs. */
export function quantise5(degrees: number): number {
  return Math.round(degrees * 1e5);
}

/**
 * The reference an interval proposal is named by: `ivl:<lat>,<lng>:<lat>,<lng>` with the end points as integer 1e-5 degrees,
 * the smaller pair first (a stretch has no direction). A device computes it from the two points it picked without any road data;
 * every server derives the same place from it.
 */
export const INTERVAL_REF_PATTERN = /^ivl:-?\d{1,8},-?\d{1,9}:-?\d{1,8},-?\d{1,9}$/;

export interface LatLng {
  lat: number;
  lng: number;
}

export function intervalRef(a: LatLng, b: LatLng): string {
  const pa: [number, number] = [quantise5(a.lat), quantise5(a.lng)];
  const pb: [number, number] = [quantise5(b.lat), quantise5(b.lng)];
  const [first, second] = pa[0] < pb[0] || (pa[0] === pb[0] && pa[1] <= pb[1]) ? [pa, pb] : [pb, pa];
  return `ivl:${first[0]},${first[1]}:${second[0]},${second[1]}`;
}

/** The two end points a reference names (lat/lng in degrees), or null if it is not a well-formed reference. */
export function parseIntervalRef(ref: string): { from: LatLng; to: LatLng } | null {
  if (!INTERVAL_REF_PATTERN.test(ref)) return null;
  const [, rest] = ref.split("ivl:");
  const [first, second] = (rest ?? "").split(":");
  const parse = (pair: string | undefined): LatLng | null => {
    const [lat, lng] = (pair ?? "").split(",").map(Number);
    if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 9_000_000 || Math.abs(lng) > 18_000_000) return null;
    return { lat: lat / 1e5, lng: lng / 1e5 };
  };
  const from = parse(first);
  const to = parse(second);
  return from && to ? { from, to } : null;
}
