import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { generateEd25519KeyPair, keyId } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import type { JoinRequestPayload, HeartbeatPayload } from "../../src/modules/federation/protocol.js";
import type { NetworkConfigPayload } from "../../src/modules/network/config.js";

/**
 * F-S3: join over seeds, peer directory + gossip, signed heartbeats. Each
 * "peer" here is a hand-built self-signed envelope (this server's own
 * perspective as the *receiving* side of join/heartbeat/push) rather than a
 * second running app instance — a real two-server round trip is exactly what
 * F-S5's multi-node test network is for (see docs/todo.md's milestone
 * table); these tests verify this server's own protocol handling in isolation.
 */
describe("federation peer directory (F-S3)", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      FEDERATION_ENABLED: "true",
      FEDERATION_PUBLIC_ADDRESS: "https://node-under-test.example",
    });
    app = await buildApp({ env, db: testDb.db });
  });

  afterEach(async () => {
    await testDb.db.execute(sql`truncate table network_peers restart identity cascade`);
  });

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  function joinPayload(overrides: Partial<JoinRequestPayload> & { publicKey: string; nodeId: string }): JoinRequestPayload {
    return { requestedAt: new Date().toISOString(), address: "https://peer.example", ...overrides };
  }

  it("accepts a valid self-signed join request and returns self + the known peer list", async () => {
    const peer = generateEd25519KeyPair();
    const envelope = signEnvelope(joinPayload({ nodeId: keyId(peer.publicKeyRaw), publicKey: peer.publicKeyRaw }), peer);

    const res = await app.inject({ method: "POST", url: "/v1/federation/join", payload: envelope });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.self.nodeId).toBe(app.nodeIdentity.nodeId);
    expect(body.peers.map((p: { nodeId: string }) => p.nodeId)).toContain(keyId(peer.publicKeyRaw));
  });

  it("rejects a join whose nodeId doesn't match keyId(publicKey)", async () => {
    const peer = generateEd25519KeyPair();
    const envelope = signEnvelope(joinPayload({ nodeId: "not-the-real-keyid", publicKey: peer.publicKeyRaw }), peer);
    const res = await app.inject({ method: "POST", url: "/v1/federation/join", payload: envelope });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a join signed by a different key than it claims", async () => {
    const claimed = generateEd25519KeyPair();
    const actualSigner = generateEd25519KeyPair();
    const envelope = signEnvelope(joinPayload({ nodeId: keyId(claimed.publicKeyRaw), publicKey: claimed.publicKeyRaw }), actualSigner);
    const res = await app.inject({ method: "POST", url: "/v1/federation/join", payload: envelope });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a stale join request", async () => {
    const peer = generateEd25519KeyPair();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const envelope = signEnvelope(
      joinPayload({ nodeId: keyId(peer.publicKeyRaw), publicKey: peer.publicKeyRaw, requestedAt: stale }),
      peer,
    );
    const res = await app.inject({ method: "POST", url: "/v1/federation/join", payload: envelope });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a join whose address isn't https://", async () => {
    const peer = generateEd25519KeyPair();
    const envelope = signEnvelope(
      joinPayload({ nodeId: keyId(peer.publicKeyRaw), publicKey: peer.publicKeyRaw, address: "http://insecure.example" }),
      peer,
    );
    const res = await app.inject({ method: "POST", url: "/v1/federation/join", payload: envelope });
    expect(res.statusCode).toBe(400);
  });

  it("rejects joining to self", async () => {
    // Sign with this server's own node identity — impossible for a real
    // outside peer, but a clean way to exercise the self-join guard.
    const selfKeyPair = { publicKeyRaw: app.nodeIdentity.publicKeyRaw, privateKeyRaw: app.nodeIdentity.privateKeyRaw };
    const envelope = signEnvelope(
      joinPayload({ nodeId: app.nodeIdentity.nodeId, publicKey: app.nodeIdentity.publicKeyRaw }),
      selfKeyPair,
    );
    const res = await app.inject({ method: "POST", url: "/v1/federation/join", payload: envelope });
    expect(res.statusCode).toBe(400);
  });

  it("GET /v1/federation/peers reflects a previously joined peer", async () => {
    const peer = generateEd25519KeyPair();
    const envelope = signEnvelope(joinPayload({ nodeId: keyId(peer.publicKeyRaw), publicKey: peer.publicKeyRaw }), peer);
    await app.inject({ method: "POST", url: "/v1/federation/join", payload: envelope });

    const res = await app.inject({ method: "GET", url: "/v1/federation/peers" });
    expect(res.statusCode).toBe(200);
    expect(res.json().peers.map((p: { nodeId: string }) => p.nodeId)).toContain(keyId(peer.publicKeyRaw));
  });

  describe("heartbeat", () => {
    async function joinedPeer() {
      const peer = generateEd25519KeyPair();
      const nodeId = keyId(peer.publicKeyRaw);
      const envelope = signEnvelope(joinPayload({ nodeId, publicKey: peer.publicKeyRaw }), peer);
      await app.inject({ method: "POST", url: "/v1/federation/join", payload: envelope });
      return { peer, nodeId };
    }

    function heartbeatPayload(overrides: Partial<HeartbeatPayload> & { nodeId: string }): HeartbeatPayload {
      return { address: "https://peer.example", version: "1", timestamp: new Date().toISOString(), ...overrides };
    }

    it("rejects a heartbeat from an unknown (never-joined) peer", async () => {
      const stranger = generateEd25519KeyPair();
      const envelope = signEnvelope(heartbeatPayload({ nodeId: keyId(stranger.publicKeyRaw) }), stranger);
      const res = await app.inject({ method: "POST", url: "/v1/federation/heartbeat", payload: envelope });
      expect(res.statusCode).toBe(404);
    });

    it("accepts a valid heartbeat from a known peer and updates its address", async () => {
      const { peer, nodeId } = await joinedPeer();
      const envelope = signEnvelope(heartbeatPayload({ nodeId, address: "https://peer-new-address.example" }), peer);
      const res = await app.inject({ method: "POST", url: "/v1/federation/heartbeat", payload: envelope });
      expect(res.statusCode).toBe(200);

      const peers = (await app.inject({ method: "GET", url: "/v1/federation/peers" })).json().peers;
      const found = peers.find((p: { nodeId: string }) => p.nodeId === nodeId);
      expect(found.address).toBe("https://peer-new-address.example");
      expect(found.lastSeenAt).not.toBeNull();
    });

    it("rejects a heartbeat verified against the wrong (non-registered) key", async () => {
      const { nodeId } = await joinedPeer();
      const impostor = generateEd25519KeyPair();
      const envelope = signEnvelope(heartbeatPayload({ nodeId }), impostor);
      const res = await app.inject({ method: "POST", url: "/v1/federation/heartbeat", payload: envelope });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a stale heartbeat", async () => {
      const { peer, nodeId } = await joinedPeer();
      const stale = new Date(Date.now() - 10 * 60_000).toISOString();
      const envelope = signEnvelope(heartbeatPayload({ nodeId, timestamp: stale }), peer);
      const res = await app.inject({ method: "POST", url: "/v1/federation/heartbeat", payload: envelope });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("exclusion list (signed network config)", () => {
    let excludedApp: FastifyInstance;
    let dir: string;

    afterEach(async () => {
      if (excludedApp) await excludedApp.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("rejects join/heartbeat from a node listed in the network config's excludedNodeIds", async () => {
      const excludedPeer = generateEd25519KeyPair();
      const excludedNodeId = keyId(excludedPeer.publicKeyRaw);

      const root = generateEd25519KeyPair();
      dir = mkdtempSync(path.join(tmpdir(), "federation-exclusion-"));
      const payload: NetworkConfigPayload = {
        version: 1,
        blitzerEnabled: false,
        eventLogRetentionDaysDynamic: 3,
        eventLogRetentionDaysStatic: 30,
        minVersion: "0.1.0",
        excludedNodeIds: [excludedNodeId],
        issuedAt: new Date().toISOString(),
      };
      const configPath = path.join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify(signEnvelope(payload, root)));

      resetEnvCache();
      const env = loadEnv({
        DATABASE_URL: testDb.container.getConnectionUri(),
        JWT_SECRET: "a".repeat(32),
        FEDERATION_ENABLED: "true",
        FEDERATION_PUBLIC_ADDRESS: "https://node-under-test.example",
        NETWORK_CONFIG_PATH: configPath,
        NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw,
      });
      excludedApp = await buildApp({ env, db: testDb.db });

      const envelope = signEnvelope(joinPayload({ nodeId: excludedNodeId, publicKey: excludedPeer.publicKeyRaw }), excludedPeer);
      const res = await excludedApp.inject({ method: "POST", url: "/v1/federation/join", payload: envelope });
      expect(res.statusCode).toBe(403);
    });
  });
});
