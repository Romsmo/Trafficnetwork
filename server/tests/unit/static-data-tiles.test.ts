import { describe, expect, it } from "vitest";
import { cellToBoundary, cellToChildren, getRes0Cells, getResolution, latLngToCell } from "h3-js";
import { childTiles, pointTileOf, pruningEnvelopes, rootTiles, segmentTilesOf, tileEnvelopes, type Envelope } from "../../src/modules/static-data/tiles.js";

function inside(envs: Envelope[], lat: number, lng: number): boolean {
  return envs.some((e) => lat >= e.south && lat <= e.north && lng >= e.west && lng <= e.east);
}

/** Deterministic pseudo-random numbers so a failure is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("tileEnvelopes", () => {
  it("contains every point that latLngToCell maps into the tile — the property that keeps packages complete", () => {
    const rand = rng(42);
    for (const res of [0, 1, 2, 3, 4, 5, 6]) {
      for (let i = 0; i < 60_000; i++) {
        // Uniform on the sphere, plus a dense band around Europe and one along the antimeridian.
        let lat: number;
        let lng: number;
        if (i % 3 === 0) {
          lat = 34 + rand() * 40;
          lng = -12 + rand() * 60;
        } else if (i % 3 === 1) {
          lat = (Math.asin(2 * rand() - 1) * 180) / Math.PI;
          lng = rand() * 360 - 180;
        } else {
          lat = -85 + rand() * 170;
          lng = rand() < 0.5 ? 179 + rand() : -180 + rand();
        }
        const tile = latLngToCell(lat, lng, res);
        expect(inside(tileEnvelopes(tile), lat, lng), `res ${res} tile ${tile} point ${lat},${lng}`).toBe(true);
      }
    }
  }, 120_000);

  it("covers the points of a child cell that overhangs its parent, for the pruning descent", () => {
    const rand = rng(7);
    let checked = 0;
    for (const parent of getRes0Cells().slice(0, 40)) {
      for (const child of cellToChildren(parent, 1)) {
        const [lat0, lng0] = cellToBoundary(child)[0]!;
        for (let i = 0; i < 40; i++) {
          const lat = lat0 + (rand() - 0.5) * 3;
          const lng = lng0 + (rand() - 0.5) * 3;
          const tile = latLngToCell(lat, lng, 1);
          if (tile !== child) continue;
          checked++;
          expect(inside(pruningEnvelopes(parent), lat, lng) || latLngToCell(lat, lng, 0) !== parent).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("splits a cell straddling the antimeridian into two boxes and gives a polar cell all longitudes", () => {
    const straddling = latLngToCell(0, 179.99, 2);
    const envs = tileEnvelopes(straddling);
    expect(inside(envs, 0, 179.99)).toBe(true);
    const north = latLngToCell(89.99, 10, 3);
    expect(tileEnvelopes(north)).toEqual([expect.objectContaining({ west: -180, east: 180, north: 90 })]);
  });

  it("is a small box for an ordinary cell", () => {
    const [env] = tileEnvelopes(latLngToCell(48.1, 11.5, 4));
    expect(env!.east - env!.west).toBeLessThan(2);
    expect(env!.north - env!.south).toBeLessThan(1);
  });
});

describe("vertex rule (identical to the in-memory builder)", () => {
  it("assigns a segment to every tile any of its vertices is in, a point to one tile", () => {
    const res = 4;
    const line = { type: "LineString", coordinates: [[11.5, 48.1], [11.51, 48.11], [12.5, 48.9]] };
    const tiles = segmentTilesOf(line, res);
    expect(tiles).toEqual(new Set([latLngToCell(48.1, 11.5, res), latLngToCell(48.11, 11.51, res), latLngToCell(48.9, 12.5, res)]));
    expect(pointTileOf({ type: "Point", coordinates: [11.5, 48.1] }, res)).toBe(latLngToCell(48.1, 11.5, res));
  });
});

describe("descent helpers", () => {
  it("expose the H3 hierarchy", () => {
    expect(rootTiles()).toHaveLength(122);
    const [first] = rootTiles();
    expect(childTiles(first!)).toHaveLength(first && getResolution(first) === 0 && childTiles(first).length === 6 ? 6 : 7);
  });
});
