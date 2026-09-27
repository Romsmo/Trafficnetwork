import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSignMapping, mapSignCode, type SignMapping } from "../../src/pipeline/nvdb/mapping.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the shipped Norwegian sign mapping (config/sign-mappings/no.json)", () => {
  const mapping = loadSignMapping();

  it("carries the provenance every imported row needs", () => {
    expect(mapping).toMatchObject({ country: "NO", source: "nvdb-no", sourceLicense: "NLOD", codePrefix: "NO:" });
  });

  it("imports warning, priority, prohibitory (incl. speed limits) and mandatory signs, verbatim behind the country prefix", () => {
    for (const code of ["146.1", "112", "202", "204", "362.50", "362.80", "370", "402.2", "408"]) {
      expect(mapSignCode(code, mapping), code).toEqual({ signType: `NO:${code}`, passedThrough: false });
    }
  });

  it("does not import information, service, wayfinding, supplementary or marker signs — and says which series it left out", () => {
    expect(mapSignCode("552", mapping)).toEqual({ skip: "series 5 not imported (information signs)" });
    expect(mapSignCode("602", mapping)).toEqual({ skip: "series 6 not imported (service signs)" });
    expect(mapSignCode("711.V90", mapping)).toEqual({ skip: "series 7 not imported (direction and wayfinding signs)" });
    expect(mapSignCode("808.101", mapping)).toEqual({ skip: "series 8 not imported (supplementary plates and text plates)" });
    expect(mapSignCode("902V", mapping)).toEqual({ skip: "series 9 not imported (markers and delineation)" });
  });

  it("reads the U prefix of withdrawn / unofficial codes as part of the code, and applies the series of the digits", () => {
    expect(mapSignCode("U324", mapping)).toEqual({ signType: "NO:U324", passedThrough: false }); // 3xx: imported, kept as written
    expect(mapSignCode("U544", mapping)).toEqual({ skip: "series 5 not imported (information signs)" });
  });

  it("passes a code it cannot place through unchanged instead of discarding it", () => {
    expect(mapSignCode("X-42", mapping)).toEqual({ signType: "NO:X-42", passedThrough: true }); // no series digits at all
    expect(mapSignCode("07", mapping)).toEqual({ signType: "NO:07", passedThrough: true });
  });
});

describe("mapSignCode — exact-code overrides and unknown series", () => {
  const base = loadSignMapping();
  const withOverrides = (codes: SignMapping["codes"], series: SignMapping["series"] = base.series): SignMapping => ({ ...base, series, codes });

  it("an override beats the series decision, both ways", () => {
    const m = withOverrides({ "552": { import: true }, "362.50": { import: false, reason: "test" } });
    expect(mapSignCode("552", m)).toEqual({ signType: "NO:552", passedThrough: false });
    expect(mapSignCode("362.50", m)).toEqual({ skip: "code 362.50 excluded by the mapping table (test)" });
    expect(mapSignCode("362.60", m)).toEqual({ signType: "NO:362.60", passedThrough: false });
  });

  it("a series the table does not list is passed through, not dropped", () => {
    const m = withOverrides({}, { "1": base.series["1"]! });
    expect(mapSignCode("552", m)).toEqual({ signType: "NO:552", passedThrough: true });
  });
});

describe("loadSignMapping validation", () => {
  it("names the file and the broken field", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-mapping-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "xx.json");
    fs.writeFileSync(file, JSON.stringify({ country: "XX", source: "s", sourceLicense: "L", codePrefix: "XX", codeSystem: "c", seriesPattern: "^(\\d)", series: {}, codes: {} }));
    expect(() => loadSignMapping(file)).toThrow(/Invalid sign mapping at .*xx\.json[\s\S]*codePrefix/);
  });
});
