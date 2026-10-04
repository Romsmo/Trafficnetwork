import { describe, expect, it } from "vitest";
import { diffPolicies, type StoredCameraPolicy } from "../../src/modules/cameras/policy/sync.js";

const policy = (over: Partial<StoredCameraPolicy> = {}): StoredCameraPolicy => ({
  defaultLevel: "full",
  unknownLevel: "full",
  byCountry: {},
  zoneResolution: 6,
  ...over,
});

const none = { countries: [], all: false, unknown: false };

describe("diffPolicies - which package tiles a policy change touches", () => {
  it("finds nothing in a change that changes nothing", () => {
    expect(diffPolicies(policy({ byCountry: { CH: "off" }, unknownLevel: "off" }), policy({ byCountry: { CH: "off" }, unknownLevel: "off" }))).toEqual({ tightened: none, loosened: none });
  });

  it("tells a restriction (stricter: its tiles must not be served until rebuilt) from a lifted one (more generous: only dirty)", () => {
    const restricted = diffPolicies(policy(), policy({ byCountry: { CH: "off", FR: "zones" }, unknownLevel: "off" }));
    expect(restricted.tightened).toEqual({ countries: ["CH", "FR"], all: false, unknown: true });
    expect(restricted.loosened).toEqual(none);

    const lifted = diffPolicies(policy({ byCountry: { CH: "off", FR: "zones" }, unknownLevel: "off" }), policy({ byCountry: { CH: "off" }, unknownLevel: "off" }));
    expect(lifted.loosened).toEqual({ countries: ["FR"], all: false, unknown: false });
    expect(lifted.tightened).toEqual(none);
  });

  it("a country that moves between two restrictions is tightened or loosened by direction", () => {
    expect(diffPolicies(policy({ byCountry: { CH: "zones" } }), policy({ byCountry: { CH: "off" } })).tightened.countries).toEqual(["CH"]);
    expect(diffPolicies(policy({ byCountry: { CH: "off" } }), policy({ byCountry: { CH: "zones" } })).loosened.countries).toEqual(["CH"]);
  });

  it("the default level touches every country: pulling the brake is tightened, releasing it loosened", () => {
    expect(diffPolicies(policy(), policy({ defaultLevel: "off", unknownLevel: "off" })).tightened).toMatchObject({ all: true, unknown: true });
    expect(diffPolicies(policy({ defaultLevel: "off", unknownLevel: "off" }), policy()).loosened).toMatchObject({ all: true, unknown: true });
  });

  it("the first sync is measured against 'nothing was delivered': whatever is delivered now is new, never stale", () => {
    const first = diffPolicies(policy({ defaultLevel: "off", unknownLevel: "off" }), policy({ byCountry: { CH: "off" }, unknownLevel: "off" }));
    expect(first.tightened).toEqual(none);
    expect(first.loosened.all).toBe(true);
  });

  it("another zone size makes everything stale: every zone is a different cell", () => {
    expect(diffPolicies(policy(), policy({ zoneResolution: 7 })).tightened.all).toBe(true);
  });
});
