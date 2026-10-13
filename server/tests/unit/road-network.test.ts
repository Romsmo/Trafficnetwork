import { describe, expect, it } from "vitest";
import { haversineMeters, intervalRef, lineLengthMeters, parseIntervalRef, projectOnSegment, quantise5 } from "../../src/modules/roads/geo.js";
import { findPath, type RoadWay } from "../../src/modules/roads/pathfinder.js";
import { boxOf, overpassQuery, parseOverpassAnswer } from "../../src/modules/roads/overpass.js";

// A small town at 48.1375 N, 11.5755 E. 0.001 deg lat = 111 m; 0.001 deg lng = 74 m there.
const LAT = 48.1375;
const LNG = 11.5755;
const at = (dLatM: number, dLngM: number): [number, number] => [LNG + dLngM / 74_300, LAT + dLatM / 111_320];

function way(id: string, name: string | null, ...points: [number, number][]): RoadWay {
  return { id, kind: "road_way", coordinates: points, highway: "residential", name, ref: null };
}

// "Hauptstrasse" runs west-east, split into three ways at junctions; "Nebenstrasse" runs parallel 40 m to the north and
// is joined to it by "Verbindung" at the east end; "Querstrasse" crosses at x = 300.
const NETWORK: RoadWay[] = [
  way("h1", "Hauptstrasse", at(0, 0), at(0, 200), at(0, 300)),
  way("h2", "Hauptstrasse", at(0, 300), at(0, 500)),
  way("h3", "Hauptstrasse", at(0, 500), at(5, 700), at(0, 900)),
  way("n1", "Nebenstrasse", at(40, 0), at(40, 450)),
  way("v1", "Verbindung", at(40, 450), at(0, 500)),
  way("q1", "Querstrasse", at(-200, 300), at(0, 300), at(200, 300)),
];
const OPTIONS = { toleranceM: 35, maxLengthM: 3000 };

describe("interval references", () => {
  it("name two points the same whichever comes first, at 1e-5 degrees", () => {
    const a = { lat: 48.137512, lng: 11.575534 };
    const b = { lat: 48.138801, lng: 11.577012 };
    expect(intervalRef(a, b)).toBe(intervalRef(b, a));
    expect(intervalRef(a, b)).toBe(`ivl:${quantise5(a.lat)},${quantise5(a.lng)}:${quantise5(b.lat)},${quantise5(b.lng)}`);
    // a point 0.5 m away is the same reference
    expect(intervalRef({ lat: a.lat + 0.000001, lng: a.lng }, b)).toBe(intervalRef(a, b));
  });

  it("parse back to the points, and refuse anything else", () => {
    const parsed = parseIntervalRef("ivl:4813751,1157553:4813880,1157701")!;
    expect(parsed.from.lat).toBeCloseTo(48.13751, 5);
    expect(parsed.to.lng).toBeCloseTo(11.57701, 5);
    for (const bad of ["ivl:1,2", "gap:871f1d489ffffff:3", "ivl:a,b:c,d", "ivl:99999999999,1:1,1", "ivl:4813751,1157553:4813880,1157701;drop"]) {
      expect(parseIntervalRef(bad)).toBeNull();
    }
  });
});

describe("geometry", () => {
  it("projects a point onto a segment and measures the distance", () => {
    const a: [number, number] = at(0, 0);
    const b: [number, number] = at(0, 200);
    const p = projectOnSegment(at(20, 100), a, b);
    expect(p.distanceM).toBeGreaterThan(19);
    expect(p.distanceM).toBeLessThan(21);
    expect(p.t).toBeCloseTo(0.5, 2);
    expect(haversineMeters(p.point, at(0, 100))).toBeLessThan(0.5);
    expect(projectOnSegment(at(0, -50), a, b).t).toBe(0);
  });
});

