import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";

const validEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  JWT_SECRET: "a".repeat(32),
};

describe("loadEnv", () => {
  it("applies documented defaults when optional vars are omitted", () => {
    resetEnvCache();
    const env = loadEnv(validEnv);
    expect(env.PORT).toBe(3000);
    expect(env.SPEED_CAMERA_NAMESPACE_ENABLED).toBe(false);
    expect(env.EVENT_LOG_RETENTION_DAYS_DYNAMIC).toBe(3);
    expect(env.EVENT_LOG_RETENTION_DAYS_STATIC).toBe(30);
    expect(env.REGION_TILE_H3_RESOLUTION).toBe(7);
  });

  it("rejects a missing DATABASE_URL", () => {
    resetEnvCache();
    expect(() => loadEnv({ JWT_SECRET: "a".repeat(32) })).toThrow(/DATABASE_URL/);
  });

  it("rejects a JWT_SECRET shorter than 16 characters", () => {
    resetEnvCache();
    expect(() =>
      loadEnv({ DATABASE_URL: validEnv.DATABASE_URL, JWT_SECRET: "short" }),
    ).toThrow(/JWT_SECRET/);
  });

  it("coerces the camera-namespace flag from the literal string \"true\"", () => {
    resetEnvCache();
    const env = loadEnv({ ...validEnv, SPEED_CAMERA_NAMESPACE_ENABLED: "true" });
    expect(env.SPEED_CAMERA_NAMESPACE_ENABLED).toBe(true);
  });

  it("caches the first parsed result across calls until resetEnvCache()", () => {
    resetEnvCache();
    loadEnv(validEnv);
    const second = loadEnv({ ...validEnv, PORT: "9999" });
    expect(second.PORT).toBe(3000);
  });

  it("defaults FEDERATION_ENABLED to false (today's single-server behavior)", () => {
    resetEnvCache();
    expect(loadEnv(validEnv).FEDERATION_ENABLED).toBe(false);
  });

  it("rejects NETWORK_CONFIG_PATH without a matching NETWORK_ROOT_PUBLIC_KEY", () => {
    resetEnvCache();
    expect(() => loadEnv({ ...validEnv, NETWORK_CONFIG_PATH: "/tmp/config.json" })).toThrow(
      /NETWORK_ROOT_PUBLIC_KEY/,
    );
  });

  it("accepts NETWORK_CONFIG_PATH when NETWORK_ROOT_PUBLIC_KEY is also set", () => {
    resetEnvCache();
    const env = loadEnv({ ...validEnv, NETWORK_CONFIG_PATH: "/tmp/config.json", NETWORK_ROOT_PUBLIC_KEY: "abc" });
    expect(env.NETWORK_CONFIG_PATH).toBe("/tmp/config.json");
  });
});
