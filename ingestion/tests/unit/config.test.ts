import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { loadRegions, resolveRegion } from "../../src/config/regions.js";
import { resolveSources } from "../../src/config/sources.js";

const baseEnv = {
  SERVER_URL: "http://localhost:3000",
  CLIENT_ID: "client-1",
  CLIENT_SECRET: "secret",
};

describe("loadEnv", () => {
  it("loads with defaults when only the required fields are set", () => {
    resetEnvCache();
    const env = loadEnv({ ...baseEnv });
    expect(env.OSM_ENABLED).toBe(true);
    expect(env.HERE_ENABLED).toBe(false);
    expect(env.BATCH_SIZE).toBe(2000);
  });

  it("rejects a batch size above the server's hard cap", () => {
    resetEnvCache();
    expect(() => loadEnv({ ...baseEnv, BATCH_SIZE: "5001" })).toThrow();
  });

  it("requires HERE_MONTHLY_CALL_LIMIT when HERE_ENABLED=true, with no default", () => {
    resetEnvCache();
    expect(() => loadEnv({ ...baseEnv, HERE_ENABLED: "true" })).toThrow(/HERE_MONTHLY_CALL_LIMIT/);
  });

  it("accepts HERE_ENABLED=true once a call limit is provided", () => {
    resetEnvCache();
    const env = loadEnv({ ...baseEnv, HERE_ENABLED: "true", HERE_MONTHLY_CALL_LIMIT: "10000" });
    expect(env.HERE_ENABLED).toBe(true);
    expect(env.HERE_MONTHLY_CALL_LIMIT).toBe(10_000);
  });

  it("requires TOMTOM_MONTHLY_CALL_LIMIT when TOMTOM_ENABLED=true, with no default", () => {
    resetEnvCache();
    expect(() => loadEnv({ ...baseEnv, TOMTOM_ENABLED: "true" })).toThrow(/TOMTOM_MONTHLY_CALL_LIMIT/);
  });
});

describe("resolveSources", () => {
  it("only sets a killSwitch for enabled metered sources", () => {
    resetEnvCache();
    const env = loadEnv({ ...baseEnv, HERE_ENABLED: "true", HERE_MONTHLY_CALL_LIMIT: "5000" });
    const sources = resolveSources(env);
    expect(sources.here.killSwitch).toEqual({ maxCalls: 5000 });
    expect(sources.tomtom.killSwitch).toBeUndefined();
    expect(sources.osm.killSwitch).toBeUndefined();
    expect(sources.mobilithek.killSwitch).toBeUndefined();
    expect(sources["autobahn-api"].killSwitch).toBeUndefined();
  });
});

describe("loadRegions / resolveRegion", () => {
  const regionsPath = path.resolve(fileURLToPath(import.meta.url), "../../../config/regions.json");

  it("loads the checked-in region catalog and resolves each configured region", () => {
    const regions = loadRegions(regionsPath);
    for (const id of ["bayern", "germany", "europe"]) {
      const region = resolveRegion(regions, id);
      expect(region.geofabrikExtractUrl).toMatch(/^https:\/\/download\.geofabrik\.de\//);
      expect(region.bbox).toHaveLength(4);
    }
  });

  it("throws a clear error for an unknown region id", () => {
    const regions = loadRegions(regionsPath);
    expect(() => resolveRegion(regions, "atlantis")).toThrow(/Unknown region "atlantis"/);
  });
});
