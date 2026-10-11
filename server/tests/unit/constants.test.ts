import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { resolveReportExpiry } from "../../src/config/report-expiry.js";

const env = (extra: Record<string, string> = {}) => {
  resetEnvCache();
  return loadEnv({
    DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    JWT_SECRET: "a".repeat(32),
    ...extra,
  });
};

// The rules themselves (built-in table, precedence, bounds) are tested in report-expiry.test.ts; this file keeps the
// environment-variable contract that existed before the table: the band variables still mean what they meant.
describe("report expiry from the legacy band environment variables", () => {
  it("medium band (traffic/ice/accident/breakdown/obstacle) follows HAZARD_EXPIRY_MEDIUM_MINUTES", () => {
    const e = env();
    const rules = resolveReportExpiry(e);
    for (const type of ["traffic", "ice", "accident", "breakdown", "obstacle"] as const) {
      expect(rules[type].defaultSeconds).toBe(e.HAZARD_EXPIRY_MEDIUM_MINUTES * 60);
    }
  });

  it("construction follows HAZARD_EXPIRY_CONSTRUCTION_DAYS", () => {
    const e = env();
    expect(resolveReportExpiry(e).construction.defaultSeconds).toBe(e.HAZARD_EXPIRY_CONSTRUCTION_DAYS * 24 * 60 * 60);
  });

  it("HAZARD_EXPIRY_SHORT_MINUTES applies to the red-light and distance reports", () => {
    const rules = resolveReportExpiry(env({ HAZARD_EXPIRY_SHORT_MINUTES: "1" }));
    expect(rules.redLightCamera.defaultSeconds).toBe(60);
    expect(rules.distanceControl.defaultSeconds).toBe(60);
  });

  it("an empty value counts as unset", () => {
    const rules = resolveReportExpiry(env({ HAZARD_EXPIRY_SHORT_MINUTES: "", HAZARD_EXPIRY_MOBILE_SPEED_CAMERA_MINUTES: "" }));
    expect(rules.mobileSpeedCamera.defaultSeconds).toBe(3 * 3600);
    expect(rules.redLightCamera.defaultSeconds).toBe(12 * 60);
  });
});
