import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { generateClientId, generateClientSecret, hashSecret } from "../../src/modules/auth/credentials.js";
import { insertClient } from "../../src/db/queries/clients.js";
import { authHeader, testToken } from "./auth-helper.js";
import { generateEd25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";

/**
 * F-S2: additive, geräteseitig signierte Auth (asymmetric device identity)
 * alongside the existing symmetric clientSecret flow — see
 * docs/threat-model.md's migration path and docs/federation.md section 2.
 */
describe("device-signed auth (F-S2)", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    resetEnvCache();
    const env = loadEnv({ DATABASE_URL: testDb.container.getConnectionUri(), JWT_SECRET: "a".repeat(32) });
    app = await buildApp({ env, db: testDb.db });
  });

  afterEach(async () => {
    await testDb.db.execute(sql`truncate table clients restart identity cascade`);
  });

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  async function createClient(): Promise<{ clientId: string; secret: string }> {
    const clientId = generateClientId();
    const secret = generateClientSecret();
    await insertClient(testDb.db, {
      clientId,
      clientSecretHash: await hashSecret(secret),
      scopes: ["client"],
      name: "test-client",
    });
    return { clientId, secret };
  }

  it("binds a device key to an existing client and then authenticates via device-token", async () => {
    const { clientId } = await createClient();
    const deviceKey = generateEd25519KeyPair();
    const existingToken = authHeader(await testToken(app.deps.env, { sub: clientId, scopes: ["client"] }));

    const bindAssertion = signEnvelope({ publicKey: deviceKey.publicKeyRaw, timestamp: new Date().toISOString() }, deviceKey);
    const bindRes = await app.inject({
      method: "POST",
      url: "/v1/devices/bind-key",
      headers: existingToken,
      payload: { assertion: bindAssertion },
    });
    expect(bindRes.statusCode).toBe(200);
    expect(bindRes.json()).toEqual({ bound: true, publicKey: deviceKey.publicKeyRaw });

    const tokenAssertion = signEnvelope({ clientId, timestamp: new Date().toISOString() }, deviceKey);
    const tokenRes = await app.inject({
      method: "POST",
      url: "/v1/auth/device-token",
      payload: { clientId, assertion: tokenAssertion },
    });
    expect(tokenRes.statusCode).toBe(200);
    const body = tokenRes.json();
    expect(body.accessToken).toBeTypeOf("string");
    expect(body.scopes).toEqual(["client"]);

    // The minted token works like any other for normal protected reads.
    const health = await app.inject({
      method: "GET",
      url: "/v1/speed-limit?lat=52.5&lng=13.4",
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(health.statusCode).toBe(404); // authenticated, just no data — not 401
  });

  it("keeps the existing symmetric clientSecret flow working after binding a device key (additive, not a replacement)", async () => {
    const { clientId, secret } = await createClient();
    const deviceKey = generateEd25519KeyPair();
    const existingToken = authHeader(await testToken(app.deps.env, { sub: clientId, scopes: ["client"] }));
    await app.inject({
      method: "POST",
      url: "/v1/devices/bind-key",
      headers: existingToken,
      payload: { assertion: signEnvelope({ publicKey: deviceKey.publicKeyRaw, timestamp: new Date().toISOString() }, deviceKey) },
    });

    const res = await app.inject({ method: "POST", url: "/v1/auth/token", payload: { clientId, clientSecret: secret } });
    expect(res.statusCode).toBe(200);
  });

  it("rejects binding a second key once one is already bound", async () => {
    const { clientId } = await createClient();
    const first = generateEd25519KeyPair();
    const second = generateEd25519KeyPair();
    const auth = authHeader(await testToken(app.deps.env, { sub: clientId, scopes: ["client"] }));

    await app.inject({
      method: "POST",
      url: "/v1/devices/bind-key",
      headers: auth,
      payload: { assertion: signEnvelope({ publicKey: first.publicKeyRaw, timestamp: new Date().toISOString() }, first) },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/devices/bind-key",
      headers: auth,
      payload: { assertion: signEnvelope({ publicKey: second.publicKeyRaw, timestamp: new Date().toISOString() }, second) },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("KEY_ALREADY_BOUND");
  });

  it("rejects a bind-key assertion signed by a key different from the one it claims", async () => {
    const { clientId } = await createClient();
    const claimed = generateEd25519KeyPair();
    const actualSigner = generateEd25519KeyPair();
    const auth = authHeader(await testToken(app.deps.env, { sub: clientId, scopes: ["client"] }));

    // Claims claimed.publicKeyRaw in the payload but signs with a different key.
    const assertion = signEnvelope({ publicKey: claimed.publicKeyRaw, timestamp: new Date().toISOString() }, actualSigner);
    const res = await app.inject({ method: "POST", url: "/v1/devices/bind-key", headers: auth, payload: { assertion } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a stale bind-key assertion", async () => {
    const { clientId } = await createClient();
    const deviceKey = generateEd25519KeyPair();
    const auth = authHeader(await testToken(app.deps.env, { sub: clientId, scopes: ["client"] }));

    const staleTimestamp = new Date(Date.now() - 5 * 60_000).toISOString();
    const assertion = signEnvelope({ publicKey: deviceKey.publicKeyRaw, timestamp: staleTimestamp }, deviceKey);
    const res = await app.inject({ method: "POST", url: "/v1/devices/bind-key", headers: auth, payload: { assertion } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects device-token for a client with no bound key", async () => {
    const { clientId } = await createClient();
    const someKey = generateEd25519KeyPair();
    const assertion = signEnvelope({ clientId, timestamp: new Date().toISOString() }, someKey);
    const res = await app.inject({ method: "POST", url: "/v1/auth/device-token", payload: { clientId, assertion } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects device-token signed by the wrong key", async () => {
    const { clientId } = await createClient();
    const realKey = generateEd25519KeyPair();
    const attackerKey = generateEd25519KeyPair();
    const auth = authHeader(await testToken(app.deps.env, { sub: clientId, scopes: ["client"] }));
    await app.inject({
      method: "POST",
      url: "/v1/devices/bind-key",
      headers: auth,
      payload: { assertion: signEnvelope({ publicKey: realKey.publicKeyRaw, timestamp: new Date().toISOString() }, realKey) },
    });

    const forgedAssertion = signEnvelope({ clientId, timestamp: new Date().toISOString() }, attackerKey);
    const res = await app.inject({ method: "POST", url: "/v1/auth/device-token", payload: { clientId, assertion: forgedAssertion } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects device-token where the assertion's clientId doesn't match the request's clientId", async () => {
    const { clientId } = await createClient();
    const other = await createClient();
    const deviceKey = generateEd25519KeyPair();
    const auth = authHeader(await testToken(app.deps.env, { sub: clientId, scopes: ["client"] }));
    await app.inject({
      method: "POST",
      url: "/v1/devices/bind-key",
      headers: auth,
      payload: { assertion: signEnvelope({ publicKey: deviceKey.publicKeyRaw, timestamp: new Date().toISOString() }, deviceKey) },
    });

    // Assertion internally claims `other.clientId` while the request says `clientId`.
    const mismatched = signEnvelope({ clientId: other.clientId, timestamp: new Date().toISOString() }, deviceKey);
    const res = await app.inject({ method: "POST", url: "/v1/auth/device-token", payload: { clientId, assertion: mismatched } });
    expect(res.statusCode).toBe(401);
  });
});
