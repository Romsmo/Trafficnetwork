import { describe, expect, it } from "vitest";
import { validateRow } from "../../src/pipeline/validate.js";
import type { NormalizedRow } from "../../src/pipeline/worker.js";

function segment(overrides: Partial<Extract<NormalizedRow, { kind: "speed-limit-segment" }>["row"]> = {}): NormalizedRow {
  return {
    kind: "speed-limit-segment",
    key: "speed-limit-segment:way/1",
    row: { lineString: [[11, 48], [11.1, 48.1]], speedLimit: 50, speedLimitUnit: "kmh", source: "osm", sourceLicense: "ODbL", ...overrides },
  };
}

describe("validateRow", () => {
  it("accepts ordinary rows", () => {
    expect(validateRow(segment())).toBeUndefined();
    expect(validateRow(segment({ speedLimit: 70, speedLimitUnit: "mph" }))).toBeUndefined();
    expect(validateRow({ kind: "static-sign", key: "static-sign:node/1", row: { lat: 48, lng: 11, signType: "DE:274-50", source: "osm" } })).toBeUndefined();
    expect(validateRow({ kind: "fixed-speed-camera", key: "fixed-speed-camera:node/1", row: { lat: 48, lng: 11, source: "osm" } })).toBeUndefined();
  });

  it("mirrors the server's schema (positive limit, ≥2 points, coordinate ranges)", () => {
    expect(validateRow(segment({ speedLimit: 0 }))).toMatch(/positive/);
    expect(validateRow(segment({ speedLimit: -5 }))).toMatch(/positive/);
    expect(validateRow(segment({ speedLimit: Number.NaN }))).toMatch(/positive/);
    expect(validateRow(segment({ lineString: [[11, 48]] }))).toMatch(/fewer than 2/);
    expect(validateRow(segment({ lineString: [[11, 48], [181, 48]] }))).toMatch(/outside/);
    expect(validateRow(segment({ lineString: [[11, 48], [11, 91]] }))).toMatch(/outside/);
    expect(validateRow({ kind: "static-sign", key: "static-sign:node/1", row: { lat: 91, lng: 11, signType: "x", source: "osm" } })).toMatch(/outside/);
    expect(validateRow({ kind: "static-sign", key: "static-sign:node/1", row: { lat: 48, lng: 11, signType: "", source: "osm" } })).toMatch(/signType/);
    expect(validateRow({ kind: "fixed-speed-camera", key: "fixed-speed-camera:node/1", row: { lat: 48, lng: 200, source: "osm" } })).toMatch(/outside/);
  });

  it("quarantines implausible limits (a typo like maxspeed=500) that the server would happily store", () => {
    expect(validateRow(segment({ speedLimit: 500 }))).toMatch(/implausible/);
    expect(validateRow(segment({ speedLimit: 200 }))).toBeUndefined();
    expect(validateRow(segment({ speedLimit: 130, speedLimitUnit: "mph" }))).toMatch(/implausible/);
  });
});
