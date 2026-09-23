import pino from "pino";
import { describe, expect, it } from "vitest";
import { normalizeFeature, type OsmFeature } from "../../src/pipeline/osm/normalize.js";

const silentLogger = pino({ level: "silent" });

function wayFeature(properties: Record<string, unknown>, coordinates: [number, number][] = [[13.4, 52.5], [13.41, 52.51]]): OsmFeature {
  return { type: "Feature", properties: { "@type": "way", "@id": 123, ...properties }, geometry: { type: "LineString", coordinates } };
}

function nodeFeature(properties: Record<string, unknown>, coordinates: [number, number] = [13.4, 52.5]): OsmFeature {
  return { type: "Feature", properties: { "@type": "node", "@id": 456, ...properties }, geometry: { type: "Point", coordinates } };
}

describe("normalizeFeature — speed-limit-segment (explicit maxspeed)", () => {
  it("emits a segment for a plain numeric maxspeed as kmh", () => {
    const rows = normalizeFeature(wayFeature({ highway: "primary", maxspeed: "50" }), silentLogger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "speed-limit-segment", key: "speed-limit-segment:way/123", row: { speedLimit: 50, speedLimitUnit: "kmh", source: "osm", sourceLicense: "ODbL" } });
  });

  it("emits a segment as mph when the value has an explicit mph suffix", () => {
    const rows = normalizeFeature(wayFeature({ highway: "primary", maxspeed: "50 mph" }), silentLogger);
    expect(rows).toEqual([expect.objectContaining({ kind: "speed-limit-segment", row: expect.objectContaining({ speedLimit: 50, speedLimitUnit: "mph" }) })]);
  });

  it("preserves the lineString's [lng,lat] coordinate order unchanged (GeoJSON order matches the API's expected order)", () => {
    const rows = normalizeFeature(wayFeature({ highway: "primary", maxspeed: "50" }, [[13.377, 52.516], [13.38, 52.52]]), silentLogger);
    const segment = rows.find((r) => r.kind === "speed-limit-segment");
    expect(segment?.row).toMatchObject({ lineString: [[13.377, 52.516], [13.38, 52.52]] });
  });

  it("skips a non-numeric maxspeed value (e.g. 'signals') rather than guessing", () => {
    const rows = normalizeFeature(wayFeature({ highway: "primary", maxspeed: "signals" }), silentLogger);
    expect(rows.filter((r) => r.kind === "speed-limit-segment")).toHaveLength(0);
  });

  it.each(["0", "0 mph", "0.0"])("skips a non-positive maxspeed value %j (the server rejects speedLimit <= 0 for the whole batch)", (maxspeed) => {
    const rows = normalizeFeature(wayFeature({ highway: "primary", maxspeed }), silentLogger);
    expect(rows.filter((r) => r.kind === "speed-limit-segment")).toHaveLength(0);
  });
});

describe("normalizeFeature — implicit maxspeed:type", () => {
  it.each([
    ["DE:urban", 50],
    ["DE:rural", 100],
    ["DE:zone30", 30],
    ["DE:zone20", 20],
  ])("resolves %s to %i km/h", (type, expected) => {
    const rows = normalizeFeature(wayFeature({ highway: "residential", "maxspeed:type": type }), silentLogger);
    expect(rows).toEqual([expect.objectContaining({ row: expect.objectContaining({ speedLimit: expected, speedLimitUnit: "kmh" }) })]);
  });

  it("falls back to source:maxspeed when maxspeed:type is absent", () => {
    const rows = normalizeFeature(wayFeature({ highway: "residential", "source:maxspeed": "DE:urban" }), silentLogger);
    expect(rows).toEqual([expect.objectContaining({ row: expect.objectContaining({ speedLimit: 50 }) })]);
  });

  it("skips DE:motorway (no blanket numeric limit) rather than inventing one", () => {
    const rows = normalizeFeature(wayFeature({ highway: "motorway", "maxspeed:type": "DE:motorway" }), silentLogger);
    expect(rows.filter((r) => r.kind === "speed-limit-segment")).toHaveLength(0);
  });

  it("skips DE:living_street (OSM wiki documents only the non-numeric 'walk') rather than inventing a km/h figure", () => {
    const rows = normalizeFeature(wayFeature({ highway: "living_street", "maxspeed:type": "DE:living_street" }), silentLogger);
    expect(rows.filter((r) => r.kind === "speed-limit-segment")).toHaveLength(0);
  });

  it("skips an unrecognized maxspeed:type value (e.g. a non-German AT:urban) instead of guessing", () => {
    const rows = normalizeFeature(wayFeature({ highway: "residential", "maxspeed:type": "AT:urban" }), silentLogger);
    expect(rows.filter((r) => r.kind === "speed-limit-segment")).toHaveLength(0);
  });

  it("emits nothing when there is no maxspeed and no highway tag at all", () => {
    const rows = normalizeFeature(wayFeature({ traffic_sign: "" }), silentLogger);
    expect(rows.filter((r) => r.kind === "speed-limit-segment")).toHaveLength(0);
  });
});

