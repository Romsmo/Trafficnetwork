import { describe, expect, it } from "vitest";
import { envelopeForRadius } from "../../src/lib/geo-bbox.js";

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Point at `distanceM` from (lat,lng) along `bearingRad` on a sphere. */
function destination(lat: number, lng: number, distanceM: number, bearingRad: number): { lat: number; lng: number } {
  const d = distanceM / EARTH_RADIUS_M;
  const phi1 = rad(lat);
  const lambda1 = rad(lng);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(bearingRad));
  const lambda2 = lambda1 + Math.atan2(Math.sin(bearingRad) * Math.sin(d) * Math.cos(phi1), Math.cos(d) - Math.sin(phi1) * Math.sin(phi2));
  return { lat: deg(phi2), lng: deg(lambda2) };
}

/** Small deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("envelopeForRadius", () => {
  it("contains every point within the radius (superset of the circle), across latitudes and radii", () => {
    const rand = mulberry32(42);
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const lat = -80 + rand() * 160;
      const lng = -170 + rand() * 340;
      const radiusM = 10 + rand() * rand() * 50_000;
      const env = envelopeForRadius(lat, lng, radiusM);
      if (!env) continue;
      for (let j = 0; j < 50; j++) {
        // include points right on the circle's edge, where the box is tightest
        const dist = j < 25 ? radiusM : rand() * radiusM;
        const p = destination(lat, lng, dist, rand() * 2 * Math.PI);
        expect(p.lat).toBeGreaterThanOrEqual(env.south);
        expect(p.lat).toBeLessThanOrEqual(env.north);
        expect(p.lng).toBeGreaterThanOrEqual(env.west);
        expect(p.lng).toBeLessThanOrEqual(env.east);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it("returns a sensible, tight box for a typical query (Munich, 1 km)", () => {
    const env = envelopeForRadius(48.1374, 11.5755, 1000)!;
    expect(env.north - env.south).toBeGreaterThan(0.018);
    expect(env.north - env.south).toBeLessThan(0.022);
    expect(env.east - env.west).toBeGreaterThan(0.027);
    expect(env.east - env.west).toBeLessThan(0.034);
  });

  it("falls back to no prefilter where a flat box is not a superset (poles, antimeridian)", () => {
    expect(envelopeForRadius(89.5, 10, 1000)).toBeNull();
    expect(envelopeForRadius(-89.5, 10, 1000)).toBeNull();
    expect(envelopeForRadius(10, 179.9995, 1000)).toBeNull();
    expect(envelopeForRadius(10, -179.9995, 1000)).toBeNull();
  });
});
