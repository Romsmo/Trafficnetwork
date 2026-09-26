import { describe, expect, it } from "vitest";
import { MAX_PLAUSIBLE_PEER_ONLINE, OnlineTracker, type OnlineTrackerOptions } from "../../src/modules/online/tracker.js";
import type { TokenClaims } from "../../src/modules/auth/jwt.js";

function setup(overrides: Partial<OnlineTrackerOptions> = {}) {
  const clock = { now: 0 };
  const tracker = new OnlineTracker({
    enabled: true,
    windowSeconds: 300,
    maxTracked: 1000,
    peerStaleSeconds: 300,
    now: () => clock.now,
    ...overrides,
  });
  return { tracker, clock, advanceSeconds: (s: number) => (clock.now += s * 1000) };
}

const client = (sub: string): TokenClaims => ({ sub, scopes: ["client"] });
const socket = () => ({});

describe("OnlineTracker: WebSocket connections", () => {
  it("rises with each connected client and falls when they disconnect", () => {
    const { tracker } = setup();
    expect(tracker.nodeCount()).toBe(0);

    const a = socket();
    const b = socket();
    tracker.wsConnected(a, client("client_a"));
    expect(tracker.nodeCount()).toBe(1);
    tracker.wsConnected(b, client("client_b"));
    expect(tracker.nodeCount()).toBe(2);

    tracker.wsDisconnected(a);
    expect(tracker.nodeCount()).toBe(1);
    tracker.wsDisconnected(b);
    expect(tracker.nodeCount()).toBe(0);
  });

  it("counts a device that holds several connections once, and only stops counting it when the last one closes", () => {
    const { tracker } = setup();
    const first = socket();
    const second = socket();
    tracker.wsConnected(first, client("client_a"));
    tracker.wsConnected(second, client("client_a"));
    expect(tracker.nodeCount()).toBe(1);

    tracker.wsDisconnected(first);
    expect(tracker.nodeCount()).toBe(1);
    tracker.wsDisconnected(second);
    expect(tracker.nodeCount()).toBe(0);
  });

  it("does not double count when the same socket authenticates again", () => {
    const { tracker } = setup();
    const s = socket();
    tracker.wsConnected(s, client("client_a"));
    tracker.wsConnected(s, client("client_a"));
    expect(tracker.nodeCount()).toBe(1);
    tracker.wsDisconnected(s);
    expect(tracker.nodeCount()).toBe(0);
  });

  it("drops a socket that re-authenticates with a service token (no longer a user)", () => {
    const { tracker } = setup();
    const s = socket();
    tracker.wsConnected(s, client("client_a"));
    tracker.wsConnected(s, { sub: "importer", scopes: ["bulk-import"] });
    expect(tracker.nodeCount()).toBe(0);
  });

  it("ignores disconnecting a socket it never saw", () => {
    const { tracker } = setup();
    expect(() => tracker.wsDisconnected(socket())).not.toThrow();
    expect(tracker.nodeCount()).toBe(0);
  });
});

describe("OnlineTracker: activity window", () => {
  it("counts a client that made a sync/write request until the window has passed", () => {
    const { tracker, advanceSeconds } = setup({ windowSeconds: 300 });
    tracker.recordActivity(client("client_a"));
    expect(tracker.nodeCount()).toBe(1);

    advanceSeconds(299);
    expect(tracker.nodeCount()).toBe(1);
    advanceSeconds(2);
    expect(tracker.nodeCount()).toBe(0);
  });

  it("a fresh request restarts the window", () => {
    const { tracker, advanceSeconds } = setup({ windowSeconds: 300 });
    tracker.recordActivity(client("client_a"));
    advanceSeconds(200);
    tracker.recordActivity(client("client_a"));
    advanceSeconds(200);
    expect(tracker.nodeCount()).toBe(1);
    advanceSeconds(101);
    expect(tracker.nodeCount()).toBe(0);
  });

  it("expires each client on its own clock, oldest first", () => {
    const { tracker, advanceSeconds } = setup({ windowSeconds: 300 });
    tracker.recordActivity(client("client_a"));
    advanceSeconds(100);
    tracker.recordActivity(client("client_b"));
    advanceSeconds(100);
    tracker.recordActivity(client("client_c"));
    expect(tracker.nodeCount()).toBe(3);

    advanceSeconds(150); // a is 350s old, b 250s, c 150s
    expect(tracker.nodeCount()).toBe(2);
    advanceSeconds(100); // b is 350s old
    expect(tracker.nodeCount()).toBe(1);
  });

  it("counts a client that is both connected and polling once", () => {
    const { tracker } = setup();
    tracker.wsConnected(socket(), client("client_a"));
    tracker.recordActivity(client("client_a"));
    expect(tracker.nodeCount()).toBe(1);
  });

  it("keeps counting a connected client after its activity expires (a connection needs no polling)", () => {
    const { tracker, advanceSeconds } = setup({ windowSeconds: 60 });
    tracker.wsConnected(socket(), client("client_a"));
    tracker.recordActivity(client("client_a"));
    advanceSeconds(600);
    expect(tracker.nodeCount()).toBe(1);
  });

  it("with a window of 0, only open connections count", () => {
    const { tracker } = setup({ windowSeconds: 0 });
    tracker.recordActivity(client("client_a"));
    expect(tracker.nodeCount()).toBe(0);
    tracker.wsConnected(socket(), client("client_b"));
    expect(tracker.nodeCount()).toBe(1);
  });

  it("does not count service credentials, only the client scope", () => {
    const { tracker } = setup();
    tracker.recordActivity({ sub: "importer", scopes: ["bulk-import"] });
    tracker.recordActivity({ sub: "app", scopes: ["device-registration"] });
    tracker.wsConnected(socket(), { sub: "importer", scopes: ["bulk-import"] });
    expect(tracker.nodeCount()).toBe(0);
    tracker.recordActivity({ sub: "both", scopes: ["bulk-import", "client"] });
    expect(tracker.nodeCount()).toBe(1);
  });
});

