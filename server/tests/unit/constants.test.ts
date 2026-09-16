import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { hazardExpiryMs } from "../../src/config/constants.js";

const env = () => {
  resetEnvCache();
  return loadEnv({
    DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    JWT_SECRET: "a".repeat(32),
  });
};

describe("hazardExpiryMs", () => {
  it("bands mobileSpeedCamera/trailerCamera/redLightCamera/distanceControl as short", () => {
    const e = env();
    const short = e.HAZARD_EXPIRY_SHORT_MINUTES * 60_000;
    expect(hazardExpiryMs("mobileSpeedCamera", e)).toBe(short);
    expect(hazardExpiryMs("trailerCamera", e)).toBe(short);
    expect(hazardExpiryMs("redLightCamera", e)).toBe(short);
    expect(hazardExpiryMs("distanceControl", e)).toBe(short);
  });

  it("bands traffic/ice/accident/breakdown/obstacle as medium", () => {
    const e = env();
    const medium = e.HAZARD_EXPIRY_MEDIUM_MINUTES * 60_000;
    for (const type of ["traffic", "ice", "accident", "breakdown", "obstacle"] as const) {
      expect(hazardExpiryMs(type, e)).toBe(medium);
    }
  });

  it("bands construction as a multi-day duration", () => {
    const e = env();
    expect(hazardExpiryMs("construction", e)).toBe(e.HAZARD_EXPIRY_CONSTRUCTION_DAYS * 24 * 60 * 60_000);
  });

  it("respects overridden env values rather than hardcoded minutes", () => {
    resetEnvCache();
    const e = loadEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      JWT_SECRET: "a".repeat(32),
      HAZARD_EXPIRY_SHORT_MINUTES: "1",
    });
    expect(hazardExpiryMs("mobileSpeedCamera", e)).toBe(60_000);
  });
});
