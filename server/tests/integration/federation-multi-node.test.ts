import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { generateEd25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import { joinSeeds, sendHeartbeats, pullFromPeers, type FederationWorkerDeps } from "../../src/modules/federation/workers.js";
import type { DeviceCreateEventPayload } from "../../src/modules/federation/device-event.js";

/**
 * F-S5: a real multi-node network — three actual listening Fastify servers,
 * each backed by its own Postgres (Testcontainers), talking to each other
 * over real HTTP (not app.inject()). This is deliberately the *only* place
 * in the test suite that does this — every earlier F-S3/F-S4 integration
 * test verifies one server's protocol handling in isolation, which is
 * cheaper and was enough to catch real bugs (see docs/threat-model.md's
 * implementation notes) — but only a real multi-node run can catch bugs in
 * how the pieces compose end to end (does gossip actually reach a third
 * node, does a real partition actually get healed by anti-entropy...).
 *
 * FEDERATION_PUBLIC_ADDRESS normally must be https:// (docs/threat-model.md)
 * — these nodes use the narrow loopback exception
 * (modules/federation/address.ts) instead of standing up real TLS certs for
 * ephemeral test ports, which would test certificate handling, not this
 * server's own federation logic. Fixed ports (not OS-assigned) because the
 * address has to be known *before* buildApp()/listen() to include in this
 * node's own join/heartbeat payloads.
 */
describe("multi-node federation network (F-S5)", () => {
  const PORT_A = 18831;
  const PORT_B = 18832;
  const PORT_C = 18833;

  interface Node {
    testDb: TestDatabase;
    app: FastifyInstance;
    env: Env;
    address: string;
    workerDeps: FederationWorkerDeps;
  }

  async function startNode(port: number, envOverrides: Record<string, string> = {}): Promise<Node> {
    const testDb = await startTestDatabase();
    const address = `http://127.0.0.1:${port}`;
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      FEDERATION_ENABLED: "true",
      FEDERATION_PUBLIC_ADDRESS: address,
      DUPLICATE_MERGE_RADIUS_METERS: "500",
      ...envOverrides,
    });
    const app = await buildApp({ env, db: testDb.db });
    await app.listen({ port, host: "127.0.0.1" });
    const workerDeps: FederationWorkerDeps = { db: testDb.db, env, nodeIdentity: app.nodeIdentity, realtime: app.realtime, log: app.log };
    return { testDb, app, env, address, workerDeps };
  }

  async function stopNode(node: Node): Promise<void> {
    await node.app.close();
    await node.testDb.teardown();
  }

  function deviceCreateEnvelope(device: ReturnType<typeof generateEd25519KeyPair>, overrides: Partial<DeviceCreateEventPayload> = {}) {
    const payload: DeviceCreateEventPayload = {
      kind: "create",
      type: "ice",
      lat: 52.5,
      lng: 13.4,
      devicePublicKey: device.publicKeyRaw,
      timestamp: new Date().toISOString(),
      ...overrides,
    };
    return signEnvelope(payload, device);
  }

  /** Async replication is fire-and-forget from the receiving node's perspective — poll instead of assuming it's instant. */
  async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 5000, intervalMs = 100): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await check();
      if (result !== undefined) return result;
      if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  async function reportsNear(node: Node, lat: number, lng: number): Promise<unknown[]> {
    const res = await node.app.inject({
      method: "GET",
      url: `/v1/hazard-reports/nearby?lat=${lat}&lng=${lng}&radiusM=1000`,
      headers: authHeader(await testToken(node.env)),
    });
    return res.json().reports;
  }

  let a: Node, b: Node, c: Node;

  beforeAll(async () => {
    [a, b, c] = await Promise.all([startNode(PORT_A), startNode(PORT_B), startNode(PORT_C)]);

    // Full mesh: B joins A; C joins both A and B. A never initiates a join
    // itself (it's the "first" node in this topology) — its peers arrive
    // purely from others joining it, exactly like a real seed server.
    await joinSeeds({ ...b.workerDeps, env: { ...b.env, FEDERATION_SEEDS: a.address } });
    await joinSeeds({ ...c.workerDeps, env: { ...c.env, FEDERATION_SEEDS: `${a.address},${b.address}` } });
  }, 90_000);

  afterAll(async () => {
    await Promise.all([stopNode(a), stopNode(b), stopNode(c)]);
  });

  it("establishes a full mesh via join + one-hop gossip", async () => {
    const peersOf = async (node: Node) => (await node.app.inject({ method: "GET", url: "/v1/federation/peers" })).json().peers.map((p: { nodeId: string }) => p.nodeId);

    expect(await peersOf(a)).toEqual(expect.arrayContaining([b.app.nodeIdentity.nodeId, c.app.nodeIdentity.nodeId]));
    expect(await peersOf(b)).toEqual(expect.arrayContaining([a.app.nodeIdentity.nodeId, c.app.nodeIdentity.nodeId]));
    expect(await peersOf(c)).toEqual(expect.arrayContaining([a.app.nodeIdentity.nodeId, b.app.nodeIdentity.nodeId]));
  });

  it("a real heartbeat over the network updates the *sending* node's own reachability signal for its peers", async () => {
    // recordHealthCheckSuccess is written to the caller's own database — the
    // active-checker's view of the peer, never the other way around (see
    // modules/federation/reputation.ts's header comment: only signals *this
    // server itself measured* count). Receiving a heartbeat updates the
    // receiver's record of the *sender* (address/version), but not a
    // reachability counter — that would be trusting a self-report.
    const peersOnABefore = (await a.app.inject({ method: "GET", url: "/v1/federation/peers" })).json().peers;
    const bAsSeenByABefore = peersOnABefore.find((p: { nodeId: string }) => p.nodeId === b.app.nodeIdentity.nodeId);
    expect(bAsSeenByABefore.successfulHealthChecks).toBe(0);

    await sendHeartbeats(a.workerDeps); // A -> real HTTP heartbeat -> both B and C

    const peersOnAAfter = (await a.app.inject({ method: "GET", url: "/v1/federation/peers" })).json().peers;
    const bAsSeenByAAfter = peersOnAAfter.find((p: { nodeId: string }) => p.nodeId === b.app.nodeIdentity.nodeId);
    expect(bAsSeenByAAfter.successfulHealthChecks).toBe(1);
    expect(bAsSeenByAAfter.lastSeenAt).not.toBeNull();
  });

  it("replicates a device-signed report created on one node to the other two", async () => {
    const device = generateEd25519KeyPair();
    const envelope = deviceCreateEnvelope(device, { lat: 10, lng: 10, type: "accident" });

    const res = await a.app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: authHeader(await testToken(a.env)),
      payload: { type: "accident", lat: 10, lng: 10, deviceAssertion: envelope },
    });
    expect(res.statusCode).toBe(201);

    // A's gossip fan-out (modules/federation/broadcast.ts) is fire-and-forget
    // — not awaited by the response above — so B and C receiving it is an
    // asynchronous side effect to poll for, not something already true by
    // the time this assertion runs.
    await waitFor(async () => {
      const reports = await reportsNear(b, 10, 10);
      return reports.length > 0 ? reports : undefined;
    });
    await waitFor(async () => {
      const reports = await reportsNear(c, 10, 10);
      return reports.length > 0 ? reports : undefined;
    });

    const [onB, onC] = await Promise.all([reportsNear(b, 10, 10), reportsNear(c, 10, 10)]);
    expect(onB).toHaveLength(1);
    expect(onC).toHaveLength(1);
    // B relaying to C (since B also knows C) and A's own direct push to C
    // race to deliver the same event twice — dedup (federationEventId) must
    // hold up under real concurrent multi-hop delivery, not just the
    // single-node race simulated in federation-events.test.ts.
    expect((onC[0] as { confirmCount: number }).confirmCount).toBe(0);
  });

  it("a report a node can't reach doesn't break the sender, and anti-entropy heals the gap once the node is back", async () => {
    // Simulate a partition: take C offline before A creates a new report, so
    // A's real-time push fan-out to C fails outright.
    await c.app.close();

    const device = generateEd25519KeyPair();
    const envelope = deviceCreateEnvelope(device, { lat: 20, lng: 20, type: "obstacle" });
    const res = await a.app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: authHeader(await testToken(a.env)),
      payload: { type: "obstacle", lat: 20, lng: 20, deviceAssertion: envelope },
    });
    // A's own request must succeed regardless of C being unreachable — the
    // fan-out is best-effort and never awaited by the response (failover).
    expect(res.statusCode).toBe(201);

    await waitFor(async () => {
      const reports = await reportsNear(b, 20, 20);
      return reports.length > 0 ? reports : undefined;
    });

    // "C" comes back — a fresh app instance against the *same* database (the
    // node's identity and any prior data live in Postgres, not the process),
    // listening on the same address again.
    const cRestarted = await buildApp({ env: c.env, db: c.testDb.db });
    await cRestarted.listen({ port: PORT_C, host: "127.0.0.1" });
    const restartedDeps: FederationWorkerDeps = { db: c.testDb.db, env: c.env, nodeIdentity: cRestarted.nodeIdentity, realtime: cRestarted.realtime, log: cRestarted.log };

    // Confirm the gap actually exists before healing it.
    const beforePull = await cRestarted.inject({
      method: "GET",
      url: "/v1/hazard-reports/nearby?lat=20&lng=20&radiusM=1000",
      headers: authHeader(await testToken(c.env)),
    });
    expect(beforePull.json().reports).toEqual([]);

    await pullFromPeers(restartedDeps);

    const afterPull = await cRestarted.inject({
      method: "GET",
      url: "/v1/hazard-reports/nearby?lat=20&lng=20&radiusM=1000",
      headers: authHeader(await testToken(c.env)),
    });
    expect(afterPull.json().reports).toHaveLength(1);

    c = { ...c, app: cRestarted };
  });

  it("demotes a peer's reputation immediately on an invalid signature, visible network-wide from the receiving node's own view", async () => {
    const device = generateEd25519KeyPair();
    const impostor = generateEd25519KeyPair();
    const forged = signEnvelope(
      { kind: "create" as const, type: "ice" as const, lat: 30, lng: 30, devicePublicKey: device.publicKeyRaw, timestamp: new Date().toISOString() },
      impostor, // signed by the wrong key
    );

    const push = await b.app.inject({
      method: "POST",
      url: "/v1/federation/events",
      payload: { senderNodeId: a.app.nodeIdentity.nodeId, events: [forged] },
    });
    expect(push.json().results[0]).toMatchObject({ status: "rejected", code: "invalid_signature" });

    const directory = await b.app.inject({ method: "GET", url: "/v1/network/directory" });
    const entryForA = directory.json().peers.find((p: { nodeId: string }) => p.nodeId === a.app.nodeIdentity.nodeId);
    expect(entryForA.tier).toBe("probation");
  });

  it("federation carries camera-adjacent reports, but each node's own local flag still gates whether it's ever served back out", async () => {
    // Neither node here has a signed network config — each is purely
    // governed by its own local SPEED_CAMERA_NAMESPACE_ENABLED, and
    // federation has no mechanism to override that (only hazard-report
    // *creation* replicates — there is no "camera flag" federation message
    // type at all, see server/docs/federation-protocol.md).
    const device = generateEd25519KeyPair();
    const envelope = deviceCreateEnvelope(device, { lat: 40, lng: 40, type: "mobileSpeedCamera", speedKmh: 80 });

    const res = await a.app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: authHeader(await testToken(a.env)),
      payload: { type: "mobileSpeedCamera", lat: 40, lng: 40, speedKmh: 80, deviceAssertion: envelope },
    });
    expect(res.statusCode).toBe(201);

    await waitFor(async () => {
      const reports = await reportsNear(b, 40, 40);
      return reports.length > 0 ? reports : undefined;
    });

    // The underlying data replicated (writes are never namespace-gated —
    // see server/README.md's "Schreibzugriffe... funktionieren unabhängig
    // vom Flag"), but B never had SPEED_CAMERA_NAMESPACE_ENABLED set, so its
    // own /v1/speed-cameras/* reads still filter it out regardless.
    const camerasOnB = await b.app.inject({
      method: "GET",
      url: "/v1/speed-cameras/nearby?lat=40&lng=40&radiusM=1000",
      headers: authHeader(await testToken(b.env)),
    });
    expect(camerasOnB.json().cameras).toEqual([]);
  });

  it("a device rate-limited on one server can still reach the network via another (per-server, not network-wide, rate limiting — a known, accepted characteristic, not a bug)", async () => {
    const sharedAuth = authHeader(await testToken(a.env, { sub: "rate-limit-probe" }));
    let last;
    for (let i = 0; i < 11; i++) {
      last = await a.app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: sharedAuth,
        payload: { type: "traffic", lat: 50 + i, lng: 50 + i },
      });
    }
    expect(last!.statusCode).toBe(429); // REPORT_RATE_LIMIT_MAX default is 10 — 11th on A is rejected

    // The same reporter identity, submitting to B instead, is unaffected —
    // B's moderation gate has its own independent counters.
    const onB = await b.app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: authHeader(await testToken(b.env, { sub: "rate-limit-probe" })),
      payload: { type: "traffic", lat: 60, lng: 60 },
    });
    expect(onB.statusCode).toBe(201);
  });
});
