import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { validatePlausibility } from "../../src/modules/moderation/plausibility.js";
import { ApiError } from "../../src/lib/errors.js";

const env = () => {
  resetEnvCache();
  return loadEnv({
    DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    JWT_SECRET: "a".repeat(32),
  });
};

describe("validatePlausibility", () => {
  it("accepts a plain traffic report with no speedKmh", () => {
    expect(() => validatePlausibility({ type: "traffic", lat: 52.5, lng: 13.4 }, env())).not.toThrow();
  });

  it("rejects fixedSpeedCamera (not yet routed until milestone P1.4)", () => {
    expect(() => validatePlausibility({ type: "fixedSpeedCamera", lat: 52.5, lng: 13.4 }, env())).toThrow(ApiError);
  });

  it("rejects position (0, 0) as null island", () => {
    expect(() => validatePlausibility({ type: "traffic", lat: 0, lng: 0 }, env())).toThrow(/null island/);
  });

  it("rejects speedKmh on a type that doesn't take one", () => {
    expect(() => validatePlausibility({ type: "traffic", lat: 52.5, lng: 13.4, speedKmh: 50 }, env())).toThrow(
      /not applicable/,
    );
  });

  it("accepts speedKmh within range for mobileSpeedCamera", () => {
    expect(() =>
      validatePlausibility({ type: "mobileSpeedCamera", lat: 52.5, lng: 13.4, speedKmh: 80 }, env()),
    ).not.toThrow();
  });

  it("rejects speedKmh outside the configured range", () => {
    const e = env();
    expect(() =>
      validatePlausibility({ type: "mobileSpeedCamera", lat: 52.5, lng: 13.4, speedKmh: e.SPEED_KMH_MAX + 1 }, e),
    ).toThrow(/between/);
  });

  it("accepts speedKmh for trailerCamera too", () => {
    expect(() =>
      validatePlausibility({ type: "trailerCamera", lat: 52.5, lng: 13.4, speedKmh: 60 }, env()),
    ).not.toThrow();
  });
});
