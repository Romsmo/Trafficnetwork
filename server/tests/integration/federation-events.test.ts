import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { generateEd25519KeyPair, keyId } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import type { JoinRequestPayload } from "../../src/modules/federation/protocol.js";
import type { DeviceCreateEventPayload } from "../../src/modules/federation/device-event.js";

/**
 * F-S3: device-signed create-event replication (push + pull), and the local
 * capture point (POST /v1/hazard-reports' optional deviceAssertion) that
 * feeds it. Gossip fan-out to *other* peers isn't exercised here — with 0 or
 * 1 known peers in these tests there's nothing to fan out to; F-S5's
 * multi-node network is where real cross-server delivery gets verified.
 */
describe("federation event replication (F-S3)", () => {
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
      DUPLICATE_MERGE_RADIUS_METERS: "500",
    });
    app = await buildApp({ env, db: testDb.db });
  });

  afterEach(async () => {
    await testDb.db.execute(sql`truncate table hazard_confirmations, hazard_reports, event_log, network_peers restart identity cascade`);
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

  describe("POST /v1/federation/events (push, receiving side)", () => {
    it("rejects a push from an unknown (never-joined) senderNodeId", async () => {
      const device = generateEd25519KeyPair();
      const res = await app.inject({
        method: "POST",
        url: "/v1/federation/events",
        payload: { senderNodeId: "unknown-node", events: [deviceCreateEnvelope(device)] },
      });
      expect(res.statusCode).toBe(403);
    });

    it("ingests a valid device-signed create event from a known peer and materializes a hazard report", async () => {
      const { nodeId } = await joinAsPeer();
      const device = generateEd25519KeyPair();
      const envelope = deviceCreateEnvelope(device, { lat: 48.1, lng: 11.5 });

      const res = await app.inject({
        method: "POST",
        url: "/v1/federation/events",
        payload: { senderNodeId: nodeId, events: [envelope] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().results).toEqual([{ federationEventId: expect.any(String), status: "created" }]);

      const nearby = await app.inject({
        method: "GET",
        url: "/v1/hazard-reports/nearby?lat=48.1&lng=11.5&radiusM=1000",
        headers: authHeader(await testToken(app.deps.env)),
      });
      const reports = nearby.json().reports;
      expect(reports).toHaveLength(1);
      expect(reports[0].reporterId).toBe(`device:${keyId(device.publicKeyRaw)}`);
    });

    it("is idempotent: pushing the exact same event twice reports \"duplicate\" and creates only one report", async () => {
      const { nodeId } = await joinAsPeer();
      const device = generateEd25519KeyPair();
      const envelope = deviceCreateEnvelope(device, { lat: 40, lng: 40 });

      const first = await app.inject({ method: "POST", url: "/v1/federation/events", payload: { senderNodeId: nodeId, events: [envelope] } });
      expect(first.json().results[0].status).toBe("created");
      const second = await app.inject({ method: "POST", url: "/v1/federation/events", payload: { senderNodeId: nodeId, events: [envelope] } });
      expect(second.json().results[0].status).toBe("duplicate");

      const count = await testDb.db.execute<{ n: number } & Record<string, unknown>>(sql`select count(*)::int as n from hazard_reports`);
      expect(count[0]?.n).toBe(1);
    });

    it("merges a second nearby device-signed create into the first as a confirmation", async () => {
      const { nodeId } = await joinAsPeer();
      const deviceA = generateEd25519KeyPair();
      const deviceB = generateEd25519KeyPair();
      const first = deviceCreateEnvelope(deviceA, { lat: 55, lng: 5, type: "accident" });
      const second = deviceCreateEnvelope(deviceB, { lat: 55.0009, lng: 5, type: "accident" }); // ~100m away

      await app.inject({ method: "POST", url: "/v1/federation/events", payload: { senderNodeId: nodeId, events: [first] } });
      const res = await app.inject({ method: "POST", url: "/v1/federation/events", payload: { senderNodeId: nodeId, events: [second] } });
      expect(res.json().results[0].status).toBe("merged");

      const count = await testDb.db.execute<{ n: number } & Record<string, unknown>>(sql`select count(*)::int as n from hazard_reports`);
      expect(count[0]?.n).toBe(1);
      const report = await testDb.db.execute<{ confirm_count: number } & Record<string, unknown>>(
        sql`select confirm_count from hazard_reports limit 1`,
      );
      expect(report[0]?.confirm_count).toBe(1);
    });

    it("rejects an event with a signature that doesn't verify, without failing the whole batch", async () => {
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
      const forged = signEnvelope(badPayload, impostor); // signed by the wrong key
      const good = deviceCreateEnvelope(generateEd25519KeyPair(), { lat: 2, lng: 2 });

      const res = await app.inject({
        method: "POST",
        url: "/v1/federation/events",
        payload: { senderNodeId: nodeId, events: [forged, good] },
      });
      expect(res.json().results[0].status).toBe("rejected");
      expect(res.json().results[1].status).toBe("created");
    });

    it("rejects fixedSpeedCamera device events (out of scope for federation this milestone)", async () => {
      const { nodeId } = await joinAsPeer();
      const device = generateEd25519KeyPair();
      const envelope = deviceCreateEnvelope(device, { type: "fixedSpeedCamera" });
      const res = await app.inject({ method: "POST", url: "/v1/federation/events", payload: { senderNodeId: nodeId, events: [envelope] } });
      expect(res.json().results[0].status).toBe("rejected");
    });
  });

  describe("GET /v1/federation/events (pull)", () => {
    it("returns nothing for a server with no federation-eligible events yet", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/federation/events?after=0" });
      expect(res.statusCode).toBe(200);
      expect(res.json().events).toEqual([]);
    });

    it("returns a federation-eligible event created locally via POST /v1/hazard-reports' deviceAssertion", async () => {
      const device = generateEd25519KeyPair();
      const envelope = deviceCreateEnvelope(device, { lat: 33, lng: 33, type: "obstacle" });
      const create = await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: authHeader(await testToken(app.deps.env)),
        payload: { type: "obstacle", lat: 33, lng: 33, deviceAssertion: envelope },
      });
      expect(create.statusCode).toBe(201);

      const pull = await app.inject({ method: "GET", url: "/v1/federation/events?after=0" });
      expect(pull.json().events).toHaveLength(1);
      expect(pull.json().events[0].envelope.payload.devicePublicKey).toBe(device.publicKeyRaw);
    });

    it("does not include reports created without a deviceAssertion", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: authHeader(await testToken(app.deps.env)),
        payload: { type: "traffic", lat: 34, lng: 34 },
      });
      const pull = await app.inject({ method: "GET", url: "/v1/federation/events?after=0" });
      expect(pull.json().events).toEqual([]);
    });
  });

  describe("POST /v1/hazard-reports deviceAssertion capture", () => {
    it("rejects a deviceAssertion whose payload doesn't match the submitted fields", async () => {
      const device = generateEd25519KeyPair();
      const envelope = deviceCreateEnvelope(device, { lat: 10, lng: 10 });
      const res = await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: authHeader(await testToken(app.deps.env)),
        // lat differs from what was actually signed.
        payload: { type: "ice", lat: 99, lng: 10, deviceAssertion: envelope },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects resubmitting the exact same signed report a second time", async () => {
      const device = generateEd25519KeyPair();
      const envelope = deviceCreateEnvelope(device, { lat: 44, lng: 44 });
      const auth = authHeader(await testToken(app.deps.env));
      const first = await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: auth,
        payload: { type: "ice", lat: 44, lng: 44, deviceAssertion: envelope },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: auth,
        payload: { type: "ice", lat: 44, lng: 44, deviceAssertion: envelope },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe("DUPLICATE_FEDERATION_EVENT");
    });
  });
});
