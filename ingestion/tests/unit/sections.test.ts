import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firstCoordinate, splitIntoSections, tileFor } from "../../src/pipeline/osm/sections.js";

const RS = "\x1e";

function point(lng: number, lat: number, id = 1): string {
  return `${RS}{"type":"Feature","geometry":{"type":"Point","coordinates":[${lng},${lat}]},"properties":{"@type":"node","@id":${id}}}`;
}

function way(coordinates: [number, number][], id = 1, tags: Record<string, string> = {}): string {
  return `${RS}{"type":"Feature","geometry":{"type":"LineString","coordinates":${JSON.stringify(coordinates)}},"properties":${JSON.stringify({ "@type": "way", "@id": id, ...tags })}}`;
}

async function* lines(items: string[]): AsyncGenerator<string> {
  for (const item of items) yield item;
}

describe("firstCoordinate", () => {
  it("reads the first vertex of points and linestrings", () => {
    expect(firstCoordinate(point(11.3005851, 48.2018994))).toEqual([11.3005851, 48.2018994]);
    expect(firstCoordinate(way([[-3.5, 40.25], [-3.6, 40.3]]))).toEqual([-3.5, 40.25]);
  });

  it("is not fooled by a tag literally named coordinates (properties come after geometry)", () => {
    expect(firstCoordinate(way([[7, 47]], 5, { coordinates: "[[99,99]]" }))).toEqual([7, 47]);
  });

  it("returns undefined for a line without a usable geometry", () => {
    expect(firstCoordinate(`${RS}{"type":"Feature","geometry":null,"properties":{}}`)).toBeUndefined();
  });
});

describe("tileFor", () => {
  it("names 10° tiles by their south-west corner", () => {
    expect(tileFor(10.5, 50.2, 10)).toEqual({ id: "x10_y50", bbox: [10, 50, 20, 60] });
    expect(tileFor(-3.5, 40.25, 10)).toEqual({ id: "xm10_y40", bbox: [-10, 40, 0, 50] });
    expect(tileFor(0, 0, 10).id).toBe("x0_y0");
    expect(tileFor(-0.0001, -0.0001, 10).id).toBe("xm10_ym10");
  });
});

describe("splitIntoSections", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sections-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("puts every feature into the tile of its first coordinate, byte for byte, and counts them", async () => {
    const input = [point(11, 48, 1), way([[11.5, 48.5], [30, 60]], 2), point(2.35, 48.85, 3), point(-3.7, 40.4, 4), `${RS}{"type":"Feature","geometry":null,"properties":{}}`];
    const manifest = await splitIntoSections(lines(input), dir, { tileDegrees: 10, inputMd5: "abc", filter: "f" });

    expect(manifest.totalFeatures).toBe(5);
    expect(Object.fromEntries(manifest.sections.map((s) => [s.id, s.features]))).toEqual({ x10_y40: 2, x0_y40: 1, xm10_y40: 1, misc: 1 });
    // The way crossing into another tile stays whole in the tile of its first vertex.
    expect(readFileSync(path.join(dir, "x10_y40.geojsonseq"), "utf8")).toBe(input[0] + "\n" + input[1] + "\n");
    expect(manifest.inputMd5).toBe("abc");
  });

  it("writes one section when tiling is off", async () => {
    const manifest = await splitIntoSections(lines([point(11, 48), point(2, 3)]), dir, { tileDegrees: null, inputMd5: "abc", filter: "f" });
    expect(manifest.sections).toEqual([{ id: "all", file: "all.geojsonseq", features: 2 }]);
  });

  it("wipes leftovers of an earlier, half-written attempt", async () => {
    await splitIntoSections(lines([point(11, 48)]), dir, { tileDegrees: 10, inputMd5: "old", filter: "f" });
    const manifest = await splitIntoSections(lines([point(2, 48)]), dir, { tileDegrees: 10, inputMd5: "new", filter: "f" });
    expect(manifest.sections.map((s) => s.id)).toEqual(["x0_y40"]);
  });
});
