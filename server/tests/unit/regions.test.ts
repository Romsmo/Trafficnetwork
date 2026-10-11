import { describe, expect, it } from "vitest";
import { cellToBoundary, cellToParent, latLngToCell } from "h3-js";
import { groupRegions, tileCentres } from "../../src/modules/static-data/regions.js";

const RES = 4;
const BERLIN = latLngToCell(52.52, 13.405, RES);
const POTSDAM = latLngToCell(52.39, 13.06, RES);
const PARIS = latLngToCell(48.857, 2.352, RES);
const SEA = latLngToCell(54.5, 3.0, RES);

const input = (tile: string, sizeBytes: number, gzipBytes: number | null = Math.round(sizeBytes / 4), brotliBytes: number | null = Math.round(sizeBytes / 4.2)) => ({
  tile,
  sizeBytes,
  gzipBytes,
  brotliBytes,
});

describe("offline regions: grouping", () => {
  const countries = new Map<string, string | null>([
    [BERLIN, "DE"],
    [POTSDAM, "DE"],
    [PARIS, "FR"],
    [SEA, null],
  ]);

  it("sums tiles per country, counts a tile once, and the regions add up to the whole", () => {
    const tiles = [input(BERLIN, 4000), input(POTSDAM, 2000), input(PARIS, 1000), input(SEA, 500)];
    const regions = groupRegions(tiles, countries);
    const de = regions.find((r) => r.id === "DE")!;
    const fr = regions.find((r) => r.id === "FR")!;
    expect(de).toMatchObject({ country: "DE", tileCount: 2, sizeBytes: 6000, complete: true });
    expect(de.tiles).toEqual([BERLIN, POTSDAM].sort());
    expect(fr).toMatchObject({ country: "FR", tileCount: 1, sizeBytes: 1000 });
    expect(regions.reduce((n, r) => n + r.tileCount, 0)).toBe(4);
    expect(regions.reduce((n, r) => n + r.sizeBytes, 0)).toBe(7500);
    expect(regions.reduce((n, r) => n + r.gzipBytes, 0)).toBe(tiles.reduce((n, t) => n + (t.gzipBytes ?? 0), 0));
  });

  it("puts a tile without a country into a coarse H3 area instead of dropping it", () => {
    const [sea] = groupRegions([input(SEA, 500)], countries);
    expect(sea).toMatchObject({ country: null, tileCount: 1 });
    expect(sea!.id).toBe(`h3:${cellToParent(SEA, 2)}`);
  });

  it("with no boundary data at all everything is coarse areas, still bounded and complete", () => {
    const regions = groupRegions([input(BERLIN, 1), input(PARIS, 1)], new Map());
    expect(regions.every((r) => r.country === null && r.id.startsWith("h3:"))).toBe(true);
    expect(regions.reduce((n, r) => n + r.tileCount, 0)).toBe(2);
  });

  it("is incomplete — and says so — while a tile has no compressed copy yet", () => {
    const [de] = groupRegions([input(BERLIN, 4000), input(POTSDAM, 2000, null, null)], countries);
    expect(de!.complete).toBe(false);
    expect(de!.sizeBytes).toBe(6000);
  });

  it("the bounding box covers every tile of the region", () => {
    const [de] = groupRegions([input(BERLIN, 1), input(POTSDAM, 1)], countries);
    const [west, south, east, north] = de!.bbox;
    for (const tile of [BERLIN, POTSDAM]) {
      for (const [lat, lng] of cellToBoundary(tile)) {
        expect(lng).toBeGreaterThanOrEqual(west);
        expect(lng).toBeLessThanOrEqual(east);
        expect(lat).toBeGreaterThanOrEqual(south);
        expect(lat).toBeLessThanOrEqual(north);
      }
    }
  });

  it("is deterministic: input order does not change the answer", () => {
    const a = groupRegions([input(BERLIN, 4000), input(PARIS, 1000), input(POTSDAM, 2000)], countries);
    const b = groupRegions([input(POTSDAM, 2000), input(BERLIN, 4000), input(PARIS, 1000)], countries);
    expect(b).toEqual(a);
  });

  it("tile centres are inside their tile", () => {
    const [c] = tileCentres([BERLIN]);
    expect(latLngToCell(c!.lat, c!.lng, RES)).toBe(BERLIN);
  });
});
