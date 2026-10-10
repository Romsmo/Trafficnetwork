import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import {
  BUILTIN_REPORT_EXPIRY,
  ReportExpiryConfigError,
  checkRequestedExpiry,
  parseExpiryOverrides,
  resolveReportExpiry,
} from "../../src/config/report-expiry.js";
import { REPORTABLE_HAZARD_TYPES } from "../../src/config/constants.js";

const env = (extra: Record<string, string> = {}) => {
  resetEnvCache();
  return loadEnv({
    DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    JWT_SECRET: "a".repeat(32),
    ...extra,
  });
};

const HOUR = 3600;
const DAY = 24 * HOUR;

describe("report expiry rules: built-in defaults", () => {
  it("gives a mobile speed camera 3 hours and a trailer 14 days, not the short band they shared before", () => {
    const rules = resolveReportExpiry(env());
    expect(rules.mobileSpeedCamera.defaultSeconds).toBe(3 * HOUR);
    expect(rules.trailerCamera.defaultSeconds).toBe(14 * DAY);
  });

  it("leaves every other type as it was", () => {
    const rules = resolveReportExpiry(env());
    expect(rules.redLightCamera.defaultSeconds).toBe(12 * 60);
    expect(rules.distanceControl.defaultSeconds).toBe(12 * 60);
    for (const t of ["traffic", "ice", "accident", "breakdown", "obstacle"] as const) {
      expect(rules[t].defaultSeconds).toBe(25 * 60);
    }
    expect(rules.construction.defaultSeconds).toBe(7 * DAY);
  });

  it("covers every reportable type and none of them has a default outside its own bounds", () => {
    const rules = resolveReportExpiry(env());
    for (const t of REPORTABLE_HAZARD_TYPES) {
      const r = rules[t];
      expect(r, t).toBeDefined();
      expect(r.minSeconds, t).toBeGreaterThan(0);
      expect(r.minSeconds, t).toBeLessThanOrEqual(r.defaultSeconds);
      expect(r.defaultSeconds, t).toBeLessThanOrEqual(r.maxSeconds);
    }
    expect(BUILTIN_REPORT_EXPIRY).toEqual(rules);
  });
});

describe("report expiry rules: one source wins", () => {
  it("the legacy short-band variable now covers red-light and distance only: a .env copied from the old example (=12) must not shorten the mobile and trailer camera", () => {
    const rules = resolveReportExpiry(env({ HAZARD_EXPIRY_SHORT_MINUTES: "12" }));
    expect(rules.mobileSpeedCamera.defaultSeconds).toBe(3 * HOUR);
    expect(rules.trailerCamera.defaultSeconds).toBe(14 * DAY);
    const longer = resolveReportExpiry(env({ HAZARD_EXPIRY_SHORT_MINUTES: "20" }));
    expect(longer.redLightCamera.defaultSeconds).toBe(20 * 60);
    expect(longer.distanceControl.defaultSeconds).toBe(20 * 60);
  });

  it("the per-type variables set the mobile and trailer default", () => {
    const rules = resolveReportExpiry(
      env({ HAZARD_EXPIRY_SHORT_MINUTES: "20", HAZARD_EXPIRY_MOBILE_SPEED_CAMERA_MINUTES: "90", HAZARD_EXPIRY_TRAILER_CAMERA_DAYS: "5" }),
    );
    expect(rules.mobileSpeedCamera.defaultSeconds).toBe(90 * 60);
    expect(rules.trailerCamera.defaultSeconds).toBe(5 * DAY);
    expect(rules.redLightCamera.defaultSeconds).toBe(20 * 60);
  });

  it("the signed network configuration beats the node's own environment and reports the difference", () => {
    const e = env({ HAZARD_EXPIRY_MOBILE_SPEED_CAMERA_MINUTES: "90" });
    const warnings: string[] = [];
    const rules = resolveReportExpiry(e, { reportExpiry: { mobileSpeedCamera: { defaultSeconds: 2 * HOUR } } }, (m) => warnings.push(m));
    expect(rules.mobileSpeedCamera.defaultSeconds).toBe(2 * HOUR);
    expect(warnings.join("\n")).toMatch(/mobileSpeedCamera/);
  });

  it("an override can move bounds without moving the default", () => {
    const rules = resolveReportExpiry(env(), { reportExpiry: { mobileSpeedCamera: { maxSeconds: 6 * HOUR } } });
    expect(rules.mobileSpeedCamera.defaultSeconds).toBe(3 * HOUR);
    expect(rules.mobileSpeedCamera.maxSeconds).toBe(6 * HOUR);
  });

  it("REPORT_EXPIRY_OVERRIDES (JSON) is read at startup and a malformed value fails the start", () => {
    const rules = resolveReportExpiry(env({ REPORT_EXPIRY_OVERRIDES: JSON.stringify({ traffic: { defaultSeconds: 600 } }) }));
    expect(rules.traffic.defaultSeconds).toBe(600);
    expect(() => env({ REPORT_EXPIRY_OVERRIDES: "{not json" })).toThrow();
  });

  it("is the same result however often it is computed (pure)", () => {
    const e = env();
    const net = { reportExpiry: { trailerCamera: { defaultSeconds: 7 * DAY } } };
    expect(resolveReportExpiry(e, net)).toEqual(resolveReportExpiry(e, net));
  });
});

