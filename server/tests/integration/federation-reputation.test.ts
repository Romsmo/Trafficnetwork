import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { generateEd25519KeyPair, keyId } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import type { JoinRequestPayload } from "../../src/modules/federation/protocol.js";
import type { DeviceCreateEventPayload } from "../../src/modules/federation/device-event.js";
import { recordHealthCheckSuccess } from "../../src/db/queries/network-peers.js";
import { beginPush, resetLoadGaugeForTests } from "../../src/modules/federation/load.js";

/** F-S4: reputation tiers, the directory endpoint, and the overload signal. */
describe("federation reputation & directory (F-S4)", () => {
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
      REPUTATION_PROBATION_MIN_HOURS: "24",
      REPUTATION_MIN_SUCCESSFUL_HEALTH_CHECKS: "3",
      FEDERATION_OVERLOAD_MAX_CONCURRENT_PUSHES: "2",
    });
    app = await buildApp({ env, db: testDb.db });
  });

  afterEach(async () => {
    await testDb.db.execute(sql`truncate table hazard_confirmations, hazard_reports, event_log, network_peers restart identity cascade`);
    resetLoadGaugeForTests();
  });

  beforeEach(() => {
    resetLoadGaugeForTests();
  });

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  async function joinAsPeer(): Promise<{ nodeId: string }> {
    const peer = generateEd25519KeyPair();
    const nodeId = keyId(peer.publicKeyRaw);
    const payload: JoinRequestPayload = { nodeId, publicKey: peer.publicKeyRaw, address: "https://peer.example", requestedAt: new Date().toISOString() };
    const envelope = signEnvelope(payload, peer);
    const res = await app.inject({ method: "POST", url: "/v1/federation/join", payload: envelope });
    expect(res.statusCode).toBe(200);
    return { nodeId };
  }

  /** Test-only: reputation age thresholds need a peer that's been known for a while, which a fresh join can't produce on its own. */
  async function backdateJoinedAt(nodeId: string, hoursAgo: number): Promise<void> {
    await testDb.db.execute(sql`
      update network_peers set joined_at = now() - make_interval(hours => ${hoursAgo}) where node_id = ${nodeId}
    `);
  }

  describe("GET /v1/network/directory", () => {
    it("always includes self, even with no peers (e.g. FEDERATION_ENABLED=false)", async () => {
      resetEnvCache();
      const soloEnv = loadEnv({ DATABASE_URL: testDb.container.getConnectionUri(), JWT_SECRET: "a".repeat(32) });
      const soloApp = await buildApp({ env: soloEnv, db: testDb.db });
      const res = await soloApp.inject({ method: "GET", url: "/v1/network/directory" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.self.nodeId).toBe(soloApp.nodeIdentity.nodeId);
      expect(body.peers).toEqual([]);
      await soloApp.close();
    });

    it("lists a freshly joined peer on probation", async () => {
      const { nodeId } = await joinAsPeer();
      const res = await app.inject({ method: "GET", url: "/v1/network/directory" });
      const entry = res.json().peers.find((p: { nodeId: string }) => p.nodeId === nodeId);
      expect(entry.tier).toBe("probation");
    });

    it("promotes a peer to active once age and successful-health-check thresholds are met", async () => {
      const { nodeId } = await joinAsPeer();
      await backdateJoinedAt(nodeId, 48);
      await recordHealthCheckSuccess(testDb.db, nodeId);
      await recordHealthCheckSuccess(testDb.db, nodeId);
      await recordHealthCheckSuccess(testDb.db, nodeId);

      const res = await app.inject({ method: "GET", url: "/v1/network/directory" });
      const entry = res.json().peers.find((p: { nodeId: string }) => p.nodeId === nodeId);
      expect(entry.tier).toBe("active");
    });

    it("caps the share of probation-tier peers returned", async () => {
      resetEnvCache();
      const cappedEnv = loadEnv({
        DATABASE_URL: testDb.container.getConnectionUri(),
        JWT_SECRET: "a".repeat(32),
        FEDERATION_ENABLED: "true",
        FEDERATION_PUBLIC_ADDRESS: "https://node-under-test.example",
        REPUTATION_DIRECTORY_PROBATION_MAX_SHARE: "0",
      });
      const cappedApp = await buildApp({ env: cappedEnv, db: testDb.db });
      await joinAsPeer();
      await joinAsPeer();

      const res = await cappedApp.inject({ method: "GET", url: "/v1/network/directory" });
      expect(res.json().peers).toEqual([]); // 0% share -> every probation entry excluded
      await cappedApp.close();
    });
  });

  describe("reputation demotion via invalid signatures", () => {
    it("records an invalid-signature push against the sending peer and reflects it in the directory", async () => {
      const { nodeId } = await joinAsPeer();
      const device = generateEd25519KeyPair();
      const impostor = generateEd25519KeyPair();
      const badPayload: DeviceCreateEventPayload = {
        kind: "create",
        type: "ice",
        lat: 1,
        lng: 1,
        devicePublicKey: device.publicKeyRaw,
        timestamp: new Date().toISOString(),
      };
      const forged = signEnvelope(badPayload, impostor); // signed by the wrong key -> invalid_signature

      const push = await app.inject({
        method: "POST",
        url: "/v1/federation/events",
        payload: { senderNodeId: nodeId, events: [forged] },
      });
      expect(push.json().results[0]).toMatchObject({ status: "rejected", code: "invalid_signature" });

      const directory = await app.inject({ method: "GET", url: "/v1/network/directory" });
      const entry = directory.json().peers.find((p: { nodeId: string }) => p.nodeId === nodeId);
      expect(entry.tier).toBe("probation");
    });
  });

  describe("overload signal (503 + Retry-After)", () => {
    it("returns 503 with Retry-After once the concurrent-push limit is reached", async () => {
      const { nodeId } = await joinAsPeer();
      // FEDERATION_OVERLOAD_MAX_CONCURRENT_PUSHES=2 for this describe block's app.
      beginPush();
      beginPush();

      const res = await app.inject({
        method: "POST",
        url: "/v1/federation/events",
        payload: { senderNodeId: nodeId, events: [] },
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBeDefined();
      expect(res.json().error.code).toBe("OVERLOADED");
    });

    it("processes normally when under the concurrency limit", async () => {
      const { nodeId } = await joinAsPeer();
      const res = await app.inject({
        method: "POST",
        url: "/v1/federation/events",
        payload: { senderNodeId: nodeId, events: [] },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
