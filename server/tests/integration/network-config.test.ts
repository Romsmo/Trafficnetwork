import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { generateEd25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import type { NetworkConfigPayload } from "../../src/modules/network/config.js";
import { insertFixedSpeedCamera } from "../../src/db/queries/fixed-speed-cameras.js";
import { loadBoundaries, WORLD_AS_DE } from "./camera-policy-helper.js";

describe("signed network config (F-S2)", () => {
  let testDb: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    dir = mkdtempSync(path.join(tmpdir(), "network-config-integration-"));
    // A camera in a country the policy below releases: only the brake (local flag AND signed blitzerEnabled) decides whether it is delivered.
    await loadBoundaries(testDb.db, WORLD_AS_DE);
    await insertFixedSpeedCamera(testDb.db, { lat: 52.5, lng: 13.4, source: "test", marginM: 1000 });
  });

  afterAll(async () => {
    await testDb.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(root: ReturnType<typeof generateEd25519KeyPair>, blitzerEnabled: boolean): string {
    const payload: NetworkConfigPayload = {
      version: 1,
      blitzerEnabled,
      cameraPolicyByCountry: { DE: "full" },
      eventLogRetentionDaysDynamic: 3,
      eventLogRetentionDaysStatic: 30,
      minVersion: "0.1.0",
      excludedNodeIds: [],
      issuedAt: new Date().toISOString(),
    };
    const filePath = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(filePath, JSON.stringify(signEnvelope(payload, root)));
    return filePath;
  }

  describe("camera-namespace AND-gating at the HTTP layer", () => {
    let app: FastifyInstance;

    afterEach(async () => {
      if (app) await app.close();
    });

    it("a network config with blitzerEnabled:false overrides a locally-enabled flag (empty cameras response)", async () => {
      const root = generateEd25519KeyPair();
      const configPath = writeConfig(root, false);

      resetEnvCache();
      const env = loadEnv({
        DATABASE_URL: testDb.container.getConnectionUri(),
        JWT_SECRET: "a".repeat(32),
        SPEED_CAMERA_NAMESPACE_ENABLED: "true", // operator wants it on locally
        NETWORK_CONFIG_PATH: configPath,
        NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw,
      });
      app = await buildApp({ env, db: testDb.db });
      const auth = authHeader(await testToken(env));

      const res = await app.inject({
        method: "GET",
        url: "/v1/speed-cameras/nearby?lat=52.5&lng=13.4&radiusM=1000",
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ cameras: [], zones: [] });
    });

    it("with both agreeing the same camera is delivered, so the two tests around it really test the brake", async () => {
      const root = generateEd25519KeyPair();
      const configPath = writeConfig(root, true);

      resetEnvCache();
      const env = loadEnv({
        DATABASE_URL: testDb.container.getConnectionUri(),
        JWT_SECRET: "a".repeat(32),
        SPEED_CAMERA_NAMESPACE_ENABLED: "true",
        NETWORK_CONFIG_PATH: configPath,
        NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw,
      });
      app = await buildApp({ env, db: testDb.db });
      const res = await app.inject({
        method: "GET",
        url: "/v1/speed-cameras/nearby?lat=52.5&lng=13.4&radiusM=1000",
        headers: authHeader(await testToken(env)),
      });
      expect(res.json().cameras).toHaveLength(1);
    });

    it("a network config with blitzerEnabled:true never turns on a locally-disabled flag", async () => {
      const root = generateEd25519KeyPair();
      const configPath = writeConfig(root, true);

      resetEnvCache();
      const env = loadEnv({
        DATABASE_URL: testDb.container.getConnectionUri(),
        JWT_SECRET: "a".repeat(32),
        SPEED_CAMERA_NAMESPACE_ENABLED: "false", // operator has NOT enabled it locally
        NETWORK_CONFIG_PATH: configPath,
        NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw,
      });
      app = await buildApp({ env, db: testDb.db });
      const auth = authHeader(await testToken(env));

      const res = await app.inject({
        method: "GET",
        url: "/v1/speed-cameras/nearby?lat=52.5&lng=13.4&radiusM=1000",
        headers: auth,
      });
      expect(res.json()).toEqual({ cameras: [], zones: [] });
    });

    it("refuses to start when NETWORK_CONFIG_PATH points at a config signed by the wrong key", async () => {
      const root = generateEd25519KeyPair();
      const attacker = generateEd25519KeyPair();
      const configPath = writeConfig(attacker, true); // signed by the wrong key

      resetEnvCache();
      const env = loadEnv({
        DATABASE_URL: testDb.container.getConnectionUri(),
        JWT_SECRET: "a".repeat(32),
        NETWORK_CONFIG_PATH: configPath,
        NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw, // real root key, doesn't match the signer
      });
      await expect(buildApp({ env, db: testDb.db })).rejects.toThrow();
    });
  });

  it("GET /v1/config exposes the raw signed envelope and federationEnabled", async () => {
    const root = generateEd25519KeyPair();
    const configPath = writeConfig(root, false);

    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      FEDERATION_ENABLED: "true",
      FEDERATION_PUBLIC_ADDRESS: "https://node-under-test.example",
      NETWORK_CONFIG_PATH: configPath,
      NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw,
    });
    const app = await buildApp({ env, db: testDb.db });
    const auth = authHeader(await testToken(env));

    const res = await app.inject({ method: "GET", url: "/v1/config", headers: auth });
    const body = res.json();
    expect(body.federationEnabled).toBe(true);
    expect(body.networkConfig.payload.version).toBe(1);
    expect(body.networkConfig.signature).toBeTypeOf("string");

    await app.close();
  });

  it("GET /v1/network/node-info is public (no auth) and returns a stable nodeId across requests", async () => {
    resetEnvCache();
    const env = loadEnv({ DATABASE_URL: testDb.container.getConnectionUri(), JWT_SECRET: "a".repeat(32) });
    const app = await buildApp({ env, db: testDb.db });

    const first = await app.inject({ method: "GET", url: "/v1/network/node-info" });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "GET", url: "/v1/network/node-info" });
    expect(second.json().nodeId).toBe(first.json().nodeId);
    expect(first.json().federationEnabled).toBe(false);

    await app.close();
  });
});
