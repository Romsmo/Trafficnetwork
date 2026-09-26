import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import type { NetworkPeerApi } from "../../src/db/queries/network-peers.js";
import { OnlineTracker } from "../../src/modules/online/tracker.js";
import { applyThreshold, createStatsProvider, estimateNetwork, type PeerInput } from "../../src/modules/online/stats.js";

function testEnv(overrides: Record<string, string> = {}) {
  resetEnvCache();
  return loadEnv({
    DATABASE_URL: "postgres://user:pass@localhost:5432/db",
    JWT_SECRET: "a".repeat(32),
    ...overrides,
  });
}

/** Meets the default `active` thresholds (24 h known, >= 5 successful health checks). */
function activePeer(nodeId: string): NetworkPeerApi {
  return {
    nodeId,
    publicKey: `key-${nodeId}`,
    address: `https://${nodeId}.example`,
    discoveredVia: "join",
    joinedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
    lastSeenAt: new Date().toISOString(),
    successfulHealthChecks: 10,
    consecutiveHealthCheckFailures: 0,
    invalidSignatureCount: 0,
    lastKnownVersion: "1",
  };
}

function probationPeer(nodeId: string): NetworkPeerApi {
  return { ...activePeer(nodeId), joinedAt: new Date().toISOString(), successfulHealthChecks: 0 };
}

describe("applyThreshold", () => {
  it("prints the exact figure at or above the threshold", () => {
    expect(applyThreshold(5, 5)).toEqual({ online: 5 });
    expect(applyThreshold(87, 5)).toEqual({ online: 87 });
  });

  it("withholds the exact figure below the threshold and says what the threshold is", () => {
    expect(applyThreshold(4, 5)).toEqual({ online: null, below: 5 });
    expect(applyThreshold(1, 5)).toEqual({ online: null, below: 5 });
    expect(applyThreshold(0, 5)).toEqual({ online: null, below: 5 });
  });

  it("a threshold of 0 never masks", () => {
    expect(applyThreshold(0, 0)).toEqual({ online: 0 });
    expect(applyThreshold(1, 0)).toEqual({ online: 1 });
  });

  it("never contains both a number and a below marker", () => {
    for (const count of [0, 1, 4, 5, 6, 100]) {
      const figure = applyThreshold(count, 5);
      expect("below" in figure && figure.online !== null).toBe(false);
    }
  });
});

describe("estimateNetwork", () => {
  const peer = (over: Partial<PeerInput> = {}): PeerInput => ({ tier: "active", excluded: false, reportedOnline: 10, ...over });

  it("is just the own figure when there are no peers", () => {
    expect(estimateNetwork(7, [])).toEqual({ online: 7, nodes: 1 });
  });

  it("adds the figures of active and trusted peers", () => {
    expect(estimateNetwork(7, [peer({ reportedOnline: 10 }), peer({ tier: "trusted", reportedOnline: 20 })])).toEqual({ online: 37, nodes: 3 });
  });

  it("leaves out peers on probation, however large their claim", () => {
    expect(estimateNetwork(7, [peer({ tier: "probation", reportedOnline: 5000 })])).toEqual({ online: 7, nodes: 1 });
  });

  it("leaves out peers with no usable figure (never reported, or its heartbeat went stale)", () => {
    expect(estimateNetwork(7, [peer({ reportedOnline: undefined })])).toEqual({ online: 7, nodes: 1 });
  });

  it("leaves out peers the signed network config excludes", () => {
    expect(estimateNetwork(7, [peer({ excluded: true })])).toEqual({ online: 7, nodes: 1 });
  });

  it("counts a peer that honestly reports 0 as a contributing node", () => {
    expect(estimateNetwork(7, [peer({ reportedOnline: 0 })])).toEqual({ online: 7, nodes: 2 });
  });
});