describe("normalizeFeature — static-sign (traffic_sign)", () => {
  it("emits one sign for a node with a single hyphenated sign code", () => {
    const rows = normalizeFeature(nodeFeature({ traffic_sign: "DE:274-50" }, [13.377, 52.516]), silentLogger);
    expect(rows).toEqual([
      { kind: "static-sign", key: "static-sign:node/456", row: { lat: 52.516, lng: 13.377, signType: "DE:274-50", source: "osm", sourceLicense: "ODbL" } },
    ]);
  });

  it("does not split a hyphenated sign code into separate signs", () => {
    const rows = normalizeFeature(nodeFeature({ traffic_sign: "DE:274-30" }), silentLogger);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row).toMatchObject({ signType: "DE:274-30" });
  });

  it("splits a comma-joined value into multiple sign rows sharing the same position, suffixed keys", () => {
    const rows = normalizeFeature(nodeFeature({ traffic_sign: "DE:260,DE:274-30" }, [13.377, 52.516]), silentLogger);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ key: "static-sign:node/456#0", row: { signType: "DE:260", lat: 52.516, lng: 13.377 } });
    expect(rows[1]).toMatchObject({ key: "static-sign:node/456#1", row: { signType: "DE:274-30", lat: 52.516, lng: 13.377 } });
  });

  it("uses the way's first vertex as the sign position for a way-level traffic_sign tag", () => {
    const rows = normalizeFeature(wayFeature({ highway: "primary", traffic_sign: "DE:274-50" }, [[13.377, 52.516], [13.4, 52.52]]), silentLogger);
    const sign = rows.find((r) => r.kind === "static-sign");
    expect(sign?.row).toMatchObject({ lat: 52.516, lng: 13.377 });
  });

  it("swaps [lng,lat] geometry into named lat/lng fields (the API wants separate fields here, unlike lineString)", () => {
    const rows = normalizeFeature(nodeFeature({ traffic_sign: "DE:274-50" }, [11.111, 48.888]), silentLogger);
    expect(rows[0]?.row).toMatchObject({ lat: 48.888, lng: 11.111 });
  });
});

describe("normalizeFeature — fixed-speed-camera", () => {
  it("emits a camera row for a node tagged highway=speed_camera", () => {
    const rows = normalizeFeature(nodeFeature({ highway: "speed_camera" }, [11.5, 48.1]), silentLogger);
    expect(rows).toEqual([{ kind: "fixed-speed-camera", key: "fixed-speed-camera:node/456", row: { lat: 48.1, lng: 11.5, source: "osm", sourceLicense: "ODbL" } }]);
  });

  it("does not emit a camera row for a way, even if somehow tagged highway=speed_camera", () => {
    const rows = normalizeFeature(wayFeature({ highway: "speed_camera" }), silentLogger);
    expect(rows.filter((r) => r.kind === "fixed-speed-camera")).toHaveLength(0);
  });
});

describe("normalizeFeature — combined tags on one element", () => {
  it("emits both a segment and a sign for one way carrying both maxspeed and traffic_sign", () => {
    const rows = normalizeFeature(wayFeature({ highway: "primary", maxspeed: "50", traffic_sign: "DE:274-50" }), silentLogger);
    expect(rows.map((r) => r.kind).sort()).toEqual(["speed-limit-segment", "static-sign"]);
  });
});

describe("normalizeFeature — missing/unexpected @type or @id", () => {
  it("skips a feature entirely when @type/@id are missing (osmium -a misconfiguration guard)", () => {
    const feature: OsmFeature = { type: "Feature", properties: { highway: "primary", maxspeed: "50" }, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } };
    expect(normalizeFeature(feature, silentLogger)).toEqual([]);
  });
});