describe("report expiry overrides are refused when they cannot be understood completely", () => {
  it("unknown type", () => {
    expect(() => parseExpiryOverrides({ flyingSaucer: { defaultSeconds: 60 } }, "test")).toThrow(ReportExpiryConfigError);
  });
  it("fixedSpeedCamera has no expiry to set", () => {
    expect(() => parseExpiryOverrides({ fixedSpeedCamera: { defaultSeconds: 60 } }, "test")).toThrow(ReportExpiryConfigError);
  });
  it("unknown field, non-integer, zero, negative, beyond one year", () => {
    expect(() => parseExpiryOverrides({ traffic: { hours: 1 } }, "test")).toThrow(ReportExpiryConfigError);
    expect(() => parseExpiryOverrides({ traffic: { defaultSeconds: 1.5 } }, "test")).toThrow(ReportExpiryConfigError);
    expect(() => parseExpiryOverrides({ traffic: { defaultSeconds: 0 } }, "test")).toThrow(ReportExpiryConfigError);
    expect(() => parseExpiryOverrides({ traffic: { maxSeconds: -5 } }, "test")).toThrow(ReportExpiryConfigError);
    expect(() => parseExpiryOverrides({ traffic: { maxSeconds: 366 * DAY } }, "test")).toThrow(ReportExpiryConfigError);
  });
  it("min > default > max within one entry", () => {
    expect(() => parseExpiryOverrides({ traffic: { minSeconds: 600, defaultSeconds: 300 } }, "test")).toThrow(ReportExpiryConfigError);
    expect(() => parseExpiryOverrides({ traffic: { defaultSeconds: 900, maxSeconds: 600 } }, "test")).toThrow(ReportExpiryConfigError);
  });
  it("absent is fine", () => {
    expect(parseExpiryOverrides(undefined, "test")).toEqual({});
  });
});

describe("requested duration", () => {
  const rules = resolveReportExpiry(env());

  it("accepts the bounds themselves and anything between", () => {
    const r = rules.mobileSpeedCamera;
    expect(checkRequestedExpiry(rules, "mobileSpeedCamera", r.minSeconds)).toEqual({ ok: true, seconds: r.minSeconds });
    expect(checkRequestedExpiry(rules, "mobileSpeedCamera", r.maxSeconds)).toEqual({ ok: true, seconds: r.maxSeconds });
    expect(checkRequestedExpiry(rules, "mobileSpeedCamera", 2 * HOUR)).toEqual({ ok: true, seconds: 2 * HOUR });
  });

  it("returns the effective default when nothing is requested", () => {
    expect(checkRequestedExpiry(rules, "trailerCamera", undefined)).toEqual({ ok: true, seconds: 14 * DAY });
  });

  it("refuses outside the bounds and says what applies", () => {
    const r = rules.traffic;
    const tooShort = checkRequestedExpiry(rules, "traffic", r.minSeconds - 1);
    const tooLong = checkRequestedExpiry(rules, "traffic", r.maxSeconds + 1);
    for (const res of [tooShort, tooLong]) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.rule).toEqual(r);
    }
  });

  it("refuses non-integers and non-positive values", () => {
    expect(checkRequestedExpiry(rules, "traffic", 0).ok).toBe(false);
    expect(checkRequestedExpiry(rules, "traffic", -60).ok).toBe(false);
    expect(checkRequestedExpiry(rules, "traffic", 61.5).ok).toBe(false);
  });
});