describe("OnlineTracker: bounded memory", () => {
  it("stops remembering new clients at the cap but keeps refreshing the ones it has", () => {
    const { tracker } = setup({ maxTracked: 2 });
    tracker.recordActivity(client("client_a"));
    tracker.recordActivity(client("client_b"));
    tracker.recordActivity(client("client_c")); // over the cap: not remembered
    expect(tracker.nodeCount()).toBe(2);

    tracker.recordActivity(client("client_a")); // already known: fine
    expect(tracker.nodeCount()).toBe(2);
  });

  it("makes room again once tracked clients have expired", () => {
    const { tracker, advanceSeconds } = setup({ maxTracked: 1, windowSeconds: 60 });
    tracker.recordActivity(client("client_a"));
    advanceSeconds(61);
    tracker.recordActivity(client("client_b"));
    expect(tracker.nodeCount()).toBe(1);
  });
});

describe("OnlineTracker: privacy", () => {
  it("never keeps the token subject itself, only a salted hash of it", () => {
    const { tracker } = setup();
    tracker.wsConnected(socket(), client("client_secret_subject"));
    tracker.recordActivity(client("client_other_subject"));

    const internals = tracker as unknown as { socketRefs: Map<string, number>; activity: Map<string, number> };
    const keys = [...internals.socketRefs.keys(), ...internals.activity.keys()];
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).not.toContain("client_");
      expect(key).toHaveLength(16);
    }
  });

  it("uses a different salt per instance, so the hashes are not comparable across restarts or nodes", () => {
    const one = setup().tracker as unknown as { keyFor(s: string): string };
    const two = setup().tracker as unknown as { keyFor(s: string): string };
    expect(one.keyFor("client_a")).not.toBe(two.keyFor("client_a"));
    expect(one.keyFor("client_a")).toBe(one.keyFor("client_a"));
  });
});

describe("OnlineTracker: disabled", () => {
  it("tracks nothing and reports 0", () => {
    const { tracker } = setup({ enabled: false });
    tracker.wsConnected(socket(), client("client_a"));
    tracker.recordActivity(client("client_b"));
    expect(tracker.isEnabled).toBe(false);
    expect(tracker.nodeCount()).toBe(0);
    expect(tracker.recordPeerReport("peer", 5)).toBe(false);
  });
});

describe("OnlineTracker: peer reports (figures from signed heartbeats)", () => {
  it("returns a peer's last figure while its heartbeat is fresh, and forgets it once stale", () => {
    const { tracker, advanceSeconds } = setup({ peerStaleSeconds: 300 });
    expect(tracker.recordPeerReport("peer_a", 12)).toBe(true);
    expect(tracker.peerReport("peer_a")).toBe(12);

    advanceSeconds(299);
    expect(tracker.peerReport("peer_a")).toBe(12);
    advanceSeconds(2);
    expect(tracker.peerReport("peer_a")).toBeUndefined();
  });

  it("a newer heartbeat replaces the older figure and restarts staleness", () => {
    const { tracker, advanceSeconds } = setup({ peerStaleSeconds: 300 });
    tracker.recordPeerReport("peer_a", 12);
    advanceSeconds(250);
    tracker.recordPeerReport("peer_a", 30);
    advanceSeconds(250);
    expect(tracker.peerReport("peer_a")).toBe(30);
  });

  it("knows nothing about a peer that never reported", () => {
    expect(setup().tracker.peerReport("stranger")).toBeUndefined();
  });

  it.each([
    ["negative", -1],
    ["fractional", 2.5],
    ["a string", "12"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["implausibly large", MAX_PLAUSIBLE_PEER_ONLINE + 1],
    ["null", null],
    ["an object", {}],
  ])("ignores %s figures without remembering them", (_label, value) => {
    const { tracker } = setup();
    expect(tracker.recordPeerReport("peer_a", value)).toBe(false);
    expect(tracker.peerReport("peer_a")).toBeUndefined();
  });

  it("accepts 0 and the largest plausible figure", () => {
    const { tracker } = setup();
    expect(tracker.recordPeerReport("peer_a", 0)).toBe(true);
    expect(tracker.peerReport("peer_a")).toBe(0);
    expect(tracker.recordPeerReport("peer_b", MAX_PLAUSIBLE_PEER_ONLINE)).toBe(true);
  });
});