describe("the stretch between two picked points (findPath)", () => {
  it("runs along the road's own shape, across the ways it is split into", () => {
    const from = { lat: at(6, 100)[1], lng: at(6, 100)[0] }; // 6 m off the road
    const to = { lat: at(-4, 650)[1], lng: at(-4, 650)[0] };
    const result = findPath(NETWORK, from, to, OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = result.path;
    // 550 m of road (the last way bends 5 m north: a hair longer than the straight 550)
    expect(p.lengthM).toBeGreaterThan(545);
    expect(p.lengthM).toBeLessThan(570);
    expect(p.wayIds).toEqual(["h1", "h2", "h3"]);
    expect(p.name).toBe("Hauptstrasse");
    // the end points are ON the road, not where the finger was
    expect(haversineMeters(p.coordinates[0]!, at(0, 100))).toBeLessThan(1);
    // and every vertex lies on the road network (no corner cut)
    for (const c of p.coordinates) {
      const nearest = Math.min(
        ...NETWORK.flatMap((w) => w.coordinates.slice(1).map((q, i) => projectOnSegment(c, w.coordinates[i]!, q).distanceM)),
      );
      expect(nearest).toBeLessThan(0.5);
    }
    expect(p.fromDistanceM).toBeGreaterThan(5);
    expect(p.fromDistanceM).toBeLessThan(7);
  });

  it("takes the nearest of two parallel roads", () => {
    const from = { lat: at(34, 100)[1], lng: at(34, 100)[0] }; // 6 m from the northern road, 34 m from the main one
    const to = { lat: at(38, 400)[1], lng: at(38, 400)[0] };
    const result = findPath(NETWORK, from, to, OPTIONS);
    expect(result.ok && result.path.name).toBe("Nebenstrasse");
    expect(result.ok && result.path.wayIds).toEqual(["n1"]);
  });

  it("follows the connection when the two points are on different roads that meet", () => {
    const from = { lat: at(41, 400)[1], lng: at(41, 400)[0] }; // on Nebenstrasse
    const to = { lat: at(1, 600)[1], lng: at(1, 600)[0] }; // on Hauptstrasse beyond the junction
    const result = findPath(NETWORK, from, to, OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path.wayIds.join(",")).toBe("n1,v1,h3");
    expect(result.path.lengthM).toBeGreaterThan(200);
    expect(result.path.lengthM).toBeLessThan(230);
  });

  it("says no_road when a point is nowhere near a road", () => {
    const from = { lat: at(300, 100)[1], lng: at(300, 100)[0] };
    const to = { lat: at(0, 600)[1], lng: at(0, 600)[0] };
    expect(findPath(NETWORK, from, to, OPTIONS)).toEqual({ ok: false, failure: "no_road" });
  });

  it("refuses points too close together or too far apart", () => {
    const a = { lat: at(0, 100)[1], lng: at(0, 100)[0] };
    const near = { lat: at(0, 105)[1], lng: at(0, 105)[0] };
    expect(findPath(NETWORK, a, near, OPTIONS)).toEqual({ ok: false, failure: "too_short" });
    const far = { lat: at(0, 900)[1], lng: at(0, 900)[0] };
    expect(findPath(NETWORK, a, far, { toleranceM: 35, maxLengthM: 500 })).toEqual({ ok: false, failure: "too_long" });
  });

  it("does not leap between roads that do not meet", () => {
    const island: RoadWay[] = [...NETWORK, way("far", "Insel", at(500, 0), at(500, 400))];
    const from = { lat: at(1, 100)[1], lng: at(1, 100)[0] };
    const to = { lat: at(501, 300)[1], lng: at(501, 300)[0] };
    const result = findPath(island, from, to, { toleranceM: 35, maxLengthM: 3000 });
    expect(result.ok).toBe(false);
  });

  it("is deterministic: the same ways and points give the same line", () => {
    const from = { lat: at(2, 50)[1], lng: at(2, 50)[0] };
    const to = { lat: at(-1, 800)[1], lng: at(-1, 800)[0] };
    const one = findPath(NETWORK, from, to, OPTIONS);
    const two = findPath([...NETWORK].reverse(), from, to, OPTIONS);
    expect(one.ok && two.ok && JSON.stringify(one.path.coordinates)).toBe(two.ok && two.ok ? JSON.stringify(two.path.coordinates) : "");
  });
});

describe("the road service (Overpass)", () => {
  it("asks for drivable ways in a box", () => {
    const q = overpassQuery(boxOf([[11.57, 48.13], [11.59, 48.15]]), 20);
    expect(q).toContain("[out:json]");
    expect(q).toContain('way["highway"~"^(motorway|');
    expect(q).toContain("(48.130000,11.570000,48.150000,11.590000)");
    expect(q).not.toContain("footway");
  });

  it("keeps drivable ways with a shape and drops the rest", () => {
    const answer = {
      elements: [
        { type: "way", id: 1, tags: { highway: "residential", name: "A-Straße", ref: "K 7" }, geometry: [{ lat: 48.1, lon: 11.5 }, { lat: 48.1, lon: 11.501 }] },
        { type: "way", id: 2, tags: { highway: "footway" }, geometry: [{ lat: 48.1, lon: 11.5 }, { lat: 48.1, lon: 11.501 }] },
        { type: "way", id: 3, tags: { highway: "service" }, geometry: [{ lat: 48.1, lon: 11.5 }] },
        { type: "way", id: 4, tags: { highway: "service", area: "yes" }, geometry: [{ lat: 48.1, lon: 11.5 }, { lat: 48.2, lon: 11.5 }] },
        { type: "node", id: 5 },
      ],
    };
    const ways = parseOverpassAnswer(answer);
    expect(ways).toHaveLength(1);
    expect(ways[0]).toEqual({ externalId: "1", coordinates: [[11.5, 48.1], [11.501, 48.1]], highway: "residential", name: "A-Straße", ref: "K 7" });
    expect(() => parseOverpassAnswer({})).toThrow();
  });
});

describe("lengths", () => {
  it("add up along a polyline", () => {
    expect(lineLengthMeters([at(0, 0), at(0, 100), at(100, 100)])).toBeGreaterThan(195);
    expect(lineLengthMeters([at(0, 0), at(0, 100), at(100, 100)])).toBeLessThan(205);
  });
});
