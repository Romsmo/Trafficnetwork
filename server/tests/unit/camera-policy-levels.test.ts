import { describe, expect, it } from "vitest";
import {
  CameraPolicyError,
  capFor,
  parseCountryLevels,
  parseLocalCaps,
  stricter,
  strictest,
  MAX_POLICY_COUNTRIES,
} from "../../src/modules/cameras/policy/levels.js";

describe("camera policy levels", () => {
  it("orders off < zones < full and 'stricter' means smaller", () => {
    expect(stricter("full", "zones")).toBe("zones");
    expect(stricter("zones", "full")).toBe("zones");
    expect(stricter("off", "full")).toBe("off");
    expect(stricter("full", "full")).toBe("full");
    expect(strictest(["full", "zones", "full"])).toBe("zones");
    expect(strictest(["full", "off"])).toBe("off");
  });

  it("nothing known is off: the strictest of no levels", () => {
    expect(strictest([])).toBe("off");
  });
});

describe("parseCountryLevels (the signed cameraPolicyByCountry)", () => {
  it("treats an absent field as no country released", () => {
    expect(parseCountryLevels(undefined)).toEqual({});
    expect(parseCountryLevels(null)).toEqual({});
    expect(parseCountryLevels({})).toEqual({});
  });

  it("accepts upper-case alpha-2 codes with the three levels", () => {
    expect(parseCountryLevels({ DE: "full", FR: "zones", CH: "off" })).toEqual({ DE: "full", FR: "zones", CH: "off" });
  });

  it.each([
    ["lower-case code", { de: "full" }],
    ["three-letter code", { DEU: "full" }],
    ["one-letter code", { D: "full" }],
    ["unknown level", { DE: "everything" }],
    ["a number as level", { DE: 1 }],
    ["an array", ["DE"]],
    ["a string", "DE=full"],
  ])("refuses a policy it cannot understand completely (%s) instead of applying part of it", (_label, input) => {
    expect(() => parseCountryLevels(input)).toThrow(CameraPolicyError);
  });

  it("refuses an implausibly long list", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_POLICY_COUNTRIES + 1; i++) many[String.fromCharCode(65 + Math.floor(i / 26) % 26) + String.fromCharCode(65 + (i % 26))] = "off";
    // 26*26 = 676 distinct codes are available, so the list really is longer than the limit
    expect(Object.keys(many).length).toBeGreaterThan(MAX_POLICY_COUNTRIES);
    expect(() => parseCountryLevels(many)).toThrow(CameraPolicyError);
  });
});

describe("parseLocalCaps (CAMERA_POLICY_LOCAL_CAPS)", () => {
  it("is empty by default: no cap", () => {
    const caps = parseLocalCaps("");
    expect(capFor(caps, "DE")).toBe("full");
  });

  it("applies per-country caps and a * fallback", () => {
    const caps = parseLocalCaps("DE=zones, CH=off, *=full");
    expect(capFor(caps, "DE")).toBe("zones");
    expect(capFor(caps, "CH")).toBe("off");
    expect(capFor(caps, "FR")).toBe("full");
    expect(capFor(parseLocalCaps("*=zones"), "FR")).toBe("zones");
  });

  it.each(["DE", "DE=", "de=zones", "DE=maybe", "DE=zones=full", "=zones"])("rejects %j", (spec) => {
    expect(() => parseLocalCaps(spec)).toThrow(CameraPolicyError);
  });
});
