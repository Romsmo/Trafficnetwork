import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { insertSpeedLimitSegment } from "./helpers.js";
import { generateClientId } from "../../src/modules/auth/credentials.js";
import { bindDevicePublicKey, insertClient } from "../../src/db/queries/clients.js";
import { generateEd25519KeyPair, type Ed25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import { joinSeeds, pullFromPeers, type FederationWorkerDeps } from "../../src/modules/federation/workers.js";
import type { SpeedLimitVotePayload } from "../../src/modules/speed-limit-corrections/vote.js";
import { correctionId } from "../../src/modules/speed-limit-corrections/tally.js";

/**
 * Community speed-limit corrections across a real network (add-on K-A,
 * docs/speed-limit-corrections.md D9): three listening servers, each with its
 * own Postgres, each importing the *same road geometry* independently (so the
 * segment row ids differ per server — only the content-derived segmentKey is
 * shared), plus a fourth server that has corrections switched off. Devices are
 * bound to, and vote at, their own server; every claim below is about what the
 * *other* servers end up with.
 */
describe("speed-limit corrections across the network (K-A)", () => {
  const PORTS = { a: 18841, b: 18842, c: 18843, off: 18844 };

  interface Node {
    testDb: TestDatabase;
    app: FastifyInstance;
    env: Env;
    address: string;
    workerDeps: FederationWorkerDeps;
  }

  async function startNode(port: number, overrides: Record<string, string> = {}): Promise<Node> {
    const testDb = await startTestDatabase();
    const address = `http://127.0.0.1:${port}`;
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      LOG_LEVEL: "silent",
      FEDERATION_ENABLED: "true",
      FEDERATION_PUBLIC_ADDRESS: address,
      ...overrides,
    });
    const app = await buildApp({ env, db: testDb.db });
    await app.listen({ port, host: "127.0.0.1" });
    return { testDb, app, env, address, workerDeps: { db: testDb.db, env, nodeIdentity: app.nodeIdentity, realtime: app.realtime, log: app.log } };
  }

  async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 10_000, intervalMs = 100): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await check();
      if (result !== undefined) return result;
      if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  let a: Node, b: Node, c: Node, off: Node;

  beforeAll(async () => {
    [a, b, c, off] = await Promise.all([
      startNode(PORTS.a),
      startNode(PORTS.b),
      startNode(PORTS.c),
      startNode(PORTS.off, { COMMUNITY_CORRECTIONS_ENABLED: "false" }),
    ]);
    await joinSeeds({ ...b.workerDeps, env: { ...b.env, FEDERATION_SEEDS: a.address } });
    await joinSeeds({ ...c.workerDeps, env: { ...c.env, FEDERATION_SEEDS: `${a.address},${b.address}` } });
    await joinSeeds({ ...off.workerDeps, env: { ...off.env, FEDERATION_SEEDS: a.address } });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([a, b, c, off].map(async (n) => {
      await n.app.close();
      await n.testDb.teardown();
    }));
  });

  // ---------------------------------------------------------------- helpers

  let counter = 0;
  interface Road {
    key: string;
    lat: number;
    lng: number;
    /** Row id of this road on each server — different on every one. */
    ids: Map<Node, string>;
  }
  /** The same road, imported independently on the given servers (default A, B, C). */
  async function importRoad(speedLimit = 30, nodes: Node[] = [a, b, c]): Promise<Road> {
    counter += 1;
    const lng = 12 + counter * 0.02;
    const lat = 48 + counter * 0.01;
    const ids = new Map<Node, string>();
    let key = "";
    for (const node of nodes) {
      const id = await insertSpeedLimitSegment(node.testDb.db, { lineString: [[lng, lat], [lng + 0.001, lat + 0.001]], speedLimit });
      ids.set(node, id);
      const rows = await node.testDb.db.execute<{ geometry_key: string } & Record<string, unknown>>(sql`select geometry_key from speed_limit_segments where id = ${id}`);
      if (key && key !== rows[0]!.geometry_key) throw new Error("the same geometry produced different keys on different servers");
      key = rows[0]!.geometry_key;
    }
    return { key, lat: lat + 0.0005, lng: lng + 0.0005, ids };
  }

  interface Device {
    node: Node;
    key: Ed25519KeyPair;
    headers: { authorization: string };
  }
  async function deviceAt(node: Node): Promise<Device> {
    const clientId = generateClientId();
    await insertClient(node.testDb.db, { clientId, clientSecretHash: "unused", scopes: ["client"], name: "device" });
    const key = generateEd25519KeyPair();
    await bindDevicePublicKey(node.testDb.db, clientId, key.publicKeyRaw);
    return { node, key, headers: authHeader(await testToken(node.env, { sub: clientId })) };
  }

  function signVote(device: Device, segmentKey: string, over: Partial<SpeedLimitVotePayload> = {}) {
    return signEnvelope<SpeedLimitVotePayload>(
      {
        kind: "speedLimitVote",
        vote: "support",
        segmentKey,
        value: 50,
        unit: "kmh",
        devicePublicKey: device.key.publicKeyRaw,
        timestamp: new Date().toISOString(),
        ...over,
      },
      device.key,
    );
  }

  async function propose(road: Road, device: Device, value = 50) {
    const res = await device.node.app.inject({
      method: "POST",
      url: `/v1/speed-limit-segments/${road.ids.get(device.node)}/corrections`,
      headers: device.headers,
      payload: { value, unit: "kmh", deviceAssertion: signVote(device, road.key, { value }) },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res;
  }

  async function deny(road: Road, device: Device, value = 50) {
    const res = await device.node.app.inject({
      method: "POST",
      url: `/v1/speed-limit-corrections/${correctionId(road.key, "kmh", value)}/confirmations`,
      headers: device.headers,
      payload: { kind: "deny", deviceAssertion: signVote(device, road.key, { vote: "deny", value }) },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
  }

  /** What a node serves for the road right now. */
  async function servedAt(node: Node, road: Road): Promise<{ speedLimit: number; correctedBy?: string; importedSpeedLimit?: number; correction?: { confirmations: number; denials: number } }> {
    const res = await node.app.inject({
      method: "GET",
      url: `/v1/speed-limit-segments/nearby?lat=${road.lat}&lng=${road.lng}&radiusM=100`,
      headers: authHeader(await testToken(node.env)),
    });
    const found = (res.json().segments as { id: string; segmentKey: string }[]).find((s) => s.segmentKey === road.key);
    if (!found) throw new Error(`${node.address} does not serve the road`);
    return found as never;
  }

  async function everyNodeServes(road: Road, expected: number, nodes: Node[] = [a, b, c]): Promise<void> {
    for (const node of nodes) {
      await waitFor(async () => ((await servedAt(node, road)).speedLimit === expected ? true : undefined));
    }
  }

  async function votesAt(node: Node, road: Road): Promise<number> {
    const rows = await node.testDb.db.execute<{ total: number } & Record<string, unknown>>(sql`
      select count(*)::int as total from speed_limit_correction_votes where segment_key = ${road.key}
    `);
    return rows[0]!.total;
  }

  /** Replication is asynchronous — wait until the node has actually received `count` votes before asserting on what it serves. */
  async function waitForVotes(node: Node, road: Road, count: number): Promise<void> {
    await waitFor(async () => ((await votesAt(node, road)) >= count ? true : undefined));
  }

  // ---------------------------------------------------------------- convergence

  it("three devices on three different servers make a correction effective on all of them — the same geometry, different row ids", async () => {
    const road = await importRoad(30);
    expect(new Set(road.ids.values()).size).toBe(3);

    await propose(road, await deviceAt(a));
    await propose(road, await deviceAt(b));
    // Two of three: nothing is effective anywhere yet — once every server has actually heard both.
    for (const node of [a, b, c]) await waitForVotes(node, road, 2);
    for (const node of [a, b, c]) expect((await servedAt(node, road)).speedLimit).toBe(30);

    await propose(road, await deviceAt(c));
    await everyNodeServes(road, 50);
    for (const node of [a, b, c]) {
      expect(await servedAt(node, road)).toMatchObject({ speedLimit: 50, correctedBy: "community", importedSpeedLimit: 30, correction: { confirmations: 3, denials: 0 } });
    }
  });

  it("a denial made on one server flips the correction on every server", async () => {
    const road = await importRoad(30);
    for (const node of [a, b, c]) await propose(road, await deviceAt(node));
    await everyNodeServes(road, 50);

    await deny(road, await deviceAt(b));
    await everyNodeServes(road, 30);
    for (const node of [a, b, c]) expect((await servedAt(node, road)).correctedBy).toBeUndefined();
  });

  it("competing values converge on the same winner everywhere, whichever server heard what first", async () => {
    const road = await importRoad(30);
    for (let i = 0; i < 3; i++) await propose(road, await deviceAt(a), 50);
    for (let i = 0; i < 4; i++) await propose(road, await deviceAt(b), 60);
    await everyNodeServes(road, 60);
    for (const node of [a, b, c]) {
      expect(await servedAt(node, road)).toMatchObject({ speedLimit: 60, correctedBy: "community", correction: { confirmations: 4 } });
    }
  }, 30_000);

  it("a tie is a tie on every server", async () => {
    const road = await importRoad(30);
    for (let i = 0; i < 3; i++) await propose(road, await deviceAt(a), 50);
    for (let i = 0; i < 3; i++) await propose(road, await deviceAt(b), 60);
    // 3 vs 3: the imported value stays, on every server.
    await everyNodeServes(road, 30);
    await propose(road, await deviceAt(c), 60);
    await everyNodeServes(road, 60);
  }, 30_000);

  it("the same vote reaching a server twice (pushed and pulled) is counted once", async () => {
    const road = await importRoad(30);
    const d = await deviceAt(a);
    await propose(road, d);
    await waitForVotes(b, road, 1);
    await waitForVotes(c, road, 1);
    await pullFromPeers(b.workerDeps); // B pulls what A already pushed (and C may have relayed)
    await pullFromPeers(b.workerDeps);
    expect(await votesAt(b, road)).toBe(1);
    expect(await votesAt(c, road)).toBe(1);
  });

  // ---------------------------------------------------------------- not forgeable

  it("a relayed vote cannot be altered: a tampered envelope is rejected as an invalid signature and costs the sender its reputation", async () => {
    const road = await importRoad(30);
    const d = await deviceAt(a);
    const genuine = signVote(d, road.key, { value: 50 });
    const tampered = { ...genuine, payload: { ...genuine.payload, value: 130 } };

    const push = await b.app.inject({
      method: "POST",
      url: "/v1/federation/events",
      payload: { senderNodeId: a.app.nodeIdentity.nodeId, events: [], speedLimitVotes: [tampered] },
    });
    expect(push.statusCode).toBe(200);
    expect(push.json().results[0]).toMatchObject({ status: "rejected", code: "invalid_signature" });
    const stored = await b.testDb.db.execute(sql`select 1 from speed_limit_correction_votes where segment_key = ${road.key}`);
    expect(stored).toHaveLength(0);

    const peer = (await b.app.inject({ method: "GET", url: "/v1/federation/peers" })).json().peers.find((p: { nodeId: string }) => p.nodeId === a.app.nodeIdentity.nodeId);
    expect(peer.invalidSignatureCount).toBeGreaterThanOrEqual(1);
  });

  it("rejects an implausible replicated value with the same limits as a local one, without blaming the sender", async () => {
    const road = await importRoad(30);
    const d = await deviceAt(a);
    const before = (await b.app.inject({ method: "GET", url: "/v1/federation/peers" })).json().peers.find((p: { nodeId: string }) => p.nodeId === a.app.nodeIdentity.nodeId).invalidSignatureCount as number;
    const push = await b.app.inject({
      method: "POST",
      url: "/v1/federation/events",
      payload: { senderNodeId: a.app.nodeIdentity.nodeId, speedLimitVotes: [signVote(d, road.key, { value: 500 })] },
    });
    expect(push.json().results[0]).toMatchObject({ status: "rejected", code: "implausible" });
    const after = (await b.app.inject({ method: "GET", url: "/v1/federation/peers" })).json().peers.find((p: { nodeId: string }) => p.nodeId === a.app.nodeIdentity.nodeId).invalidSignatureCount as number;
    expect(after).toBe(before);
  });

  it("rejects a vote dated in the future but has no maximum age (durable state, not a 72-hour report)", async () => {
    const road = await importRoad(30);
    const d = await deviceAt(a);
    const future = await b.app.inject({
      method: "POST",
      url: "/v1/federation/events",
      payload: { senderNodeId: a.app.nodeIdentity.nodeId, speedLimitVotes: [signVote(d, road.key, { timestamp: new Date(Date.now() + 3_600_000).toISOString() })] },
    });
    expect(future.json().results[0]).toMatchObject({ status: "rejected", code: "future_timestamp" });

    const old = await b.app.inject({
      method: "POST",
      url: "/v1/federation/events",
      payload: { senderNodeId: a.app.nodeIdentity.nodeId, speedLimitVotes: [signVote(d, road.key, { timestamp: new Date(Date.now() - 400 * 24 * 3_600_000).toISOString() })] },
    });
    expect(old.json().results[0]).toMatchObject({ status: "recorded" });
  });

  // ---------------------------------------------------------------- local-only

  it("an unsigned vote counts on the server it was sent to but is never replicated", async () => {
    const road = await importRoad(30);
    const res = await a.app.inject({
      method: "POST",
      url: `/v1/speed-limit-segments/${road.ids.get(a)}/corrections`,
      headers: authHeader(await testToken(a.env, { sub: "web:anonymous-1" })),
      payload: { value: 50, unit: "kmh" },
    });
    expect(res.statusCode).toBe(201);

    const stream = (await a.app.inject({ method: "GET", url: "/v1/federation/speed-limit-votes?after=0&limit=500" })).json();
    expect(stream.votes.some((v: { envelope: { payload: { segmentKey: string } } }) => v.envelope.payload.segmentKey === road.key)).toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    const onB = await b.testDb.db.execute(sql`select 1 from speed_limit_correction_votes where segment_key = ${road.key}`);
    expect(onB).toHaveLength(0);
    expect((await servedAt(a, road)).correction).toBeUndefined(); // 1 of 3: not effective, but recorded locally
    const local = await a.testDb.db.execute(sql`select 1 from speed_limit_correction_votes where segment_key = ${road.key}`);
    expect(local).toHaveLength(1);
  });

  // ---------------------------------------------------------------- partition / late joiner

  it("a server that was unreachable catches up through the pull stream once it is back, and lands on the same value", async () => {
    const road = await importRoad(30);
    await c.app.close(); // C is partitioned away

    for (let i = 0; i < 2; i++) await propose(road, await deviceAt(a));
    await propose(road, await deviceAt(b));
    await everyNodeServes(road, 50, [a, b]);

    const restarted = await buildApp({ env: c.env, db: c.testDb.db });
    await restarted.listen({ port: PORTS.c, host: "127.0.0.1" });
    c = { ...c, app: restarted, workerDeps: { ...c.workerDeps, nodeIdentity: restarted.nodeIdentity, realtime: restarted.realtime, log: restarted.log } };

    // The gap is real...
    expect((await servedAt(c, road)).speedLimit).toBe(30);
    // ...and one anti-entropy cycle closes it.
    await pullFromPeers(c.workerDeps);
    expect(await servedAt(c, road)).toMatchObject({ speedLimit: 50, correctedBy: "community", correction: { confirmations: 3 } });
  }, 60_000);

  it("votes made on both sides of a partition merge to the same result on all servers when it heals", async () => {
    const road = await importRoad(30);
    // While A, B and C cannot see each other, each hears different votes: cut the mesh by
    // voting straight into each database-backed app *without* fan-out (the peers table is
    // emptied on the sending side for the duration).
    const savedPeers = new Map<Node, unknown[]>();
    for (const node of [a, b, c]) {
      savedPeers.set(node, await node.testDb.db.execute(sql`select * from network_peers`));
      await node.testDb.db.execute(sql`delete from network_peers`);
    }
    await propose(road, await deviceAt(a), 50);
    await propose(road, await deviceAt(a), 50);
    await propose(road, await deviceAt(b), 60);
    await propose(road, await deviceAt(c), 50);
    await propose(road, await deviceAt(c), 60);
    await new Promise((r) => setTimeout(r, 300));
    // Split brain: nobody has the whole picture. (A: 50x2; B: 60x1; C: 50x1, 60x1.)
    expect((await servedAt(a, road)).speedLimit).toBe(30);

    for (const node of [a, b, c]) {
      for (const p of savedPeers.get(node) as { node_id: string; public_key: string; address: string; discovered_via: string; joined_at: string }[]) {
        await node.testDb.db.execute(sql`
          insert into network_peers (node_id, public_key, address, discovered_via, joined_at)
          values (${p.node_id}, ${p.public_key}, ${p.address}, ${p.discovered_via}::peer_discovery_source, ${p.joined_at})
        `);
      }
    }
    // Heal: every server pulls from every other, in whatever order the loop happens to run.
    await pullFromPeers(c.workerDeps);
    await pullFromPeers(a.workerDeps);
    await pullFromPeers(b.workerDeps);

    // Total picture: 50 has 3 supporters (A,A,C), 60 has 2 (B,C) → 50 wins everywhere; the
    // pulls above only deliver what each peer already *held*, so a second round settles it.
    await pullFromPeers(c.workerDeps);
    await pullFromPeers(a.workerDeps);
    await pullFromPeers(b.workerDeps);
    await everyNodeServes(road, 50);
  }, 60_000);

  // ---------------------------------------------------------------- feature off

  it("a server with corrections switched off ignores pushed votes and does not offer the pull stream — and is not penalised for that", async () => {
    const road = await importRoad(30, [a, b, c, off]);
    const d = await deviceAt(a);
    const push = await off.app.inject({
      method: "POST",
      url: "/v1/federation/events",
      payload: { senderNodeId: a.app.nodeIdentity.nodeId, speedLimitVotes: [signVote(d, road.key)] },
    });
    expect(push.statusCode).toBe(200);
    expect(push.json().results[0]).toMatchObject({ status: "ignored" });
    expect(await off.testDb.db.execute(sql`select 1 from speed_limit_correction_votes`)).toHaveLength(0);

    expect((await off.app.inject({ method: "GET", url: "/v1/federation/speed-limit-votes" })).statusCode).toBe(404);

    // A's pull worker meets the 404, skips the stream and keeps the peer healthy.
    await pullFromPeers(a.workerDeps);
    const offAsSeenByA = (await a.app.inject({ method: "GET", url: "/v1/federation/peers" })).json().peers.find((p: { nodeId: string }) => p.nodeId === off.app.nodeIdentity.nodeId);
    expect(offAsSeenByA.consecutiveHealthCheckFailures).toBe(0);
    const cursor = await a.testDb.db.execute<{ last_pulled_votes_sequence: number | null } & Record<string, unknown>>(sql`
      select last_pulled_votes_sequence from network_peers where node_id = ${off.app.nodeIdentity.nodeId}
    `);
    expect(cursor[0]!.last_pulled_votes_sequence).toBeNull();

    // And the switched-off server keeps serving the imported value while the others apply the correction.
    for (const node of [a, b]) await propose(road, await deviceAt(node));
    await propose(road, await deviceAt(c));
    await everyNodeServes(road, 50, [a, b, c]);
    const offServed = await off.app.inject({
      method: "GET",
      url: `/v1/speed-limit-segments/nearby?lat=${road.lat}&lng=${road.lng}&radiusM=100`,
      headers: authHeader(await testToken(off.env)),
    });
    expect(offServed.json().segments.find((s: { segmentKey: string }) => s.segmentKey === road.key).speedLimit).toBe(30);
  }, 60_000);

  it("keeps the existing push format working: a push with only report events and no speedLimitVotes field is unchanged", async () => {
    const res = await b.app.inject({ method: "POST", url: "/v1/federation/events", payload: { senderNodeId: a.app.nodeIdentity.nodeId, events: [] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: [] });
  });
});
