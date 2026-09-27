import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSignMapping } from "../../src/pipeline/nvdb/mapping.js";
import { codeOfVerdi, normalizeNvdbSign, parseNvdbPoint, type NvdbObject } from "../../src/pipeline/nvdb/normalize.js";

const FIXTURES = path.resolve(fileURLToPath(import.meta.url), "../../fixtures/nvdb-no");
const json = <T>(name: string): T => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as T;

/** Everything below runs on REAL API responses (fetched 2026-09-26): the whole municipality Utsira, the first two pages of Oslo. */
const utsira = json<{ objekter: NvdbObject[] }>("signs-1151-page1.json").objekter;
const oslo1 = json<{ objekter: NvdbObject[] }>("signs-0301-page1.json").objekter;
const oslo2 = json<{ objekter: NvdbObject[] }>("signs-0301-page2.json").objekter;
const definition = json<{ egenskapstyper: { tillatte_verdier: { id: number; kortnavn: string; verdi: string }[] }[] }>("type96-skiltnummer-excerpt.json");
const enumEntries = definition.egenskapstyper[0]!.tillatte_verdier;

const mapping = loadSignMapping();
const enumCodes = new Map(enumEntries.map((e) => [e.id, codeOfVerdi(e.verdi)!]));
const context = { mapping, enumCodes };

function summarize(objects: NvdbObject[]) {
  const rows: { key: string; row: Record<string, unknown> }[] = [];
  const skipped: Record<string, number> = {};
  for (const object of objects) {
    const result = normalizeNvdbSign(object, context);
    if ("skip" in result) skipped[result.skip] = (skipped[result.skip] ?? 0) + 1;
    else rows.push({ key: result.row.key, row: result.row.row as unknown as Record<string, unknown> });
  }
  return { rows, skipped };
}

describe("codeOfVerdi", () => {
  it("takes the first word of the enum text", () => {
    expect(codeOfVerdi("362.50 - Fartsgrense 50 km/t")).toBe("362.50");
    expect(codeOfVerdi("202 - Vikeplikt")).toBe("202");
    expect(codeOfVerdi("U999 -")).toBe("U999"); // a real entry with an empty description
    expect(codeOfVerdi("  U544 - Tettbygd strøk")).toBe("U544");
    expect(codeOfVerdi("")).toBeUndefined();
    expect(codeOfVerdi("-")).toBeUndefined();
  });

  it("does not trust the enum's kortnavn: it is truncated for two real entries", () => {
    const truncated = enumEntries.find((e) => e.kortnavn === "711.V13");
    expect(truncated?.verdi).toMatch(/^711\.V135 - /); // the real data: kortnavn "711.V13", text "711.V135 - Tabellvegviser, Venstre, 135 grader"
    expect(codeOfVerdi(truncated!.verdi)).toBe("711.V135");
  });
});

describe("parseNvdbPoint — the API writes latitude first", () => {
  it("reads both real WKT shapes: with and without height", () => {
    expect(parseNvdbPoint("POINT(59.98008659 10.92784282)")).toEqual({ lat: 59.98008659, lng: 10.92784282 });
    expect(parseNvdbPoint("POINT Z (59.91811301 10.68632441 -999999)")).toEqual({ lat: 59.91811301, lng: 10.68632441 }); // -999999 = height unknown
    expect(parseNvdbPoint("POINT Z (62.00263781 7.37336944 936.03621141)")).toEqual({ lat: 62.00263781, lng: 7.37336944 });
  });

  it("refuses a position written the other way round instead of importing it mirrored", () => {
    expect(parseNvdbPoint("POINT(10.92784282 59.98008659)")).toEqual({ problem: "coordinates outside the plausible range for Norway (axis order changed?)" });
  });

  it("refuses positions outside Norway, other geometries and missing geometry", () => {
    expect(parseNvdbPoint("POINT(48.1 11.5)")).toMatchObject({ problem: expect.stringContaining("outside the plausible range") }); // Munich
    expect(parseNvdbPoint("LINESTRING(59 10, 60 11)")).toEqual({ problem: "geometry is not a POINT" });
    expect(parseNvdbPoint(undefined)).toEqual({ problem: "no geometry" });
  });
});

describe("normalizeNvdbSign on real objects", () => {
  it("turns a speed-limit plate into a static sign with country-prefixed code and full provenance", () => {
    const plate = oslo1.find((o) => o.id === 86558499)!;
    expect(normalizeNvdbSign(plate, context)).toEqual({
      passedThrough: false,
      row: {
        kind: "static-sign",
        key: "static-sign:nvdb-no/96/86558499",
        row: { lat: 59.87012973, lng: 10.82865387, signType: "NO:362.80", source: "nvdb-no", sourceLicense: "NLOD" },
      },
    });
  });

  it("Utsira (a whole municipality): 32 plates, the 13 warning/prohibitory ones imported, the rest counted by reason", () => {
    const { rows, skipped } = summarize(utsira);
    expect(rows).toHaveLength(13);
    expect(skipped).toEqual({
      "series 6 not imported (service signs)": 2,
      "series 7 not imported (direction and wayfinding signs)": 10,
      "series 8 not imported (supplementary plates and text plates)": 4,
      "series 9 not imported (markers and delineation)": 3,
    });
    const first = rows.find((r) => r.key === "static-sign:nvdb-no/96/142101712")!;
    expect(first.row).toMatchObject({ lat: 59.29755475, lng: 4.89153005, signType: "NO:366" });
  });

  it("Oslo excerpt: 8 of the first 30 and 14 of the next 30 plates are imported", () => {
    expect(summarize(oslo1).rows).toHaveLength(8);
    expect(summarize(oslo2).rows).toHaveLength(14);
    expect(summarize(oslo1).skipped).toEqual({
      "series 5 not imported (information signs)": 4,
      "series 7 not imported (direction and wayfinding signs)": 13,
      "series 8 not imported (supplementary plates and text plates)": 2,
      "series 9 not imported (markers and delineation)": 3,
    });
  });

  it("every plate keeps its own key — two plates on one post are two rows", () => {
    const keys = [...summarize(utsira).rows, ...summarize(oslo1).rows, ...summarize(oslo2).rows].map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    // 86558543 (202) and 86558542 (406) hang at the same position
    const a = oslo1.find((o) => o.id === 86558543)!;
    const b = oslo1.find((o) => o.id === 86558542)!;
    expect(a.geometri?.wkt).toBe(b.geometri?.wkt);
    expect(keys).toContain("static-sign:nvdb-no/96/86558543");
    expect(keys).toContain("static-sign:nvdb-no/96/86558542");
  });

  it("falls back to the text of the object when the enum id is not in the definition", () => {
    const plate = oslo1.find((o) => o.id === 86558499)!;
    const result = normalizeNvdbSign(plate, { mapping, enumCodes: new Map() });
    expect("row" in result && result.row.row).toMatchObject({ signType: "NO:362.80" });
  });

  it("skips, with a reason, a plate without Skiltnummer, without id, or without a usable position", () => {
    const plate = oslo1.find((o) => o.id === 86558499)!;
    expect(normalizeNvdbSign({ ...plate, egenskaper: [] }, context)).toEqual({ skip: "no Skiltnummer" });
    expect(normalizeNvdbSign({ ...plate, id: undefined }, context)).toEqual({ skip: "object without a numeric id" });
    expect(normalizeNvdbSign({ ...plate, geometri: {} }, context)).toEqual({ skip: "no geometry" });
  });
});