describe("createStatsProvider", () => {
  function setup(envOverrides: Record<string, string> = {}, peers: NetworkPeerApi[] = [], excluded: string[] = []) {
    const env = testEnv(envOverrides);
    const clock = { mono: 0 };
    const tracker = new OnlineTracker({
      enabled: env.ONLINE_COUNTER_ENABLED,
      windowSeconds: env.ONLINE_WINDOW_SECONDS,
      maxTracked: env.ONLINE_MAX_TRACKED,
      peerStaleSeconds: env.ONLINE_PEER_STALE_SECONDS,
      now: () => clock.mono,
    });
    const calls = { getPeers: 0 };
    const provider = createStatsProvider({
      env,
      tracker,
      getPeers: async () => {
        calls.getPeers += 1;
        return peers;
      },
      isExcluded: (id) => excluded.includes(id),
      now: () => clock.mono,
      wallClock: () => new Date("2026-09-24T12:00:00.000Z"),
    });
    const connect = (n: number) => {
      for (let i = 0; i < n; i++) tracker.wsConnected({}, { sub: `client_${i}`, scopes: ["client"] });
    };
    return { env, tracker, provider, calls, clock, connect };
  }

  it("answers { enabled: false } when the feature is switched off, and tracks nothing", async () => {
    const { provider, connect } = setup({ ONLINE_COUNTER_ENABLED: "false" });
    connect(50);
    expect(await provider.get()).toEqual({ enabled: false });
  });

  it("prints the exact node figure at or above the threshold", async () => {
    const { provider, connect } = setup();
    connect(12);
    expect(await provider.get()).toEqual({
      enabled: true,
      node: { online: 12, windowSeconds: 300 },
      minDisplayThreshold: 5,
    });
  });

  it("withholds the node figure below the threshold instead of printing it", async () => {
    const { provider, connect } = setup();
    connect(3);
    const answer = await provider.get();
    expect(answer).toEqual({
      enabled: true,
      node: { online: null, below: 5, windowSeconds: 300 },
      minDisplayThreshold: 5,
    });
    expect(JSON.stringify(answer)).not.toContain('"online":3');
  });

  it("honours a configured threshold and window", async () => {
    const { provider, connect } = setup({ ONLINE_MIN_DISPLAY_THRESHOLD: "20", ONLINE_WINDOW_SECONDS: "60" });
    connect(19);
    const answer = await provider.get();
    expect(answer).toMatchObject({ node: { online: null, below: 20, windowSeconds: 60 }, minDisplayThreshold: 20 });
  });

  it("has no network part when the node does not federate", async () => {
    const { provider, connect, calls } = setup({ FEDERATION_ENABLED: "false" }, [activePeer("peer_a")]);
    connect(12);
    const answer = await provider.get();
    expect(answer).not.toHaveProperty("network");
    expect(calls.getPeers).toBe(0);
  });

  const federated = { FEDERATION_ENABLED: "true", FEDERATION_PUBLIC_ADDRESS: "https://node.example" };

  it("adds the reported figures of qualifying peers into an estimated network total", async () => {
    const { provider, tracker, connect } = setup(federated, [activePeer("peer_a"), activePeer("peer_b")]);
    connect(12);
    tracker.recordPeerReport("peer_a", 30);
    tracker.recordPeerReport("peer_b", 45);

    expect(await provider.get()).toMatchObject({
      node: { online: 12 },
      network: { online: 87, nodes: 3, estimated: true, asOf: "2026-09-24T12:00:00.000Z" },
    });
  });

  it("leaves out a probation peer, an excluded peer and a peer whose heartbeat went stale", async () => {
    const peers = [activePeer("peer_ok"), probationPeer("peer_new"), activePeer("peer_excluded"), activePeer("peer_stale")];
    const { provider, tracker, connect, clock } = setup({ ...federated, ONLINE_PEER_STALE_SECONDS: "300" }, peers, ["peer_excluded"]);
    connect(10);
    tracker.recordPeerReport("peer_stale", 100);
    clock.mono += 301_000; // peer_stale's heartbeat is now too old
    tracker.recordPeerReport("peer_ok", 20);
    tracker.recordPeerReport("peer_new", 500);
    tracker.recordPeerReport("peer_excluded", 500);

    const answer = await provider.get();
    expect(answer).toMatchObject({ network: { online: 30, nodes: 2, estimated: true } });
  });

  it("withholds the network figure too when the total is below the threshold", async () => {
    const { provider, connect } = setup(federated, [activePeer("peer_a")]);
    connect(2);
    const answer = await provider.get();
    expect(answer).toMatchObject({ network: { online: null, below: 5, nodes: 1, estimated: true } });
  });

  it("reuses one computed answer for the cache period, then recomputes", async () => {
    const { provider, tracker, connect, calls, clock } = setup({ ...federated, ONLINE_CACHE_SECONDS: "10" }, [activePeer("peer_a")]);
    connect(10);
    tracker.recordPeerReport("peer_a", 10);

    const first = await provider.get();
    tracker.wsConnected({}, { sub: "someone_new", scopes: ["client"] });
    clock.mono += 9_000;
    const second = await provider.get();
    expect(second).toBe(first);
    expect(calls.getPeers).toBe(1);

    clock.mono += 2_000; // 11 s in: expired
    const third = await provider.get();
    expect(third).not.toBe(first);
    expect(third).toMatchObject({ node: { online: 11 } });
    expect(calls.getPeers).toBe(2);
  });

  it("computes on every request when the cache is 0", async () => {
    const { provider, connect, calls } = setup({ ...federated, ONLINE_CACHE_SECONDS: "0" }, [activePeer("peer_a")]);
    connect(10);
    await provider.get();
    await provider.get();
    expect(calls.getPeers).toBe(2);
  });

  it("shares one computation between simultaneous requests", async () => {
    const { provider, connect, calls } = setup({ ...federated, ONLINE_CACHE_SECONDS: "0" }, [activePeer("peer_a")]);
    connect(10);
    const [a, b, c] = await Promise.all([provider.get(), provider.get(), provider.get()]);
    expect(calls.getPeers).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});
