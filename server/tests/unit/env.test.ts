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

  it("rejects FEDERATION_ENABLED=true without FEDERATION_PUBLIC_ADDRESS", () => {
    resetEnvCache();
    expect(() => loadEnv({ ...validEnv, FEDERATION_ENABLED: "true" })).toThrow(/FEDERATION_PUBLIC_ADDRESS/);
  });

  it("rejects a FEDERATION_PUBLIC_ADDRESS that isn't https://", () => {
    resetEnvCache();
    expect(() =>
      loadEnv({ ...validEnv, FEDERATION_ENABLED: "true", FEDERATION_PUBLIC_ADDRESS: "http://insecure.example" }),
    ).toThrow(/https/);
  });

  it("accepts FEDERATION_ENABLED=true with a valid https FEDERATION_PUBLIC_ADDRESS", () => {
    resetEnvCache();
    const env = loadEnv({ ...validEnv, FEDERATION_ENABLED: "true", FEDERATION_PUBLIC_ADDRESS: "https://node.example" });
    expect(env.FEDERATION_ENABLED).toBe(true);
    expect(env.FEDERATION_PUBLIC_ADDRESS).toBe("https://node.example");
  });

  it("applies federation worker interval defaults", () => {
    resetEnvCache();
    const env = loadEnv(validEnv);
    expect(env.FEDERATION_HEARTBEAT_INTERVAL_SECONDS).toBe(60);
    expect(env.FEDERATION_ANTI_ENTROPY_INTERVAL_SECONDS).toBe(300);
    expect(env.FEDERATION_EVENT_MAX_AGE_HOURS).toBe(72);
  });

  it("applies reputation and overload defaults", () => {
    resetEnvCache();
    const env = loadEnv(validEnv);
    expect(env.REPUTATION_PROBATION_MIN_HOURS).toBe(24);
    expect(env.REPUTATION_MIN_SUCCESSFUL_HEALTH_CHECKS).toBe(5);
    expect(env.REPUTATION_TRUSTED_MIN_HOURS).toBe(168);
    expect(env.REPUTATION_DIRECTORY_PROBATION_MAX_SHARE).toBe(0.5);
    expect(env.FEDERATION_OVERLOAD_MAX_CONCURRENT_PUSHES).toBe(20);
  });

  it("applies the online-counter defaults (on, 5 minute window, mask below 5, cache 10 s)", () => {
    resetEnvCache();
    const env = loadEnv(validEnv);
    expect(env.ONLINE_COUNTER_ENABLED).toBe(true);
    expect(env.ONLINE_WINDOW_SECONDS).toBe(300);
    expect(env.ONLINE_MIN_DISPLAY_THRESHOLD).toBe(5);
    expect(env.ONLINE_CACHE_SECONDS).toBe(10);
    expect(env.ONLINE_PEER_STALE_SECONDS).toBe(300);
    expect(env.ONLINE_MAX_TRACKED).toBe(100_000);
  });

  it("switches the online counter off with the literal string \"false\"", () => {
    resetEnvCache();
    expect(loadEnv({ ...validEnv, ONLINE_COUNTER_ENABLED: "false" }).ONLINE_COUNTER_ENABLED).toBe(false);
  });

  it("allows a threshold, window and cache of 0 (never mask / connections only / no caching) but not negatives", () => {
    resetEnvCache();
    const env = loadEnv({ ...validEnv, ONLINE_MIN_DISPLAY_THRESHOLD: "0", ONLINE_WINDOW_SECONDS: "0", ONLINE_CACHE_SECONDS: "0" });
    expect(env.ONLINE_MIN_DISPLAY_THRESHOLD).toBe(0);
    expect(env.ONLINE_WINDOW_SECONDS).toBe(0);
    expect(env.ONLINE_CACHE_SECONDS).toBe(0);
    resetEnvCache();
    expect(() => loadEnv({ ...validEnv, ONLINE_MIN_DISPLAY_THRESHOLD: "-1" })).toThrow(/ONLINE_MIN_DISPLAY_THRESHOLD/);
  });
});
