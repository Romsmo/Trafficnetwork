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
    // The emergency brake is released by default: cameras are delivered unless a signed policy takes a country back.
    expect(env.SPEED_CAMERA_NAMESPACE_ENABLED).toBe(true);
    expect(env.CAMERA_POLICY_LOCAL_CAPS).toBe("");
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

  it("coerces the camera-namespace flag (the emergency brake) from the literal strings \"true\" and \"false\"", () => {
    resetEnvCache();
    expect(loadEnv({ ...validEnv, SPEED_CAMERA_NAMESPACE_ENABLED: "true" }).SPEED_CAMERA_NAMESPACE_ENABLED).toBe(true);
    resetEnvCache();
    expect(loadEnv({ ...validEnv, SPEED_CAMERA_NAMESPACE_ENABLED: "false" }).SPEED_CAMERA_NAMESPACE_ENABLED).toBe(false);
  });

  it("rejects a camera zone resolution coarser than the package partition (a zone is carried by the package of its parent tile)", () => {
    resetEnvCache();
    expect(() => loadEnv({ ...validEnv, STATIC_DATA_PARTITION_H3_RESOLUTION: "6", CAMERA_ZONE_H3_RESOLUTION: "5" })).toThrow(/CAMERA_ZONE_H3_RESOLUTION/);
    resetEnvCache();
    expect(() => loadEnv({ ...validEnv, CAMERA_POLICY_LOCAL_CAPS: "DE=maybe" })).toThrow(/CAMERA_POLICY_LOCAL_CAPS/);
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

  describe("static-data partition resolution (E-B)", () => {
    it("defaults to 4 in code — every node must agree, so it must not depend on an environment variable being set", () => {
      resetEnvCache();
      expect(loadEnv(validEnv).STATIC_DATA_PARTITION_H3_RESOLUTION).toBe(4);
    });

    it("can still be overridden, within the valid H3 range", () => {
      resetEnvCache();
      expect(loadEnv({ ...validEnv, STATIC_DATA_PARTITION_H3_RESOLUTION: "3" }).STATIC_DATA_PARTITION_H3_RESOLUTION).toBe(3);
      resetEnvCache();
      expect(() => loadEnv({ ...validEnv, STATIC_DATA_PARTITION_H3_RESOLUTION: "16" })).toThrow(/STATIC_DATA_PARTITION_H3_RESOLUTION/);
    });

    it("applies the package and Europe-scale defaults", () => {
      resetEnvCache();
      const env = loadEnv(validEnv);
      expect(env.STATIC_PACKAGES_DIR).toBe("./data/static-packages");
      expect(env.STATIC_PACKAGES_WORKER_ENABLED).toBe(true);
      expect(env.STATIC_PACKAGES_PUBLIC).toBe(false);
      expect(env.STATIC_PACKAGES_INLINE_BUILD_MAX_ROWS).toBe(200_000);
      expect(env.SNAPSHOT_STATIC_MAX_ROWS).toBe(1_000_000);
      expect(env.BULK_IMPORT_MAX_ROWS).toBe(5000);
    });
  });

  describe("community speed-limit corrections (K-A)", () => {
    it("is on by default, with the operator-decided threshold of 3 and a stricter rate limit than reports", () => {
      resetEnvCache();
      const env = loadEnv(validEnv);
      expect(env.COMMUNITY_CORRECTIONS_ENABLED).toBe(true);
      expect(env.COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED).toBe(3);
      expect(env.COMMUNITY_CORRECTIONS_KMH_MIN).toBe(5);
      expect(env.COMMUNITY_CORRECTIONS_KMH_MAX).toBe(150);
      expect(env.COMMUNITY_CORRECTIONS_MPH_MIN).toBe(5);
      expect(env.COMMUNITY_CORRECTIONS_MPH_MAX).toBe(85);
      expect(env.COMMUNITY_CORRECTIONS_VALUE_STEP).toBe(5);
      expect(env.COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX).toBe(5);
      expect(env.COMMUNITY_CORRECTIONS_RATE_LIMIT_WINDOW_MINUTES).toBe(60);
      // "eigenes, strengeres Limit": fewer submissions per hour than reports allow.
      const perHourReports = env.REPORT_RATE_LIMIT_MAX * (60 / env.REPORT_RATE_LIMIT_WINDOW_MINUTES);
      expect(env.COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX / (env.COMMUNITY_CORRECTIONS_RATE_LIMIT_WINDOW_MINUTES / 60)).toBeLessThan(perHourReports);
    });

    it("can be switched off and its numbers tuned from the environment", () => {
      resetEnvCache();
      const env = loadEnv({
        ...validEnv,
        COMMUNITY_CORRECTIONS_ENABLED: "false",
        COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED: "5",
        COMMUNITY_CORRECTIONS_KMH_MAX: "130",
        COMMUNITY_CORRECTIONS_VALUE_STEP: "1",
      });
      expect(env.COMMUNITY_CORRECTIONS_ENABLED).toBe(false);
      expect(env.COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED).toBe(5);
      expect(env.COMMUNITY_CORRECTIONS_KMH_MAX).toBe(130);
      expect(env.COMMUNITY_CORRECTIONS_VALUE_STEP).toBe(1);
    });

    it("rejects an inverted range and a zero threshold", () => {
      resetEnvCache();
      expect(() => loadEnv({ ...validEnv, COMMUNITY_CORRECTIONS_KMH_MIN: "200", COMMUNITY_CORRECTIONS_KMH_MAX: "100" })).toThrow(/KMH_MIN/);
      resetEnvCache();
      expect(() => loadEnv({ ...validEnv, COMMUNITY_CORRECTIONS_MPH_MIN: "90" })).toThrow(/MPH_MIN/);
      resetEnvCache();
      expect(() => loadEnv({ ...validEnv, COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED: "0" })).toThrow(/CONFIRMATIONS_REQUIRED/);
    });
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
