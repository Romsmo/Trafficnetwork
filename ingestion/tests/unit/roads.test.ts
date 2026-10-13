import pino from "pino";
import { describe, expect, it } from "vitest";
import { CoverageTracker, importRoads, normalizeRoadFeature, ROAD_HIGHWAYS, ROAD_TAG_FILTER, type RoadPoster } from "../../src/pipeline/osm/roads.js";
import type { OsmFeature } from "../../src/pipeline/osm/normalize.js";
import type { RoadWayRow } from "../../src/api/types.js";

const logger = pino({ level: "silent" });

function way(id: number, highway: string, coordinates: [number, number][], extra: Record<string, unknown> = {}): OsmFeature {
  return { type: "Feature", properties: { "@type": "way", "@id": id, highway, ...extra }, geometry: { type: "LineString", coordinates } };
}

async function* of(features: OsmFeature[]): AsyncGenerator<OsmFeature> {
  for (const f of features) yield f;
}

class FakePoster implements RoadPoster {
  ways: RoadWayRow[][] = [];
  coverage: string[][] = [];
  async postRoadWays(rows: RoadWayRow[]) {
    this.ways.push(rows);
    return { inserted: rows.length };
  }
  async postRoadCoverage(tiles: string[]) {
    this.coverage.push(tiles);
    return { covered: tiles.length };
  }
}

describe("the road network of an extract", () => {
  it("filters the drivable ways, in the list the server knows", () => {
    expect(ROAD_TAG_FILTER).toHaveLength(1);
    expect(ROAD_TAG_FILTER[0]).toBe(`w/highway=${ROAD_HIGHWAYS.join(",")}`);
    expect(ROAD_HIGHWAYS).toContain("residential");
    expect(ROAD_HIGHWAYS).not.toContain("footway");
  });

  it("turns a way into a row with its id, class, name and ref", () => {
    const row = normalizeRoadFeature(
      way(4711, "primary", [[9.1, 50.1], [9.2, 50.1]], { name: "Hauptstraße", ref: "B 26", maxspeed: "70" }),
    );
    expect(row).toEqual({ externalId: "w4711", lineString: [[9.1, 50.1], [9.2, 50.1]], highway: "primary", name: "Hauptstraße", ref: "B 26" });
    // no name, no ref: not even the keys
    expect(normalizeRoadFeature(way(1, "residential", [[9, 50], [9.001, 50]]))).toEqual({ externalId: "w1", lineString: [[9, 50], [9.001, 50]], highway: "residential" });
  });

  it("leaves out what is not a drivable line", () => {
    expect(normalizeRoadFeature(way(2, "footway", [[9, 50], [9.001, 50]]))).toBeUndefined();
    expect(normalizeRoadFeature(way(3, "residential", [[9, 50]]))).toBeUndefined();
    expect(normalizeRoadFeature({ type: "Feature", properties: { "@type": "node", "@id": 5, highway: "residential" }, geometry: { type: "Point", coordinates: [9, 50] } })).toBeUndefined();
    expect(normalizeRoadFeature({ type: "Feature", properties: { "@type": "way", "@id": 6, highway: "residential" }, geometry: { type: "Polygon", coordinates: [] } })).toBeUndefined();
  });

  it("an area is complete only where the roads reach every neighbour around it", () => {
    const tracker = new CoverageTracker();
    // a grid of streets, 4 km x 4 km, every ~100 m
    for (let i = 0; i <= 40; i += 1) {
      tracker.addLine([[9.1 + i * 0.0014, 50.1], [9.1 + i * 0.0014, 50.136]]);
      tracker.addLine([[9.1, 50.1 + i * 0.0009], [9.156, 50.1 + i * 0.0009]]);
    }
    const complete = tracker.complete();
    expect(complete.length).toBeGreaterThan(5);
    expect(complete.length).toBeLessThan(tracker.touched);
    // a single lonely road is never complete: its neighbours have no road
    const lonely = new CoverageTracker();
    lonely.addLine([[9.1, 50.1], [9.1005, 50.1]]);
    expect(lonely.complete()).toEqual([]);
  });

  it("sends every drivable way in batches, then the complete areas, and counts what it left out", async () => {
    const features: OsmFeature[] = [];
    for (let i = 0; i < 2500; i += 1) {
      const lng = 9.1 + (i % 50) * 0.001;
      const lat = 50.1 + Math.floor(i / 50) * 0.0008;
      features.push(way(i + 1, "residential", [[lng, lat], [lng + 0.0009, lat]]));
    }
    features.push(way(99_999, "footway", [[9, 50], [9.001, 50]]));
    const poster = new FakePoster();
    const report = await importRoads(of(features), poster, { dryRun: false, logger });
    expect(report.featuresRead).toBe(2501);
    expect(report.waysSent).toBe(2500);
    expect(report.skipped).toBe(1);
    expect(poster.ways.map((b) => b.length)).toEqual([1000, 1000, 500]);
    expect(report.coverageSent).toBe(report.coverageCells);
    expect(report.coverageCells).toBeGreaterThan(0);
    expect(poster.coverage.flat()).toHaveLength(report.coverageCells);
  });

  it("a dry run reads and counts and sends nothing", async () => {
    const poster = new FakePoster();
    const report = await importRoads(of([way(1, "residential", [[9, 50], [9.001, 50]])]), poster, { dryRun: true, logger });
    expect(report.waysSent).toBe(1);
    expect(poster.ways).toEqual([]);
    expect(poster.coverage).toEqual([]);
  });

  it("stops when the server took fewer ways than were sent", async () => {
    const poster: RoadPoster = { postRoadWays: async (rows) => ({ inserted: rows.length - 1 }), postRoadCoverage: async (t) => ({ covered: t.length }) };
    await expect(importRoads(of([way(1, "residential", [[9, 50], [9.001, 50]])]), poster, { dryRun: false, logger })).rejects.toThrow(/took 0 of 1/);
  });
});
