import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cellToLatLng } from "h3-js";
import {
  GAP_LENGTH_M,
  GAP_REF_PATTERN,
  axisBucket,
  gapCoordinates,
  gapGeometry,
  geometryKeyOf,
  parseGapRef,
  placeOf,
} from "../../src/modules/speed-limit-corrections/gap.js";
import { VOTE_SEGMENT_REF_PATTERN } from "../../src/modules/speed-limit-corrections/vote.js";

/** An independent implementation of the key formula (docs/schema.md), as in speed-limit-geometry-key.test.ts. */
function referenceKey(coords: [number, number][]): string {
  const pts = coords.map(([lng, lat]) => `${Math.round(lng * 1e7)},${Math.round(lat * 1e7)}`);
  const fwd = pts.join(";");
  const rev = [...pts].reverse().join(";");
  return createHash("sha256").update(fwd < rev ? fwd : rev).digest("hex").slice(0, 32);
}

function distanceM(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(toRad(b[1] - a[1]) / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(toRad(b[0] - a[0]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

describe("gap place: direction buckets", () => {
  it("maps a heading to one of 8 axis buckets, the same for both directions of travel", () => {
    expect(axisBucket(0)).toBe(0);
    expect(axisBucket(180)).toBe(0);
    expect(axisBucket(360)).toBe(0);
    expect(axisBucket(90)).toBe(4);
    expect(axisBucket(270)).toBe(4);
    expect(axisBucket(45)).toBe(2);
    expect(axisBucket(225)).toBe(2);
    expect(axisBucket(135)).toBe(6);
    for (const b of [0, 10, 33, 89, 91, 150, 179]) expect(axisBucket(b)).toBe(axisBucket(b + 180));
  });

  it("rounds to the nearest 22.5 degrees and wraps just below 180 back to north-south", () => {
    expect(axisBucket(11)).toBe(0);
    expect(axisBucket(12)).toBe(1);
    expect(axisBucket(168.5)).toBe(7);
    expect(axisBucket(169)).toBe(0);
    expect(axisBucket(179.9)).toBe(0);
  });
});

describe("gap place: reference and geometry", () => {
  const place = placeOf(50.1, 9.1, 90);

  it("builds a reference a device can compute and that is accepted as a signed segmentKey", () => {
    const ref = `gap:${place.cell}:${place.axis}`;
    expect(GAP_REF_PATTERN.test(ref)).toBe(true);
    expect(VOTE_SEGMENT_REF_PATTERN.test(ref)).toBe(true);
    expect(parseGapRef(ref)).toEqual(place);
  });

  it("refuses malformed references and cells of another resolution", () => {
    expect(parseGapRef("gap:zzzzzzzzzzzzzzz:1")).toBeNull();
    expect(parseGapRef(`gap:${place.cell}:8`)).toBeNull();
    expect(parseGapRef(`gap:${place.cell}`)).toBeNull();
    expect(parseGapRef("gap:8a2a1072b59ffff:0")).not.toBeNull(); // a real resolution-10 cell
    expect(parseGapRef("gap:85283473fffffff:0")).toBeNull(); // resolution 5, 15 hex chars, valid cell
  });

  it("is a stretch of road GAP_LENGTH_M long, centred on the cell, along its axis, at 1e-7 degree precision", () => {
    const [a, b] = gapCoordinates(place);
    expect(distanceM(a, b)).toBeGreaterThan(GAP_LENGTH_M - 1);
    expect(distanceM(a, b)).toBeLessThan(GAP_LENGTH_M + 1);
    const [lat, lng] = cellToLatLng(place.cell);
    expect((a[0] + b[0]) / 2).toBeCloseTo(lng, 6);
    expect((a[1] + b[1]) / 2).toBeCloseTo(lat, 6);
    // axis 4 = east-west: the latitude barely changes
    expect(Math.abs(a[1] - b[1])).toBeLessThan(1e-6);
    for (const v of [...a, ...b]) expect(Math.round(v * 1e7) / 1e7).toBe(v);
  });

  it("derives the key exactly as the database does, and two devices at the same place share it", () => {
    const g = gapGeometry(place);
    expect(g.segmentKey).toBe(referenceKey(g.coordinates));
    expect(geometryKeyOf([...g.coordinates].reverse() as [[number, number], [number, number]])).toBe(g.segmentKey);

    const [lat, lng] = cellToLatLng(place.cell);
    const other = placeOf(lat + 0.0001, lng + 0.0001, 270); // same cell, same axis, opposite heading
    expect(gapGeometry(other).segmentKey).toBe(g.segmentKey);
    expect(gapGeometry(placeOf(lat, lng, 0)).segmentKey).not.toBe(g.segmentKey);
  });
});
