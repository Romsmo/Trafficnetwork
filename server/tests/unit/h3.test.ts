import { describe, expect, it } from "vitest";
import { expandTile, positionToRegionTile } from "../../src/lib/h3.js";

describe("positionToRegionTile", () => {
  it("computes a resolution-7 H3 cell for a given position", () => {
    const berlin = { lat: 52.52, lng: 13.405 };
    const tile = positionToRegionTile(berlin.lat, berlin.lng, { REGION_TILE_H3_RESOLUTION: 7 });
    expect(typeof tile).toBe("string");
    expect(tile.length).toBeGreaterThan(0);
  });

  it("is deterministic for the same position and resolution", () => {
    const pos = { lat: 48.8566, lng: 2.3522 };
    const a = positionToRegionTile(pos.lat, pos.lng, { REGION_TILE_H3_RESOLUTION: 7 });
    const b = positionToRegionTile(pos.lat, pos.lng, { REGION_TILE_H3_RESOLUTION: 7 });
    expect(a).toBe(b);
  });

  it("produces a coarser (shorter-lived-precision) cell at a lower resolution", () => {
    const pos = { lat: 40.7128, lng: -74.006 };
    const res7 = positionToRegionTile(pos.lat, pos.lng, { REGION_TILE_H3_RESOLUTION: 7 });
    const res3 = positionToRegionTile(pos.lat, pos.lng, { REGION_TILE_H3_RESOLUTION: 3 });
    expect(res7).not.toBe(res3);
  });
});

describe("expandTile", () => {
  it("k=0 returns only the center tile", () => {
    const center = positionToRegionTile(52.52, 13.405, { REGION_TILE_H3_RESOLUTION: 7 });
    expect(expandTile(center, 0)).toEqual([center]);
  });

  it("k=1 returns the center plus its 6 immediate neighbors (7 total)", () => {
    const center = positionToRegionTile(52.52, 13.405, { REGION_TILE_H3_RESOLUTION: 7 });
    const disk = expandTile(center, 1);
    expect(disk).toContain(center);
    expect(disk.length).toBe(7);
  });
});
