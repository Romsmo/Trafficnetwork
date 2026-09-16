import { describe, expect, it } from "vitest";
import { isCameraType, resolveSyncHazardTypes } from "../../src/modules/cameras/filter.js";
import { HAZARD_TYPES, NON_CAMERA_HAZARD_TYPES } from "../../src/config/constants.js";

describe("isCameraType", () => {
  it("is true for all five camera-adjacent types", () => {
    for (const t of ["fixedSpeedCamera", "mobileSpeedCamera", "trailerCamera", "redLightCamera", "distanceControl"] as const) {
      expect(isCameraType(t)).toBe(true);
    }
  });

  it("is false for ordinary hazard types", () => {
    for (const t of ["traffic", "ice", "accident", "construction", "breakdown", "obstacle"] as const) {
      expect(isCameraType(t)).toBe(false);
    }
  });
});

describe("resolveSyncHazardTypes", () => {
  it("defaults to non-camera types when nothing requested and the flag is off", () => {
    expect(resolveSyncHazardTypes(undefined, false).sort()).toEqual([...NON_CAMERA_HAZARD_TYPES].sort());
  });

  it("defaults to every hazard type (including fixedSpeedCamera) when nothing requested and the flag is on", () => {
    expect(resolveSyncHazardTypes(undefined, true).sort()).toEqual([...HAZARD_TYPES].sort());
  });

  it("strips camera types from an explicit request when the flag is off", () => {
    expect(resolveSyncHazardTypes(["traffic", "mobileSpeedCamera"], false)).toEqual(["traffic"]);
  });

  it("falls back to the full non-camera default if the request is only camera types and the flag is off", () => {
    expect(resolveSyncHazardTypes(["mobileSpeedCamera"], false).sort()).toEqual([...NON_CAMERA_HAZARD_TYPES].sort());
  });

  it("keeps an explicit camera type when the flag is on", () => {
    expect(resolveSyncHazardTypes(["mobileSpeedCamera"], true)).toEqual(["mobileSpeedCamera"]);
  });
});
