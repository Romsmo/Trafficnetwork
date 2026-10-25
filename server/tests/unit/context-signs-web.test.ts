import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allSignTypes, signInfo } from "../../src/modules/context-signs/catalog.js";
import { CATALOG, describeValidity, formatDays, signName } from "../../web/public/assets/js/context-signs-data.js";
import deDict from "../../web/public/assets/i18n/de.js";
import enDict from "../../web/public/assets/i18n/en.js";

const de: Record<string, string> = deDict;
const en: Record<string, string> = enDict;
import { createTranslator } from "../../web/public/assets/js/i18n.js";

const read = (file: string) => readFileSync(new URL(`../../web/public/assets/js/${file}`, import.meta.url), "utf8");

describe("the page's sign catalogue agrees with the server's", () => {
  it("has the same 58 signs in the same order, with the same properties", () => {
    expect(CATALOG.map((s) => s.code)).toEqual(allSignTypes());
    for (const sign of CATALOG) {
      const server = signInfo(sign.code)!;
      expect(sign.kind, sign.code).toBe(server.class);
      expect(sign.pointLike, sign.code).toBe(server.pointLike);
      expect(sign.maxPeriodDays, sign.code).toBe(server.maxPeriodDays);
      if (server.value) expect(sign.value, sign.code).toEqual({ unit: server.value.unit, required: server.value.required, min: server.value.min, max: server.value.max });
      else expect(sign.value, sign.code).toBeNull();
      expect(sign.de?.length ?? 0, sign.code).toBeGreaterThan(2);
      expect(sign.en?.length ?? 0, sign.code).toBeGreaterThan(2);
    }
  });

  it("names a sign in both languages, and shows an unknown code as itself", () => {
    expect(signName("DE:276", "de")).toBe("Überholverbot für Kraftfahrzeuge aller Art");
    expect(signName("DE:276", "en")).toBe("No overtaking");
    expect(signName("FR:999", "de")).toBe("FR:999");
  });
});

describe("the page's texts", () => {
  it("has every signs.* text the page asks for, in German and English", () => {
    const sources = ["context-sign-dialog.js", "context-signs-layer.js", "context-signs-data.js", "map-page.js"].map(read).join("\n");
    const keys = new Set([...sources.matchAll(/["`](signs\.[A-Za-z0-9_.\-]+)["`]/g)].map((m) => m[1]!));
    expect(keys.size).toBeGreaterThan(60);
    const missing: string[] = [];
    for (const key of keys) {
      for (const [name, dict] of [["de", de], ["en", en]] as const) {
        const present = key in dict || `${key}_one` in dict;
        if (!present) missing.push(`${name}:${key}`);
      }
    }
    expect(missing).toEqual([]);
    for (const day of [1, 2, 3, 4, 5, 6, 7]) expect(de[`signs.day.${day}`]).toBeTruthy();
  });

  it("has a text for every compass direction and every error code the node can answer", () => {
    const codes = ["NO_ROAD_DATA", "NO_ROAD_FOUND", "NO_ROAD_BETWEEN_POINTS", "INTERVAL_TOO_LONG", "INTERVAL_TOO_SHORT", "STRETCH_TOO_LONG", "SIGN_NEEDS_TWO_POINTS", "HEADING_REQUIRED", "VALUE_REQUIRED", "INVALID_VALUE", "INVALID_TIMEZONE", "INVALID_WINDOW", "INVALID_PERIOD", "PERIOD_REQUIRED", "PERIOD_TOO_LONG", "SHAPE_OFF_ROAD", "UNKNOWN_SIGN"];
    for (const code of codes) {
      expect(de[`signs.error.${code}`], code).toBeTruthy();
      expect(en[`signs.error.${code}`], code).toBeTruthy();
    }
    for (const name of ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]) {
      expect(de[`signs.heading.${name}`], name).toBeTruthy();
      expect(en[`signs.heading.${name}`], name).toBeTruthy();
    }
    // the same set of signs.* keys in both languages
    const keysOf = (dict: Record<string, string>) => Object.keys(dict).filter((k) => k.startsWith("signs.")).sort();
    expect(keysOf(en)).toEqual(keysOf(de));
  });
});

describe("validity in words", () => {
  const tde = createTranslator("de").t;
  const ten = createTranslator("en").t;
  it("joins consecutive weekdays", () => {
    const name = (n: number) => tde(`signs.day.${n}`);
    expect(formatDays([1, 2, 3, 4, 5], name)).toBe("Mo–Fr");
    expect(formatDays([6, 7], name)).toBe("Sa, So");
    expect(formatDays([1, 3, 4, 5, 7], name)).toBe("Mo, Mi–Fr, So");
    expect(formatDays([5, 1, 1, 2], name)).toBe("Mo, Di, Fr");
  });

  it("says always, windows with the local-time note, and periods", () => {
    expect(describeValidity({ v: 1, tz: "Europe/Berlin" }, tde, "de")).toBe("immer");
    expect(describeValidity({ v: 1, tz: "Europe/Berlin", windows: [{ days: [1, 2, 3, 4, 5], from: "07:00", to: "17:00" }] }, tde, "de")).toBe("Mo–Fr 07:00–17:00 (Ortszeit)");
    expect(describeValidity({ v: 1, tz: "Europe/Berlin", period: { from: "2026-10-01", to: "2026-11-30" } }, tde, "de")).toBe("vom 01.10.2026 bis 30.11.2026");
    expect(describeValidity({ v: 1, tz: "Europe/Berlin", period: { from: "2026-10-01", to: null } }, ten, "en")).toBe("from 2026-10-01, until revoked");
    expect(describeValidity({ v: 1, tz: "Europe/Berlin", windows: [{ days: [5], from: "22:00", to: "06:00" }], period: { from: "2026-10-01", to: "2026-10-31" } }, ten, "en")).toBe("Fri 22:00–06:00; from 2026-10-01 to 2026-10-31 (local time)");
  });
});
