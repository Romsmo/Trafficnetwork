import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import type { NetworkPeerApi } from "../../src/db/queries/network-peers.js";
import { applyDirectoryProbationCap, computeReputationTier } from "../../src/modules/federation/reputation.js";

function testEnv(overrides: Record<string, string> = {}): Env {
  resetEnvCache();
  return loadEnv({
    DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    JWT_SECRET: "a".repeat(32),
    REPUTATION_PROBATION_MIN_HOURS: "24",
    REPUTATION_MIN_SUCCESSFUL_HEALTH_CHECKS: "5",
    REPUTATION_TRUSTED_MIN_HOURS: String(24 * 7),
    REPUTATION_TRUSTED_MIN_SUCCESSFUL_HEALTH_CHECKS: "50",
    REPUTATION_DEMOTE_AFTER_CONSECUTIVE_FAILURES: "5",
    ...overrides,
  });
}

function peer(overrides: Partial<NetworkPeerApi> & { joinedHoursAgo: number }): NetworkPeerApi {
  return {
    nodeId: "peer1",
    publicKey: "pub",
    address: "https://peer.example",
    discoveredVia: "join",
    joinedAt: new Date(Date.now() - overrides.joinedHoursAgo * 60 * 60_000).toISOString(),
    lastSeenAt: new Date().toISOString(),
    successfulHealthChecks: 0,
    consecutiveHealthCheckFailures: 0,
    invalidSignatureCount: 0,
    lastKnownVersion: null,
    ...overrides,
  };
}

describe("computeReputationTier", () => {
  it("starts a brand-new peer on probation", () => {
    const env = testEnv();
    expect(computeReputationTier(peer({ joinedHoursAgo: 0, successfulHealthChecks: 0 }), env)).toBe("probation");
  });

  it("keeps a peer on probation until both the minimum age and successful-check thresholds are met", () => {
    const env = testEnv();
    // Enough checks, not enough age.
    expect(computeReputationTier(peer({ joinedHoursAgo: 1, successfulHealthChecks: 10 }), env)).toBe("probation");
    // Enough age, not enough checks.
    expect(computeReputationTier(peer({ joinedHoursAgo: 48, successfulHealthChecks: 1 }), env)).toBe("probation");
  });

  it("promotes to active once both thresholds are met", () => {
    const env = testEnv();
    expect(computeReputationTier(peer({ joinedHoursAgo: 48, successfulHealthChecks: 10 }), env)).toBe("active");
  });

  it("promotes to trusted once the higher trusted thresholds are met", () => {
    const env = testEnv();
    expect(computeReputationTier(peer({ joinedHoursAgo: 24 * 30, successfulHealthChecks: 100 }), env)).toBe("trusted");
  });

  it("demotes to probation immediately on any invalid signature, regardless of otherwise-good standing", () => {
    const env = testEnv();
    const veteran = peer({ joinedHoursAgo: 24 * 30, successfulHealthChecks: 100, invalidSignatureCount: 1 });
    expect(computeReputationTier(veteran, env)).toBe("probation");
  });

  it("demotes to probation once consecutive health-check failures reach the configured threshold", () => {
    const env = testEnv({ REPUTATION_DEMOTE_AFTER_CONSECUTIVE_FAILURES: "3" });
    const veteran = peer({ joinedHoursAgo: 24 * 30, successfulHealthChecks: 100, consecutiveHealthCheckFailures: 3 });
    expect(computeReputationTier(veteran, env)).toBe("probation");
  });

  it("tolerates consecutive failures below the demotion threshold", () => {
    const env = testEnv({ REPUTATION_DEMOTE_AFTER_CONSECUTIVE_FAILURES: "5" });
    const veteran = peer({ joinedHoursAgo: 48, successfulHealthChecks: 10, consecutiveHealthCheckFailures: 4 });
    expect(computeReputationTier(veteran, env)).toBe("active");
  });
});

describe("applyDirectoryProbationCap", () => {
  it("keeps every non-probation entry regardless of the cap", () => {
    const peers = [{ tier: "trusted" as const }, { tier: "active" as const }, { tier: "trusted" as const }];
    expect(applyDirectoryProbationCap(peers, 0)).toHaveLength(3);
  });

  it("caps probation entries to the configured share of the total", () => {
    const peers = [
      { tier: "active" as const },
      { tier: "probation" as const },
      { tier: "probation" as const },
      { tier: "probation" as const },
      { tier: "probation" as const },
    ];
    // 5 total * 0.5 share = 2 probation entries allowed through, plus the 1 active.
    const result = applyDirectoryProbationCap(peers, 0.5);
    expect(result.filter((p) => p.tier === "probation")).toHaveLength(2);
    expect(result.filter((p) => p.tier === "active")).toHaveLength(1);
  });

  it("allows every probation entry through when nothing else is competing for the cap", () => {
    const peers = [{ tier: "probation" as const }, { tier: "probation" as const }];
    expect(applyDirectoryProbationCap(peers, 1)).toHaveLength(2);
  });
});
