import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { generateClientId, generateClientSecret, hashSecret } from "../../src/modules/auth/credentials.js";
import { findClientByClientId, insertClient } from "../../src/db/queries/clients.js";
import { authHeader, testToken } from "./auth-helper.js";

/**
 * Integration coverage for the client-lib P2.0 server extensions
 * (docs/prompt-phase2-client-lib.md section 4): anonymous device
 * registration, the partitioned static-data manifest/packages, and the
 * config-mirroring endpoint.
 */
describe("client-lib P2.0 server extensions", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
    });
    app = await buildApp({ env, db: testDb.db });
  });

  afterEach(async () => {
    await testDb.db.execute(sql`
      truncate table speed_limit_segments, static_signs, fixed_speed_cameras, clients, event_log restart identity cascade
    `);
  });

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  async function createAppKey(name = "test-app"): Promise<string> {
    const clientId = generateClientId();
    await insertClient(testDb.db, {
      clientId,
      clientSecretHash: await hashSecret(generateClientSecret()),
      scopes: ["device-registration"],
      name,
    });
    return clientId;
  }

  async function bulkImportAuth() {
    return authHeader(await testToken(app.deps.env, { scopes: ["bulk-import"] }));
  }

  describe("POST /v1/devices/register", () => {
    it("issues a fresh device credential that works against POST /v1/auth/token with its own reporter identity", async () => {
      const appClientId = await createAppKey();
      const token = await testToken(app.deps.env, { sub: appClientId, scopes: ["device-registration"] });

      const res = await app.inject({ method: "POST", url: "/v1/devices/register", headers: authHeader(token) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.clientId).toMatch(/^client_/);
      expect(body.clientId).not.toBe(appClientId);
      expect(body.clientSecret).toBeTypeOf("string");

      const tokenRes = await app.inject({
        method: "POST",
        url: "/v1/auth/token",
        payload: { clientId: body.clientId, clientSecret: body.clientSecret },
      });
      expect(tokenRes.statusCode).toBe(200);
      expect(tokenRes.json().scopes).toEqual(["client"]);
    });

    it("traces the new device credential back to the registering app key", async () => {
      const appClientId = await createAppKey();
      const token = await testToken(app.deps.env, { sub: appClientId, scopes: ["device-registration"] });
      const res = await app.inject({ method: "POST", url: "/v1/devices/register", headers: authHeader(token) });

      const device = await findClientByClientId(testDb.db, res.json().clientId);
      const appRow = await findClientByClientId(testDb.db, appClientId);
      expect(device!.registeredByClientId).toBe(appRow!.id);
    });

    it("rejects a token without the device-registration scope", async () => {
      const token = await testToken(app.deps.env, { scopes: ["client"] });
      const res = await app.inject({ method: "POST", url: "/v1/devices/register", headers: authHeader(token) });
      expect(res.statusCode).toBe(403);
    });

    it("enforces the daily per-app-key registration cap", async () => {
      resetEnvCache();
      const limitedEnv = loadEnv({
        DATABASE_URL: testDb.container.getConnectionUri(),
        JWT_SECRET: "a".repeat(32),
        DEVICE_REGISTRATION_RATE_LIMIT_MAX_PER_DAY: "2",
      });
      const limitedApp = await buildApp({ env: limitedEnv, db: testDb.db });
      try {
        const appClientId = await createAppKey("capped-app");
        const token = await testToken(limitedEnv, { sub: appClientId, scopes: ["device-registration"] });

        for (let i = 0; i < 2; i++) {
          const ok = await limitedApp.inject({ method: "POST", url: "/v1/devices/register", headers: authHeader(token) });
          expect(ok.statusCode).toBe(200);
        }
        const capped = await limitedApp.inject({ method: "POST", url: "/v1/devices/register", headers: authHeader(token) });
        expect(capped.statusCode).toBe(429);
      } finally {
        await limitedApp.close();
      }
    });
  });

  describe("static-data manifest & partitions", () => {
    it("lists no partitions on an empty database", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/static-data/manifest", headers: await bulkImportAuth() });
      expect(res.statusCode).toBe(200);
      expect(res.json().partitions).toEqual([]);
      expect(res.json().staticDataVersion).toBeTypeOf("number");
    });

    it("adds a partition and bumps staticDataVersion after a bulk import, retrievable by tile", async () => {
      const before = await app.inject({ method: "GET", url: "/v1/static-data/manifest", headers: await bulkImportAuth() });
      const versionBefore = before.json().staticDataVersion as number;

      const imported = await app.inject({
        method: "POST",
        url: "/v1/bulk-import/static-signs",
        headers: await bulkImportAuth(),
        payload: { rows: [{ lat: 52.52, lng: 13.405, signType: "DE:274", source: "test" }] },
      });
      expect(imported.statusCode).toBe(200);

      const after = await app.inject({ method: "GET", url: "/v1/static-data/manifest", headers: await bulkImportAuth() });
      expect(after.json().staticDataVersion).toBe(versionBefore + 1);
      expect(after.json().partitions).toHaveLength(1);
      expect(after.json().partitions[0].hash).toBeTypeOf("string");

      const tile = after.json().partitions[0].tile as string;
      const partitionRes = await app.inject({
        method: "GET",
        url: `/v1/static-data/partitions/${tile}`,
        headers: await bulkImportAuth(),
      });
      expect(partitionRes.statusCode).toBe(200);
      expect(partitionRes.json().staticSigns).toHaveLength(1);
      expect(partitionRes.json().staticSigns[0].signType).toBe("DE:274");
    });

    it("returns 404 for a tile with no static data", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/static-data/partitions/nonexistent-tile",
        headers: await bulkImportAuth(),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /v1/config", () => {
    it("returns the tunables the client-lib must mirror locally", async () => {
      const token = await testToken(app.deps.env, { scopes: ["client"] });
      const res = await app.inject({ method: "GET", url: "/v1/config", headers: authHeader(token) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.regionTileH3Resolution).toBe(app.deps.env.REGION_TILE_H3_RESOLUTION);
      expect(body.speedCameraNamespaceEnabled).toBe(false);
      expect(body.hazardExpiryMsByType.traffic).toBeGreaterThan(0);
      expect(body.staticDataVersion).toBeTypeOf("number");
    });

    it("requires authentication like any other read", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/config" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /v1/snapshot?staticData=false", () => {
    it("omits static entities but still returns snapshotSequence", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/bulk-import/static-signs",
        headers: await bulkImportAuth(),
        payload: { rows: [{ lat: 1, lng: 1, signType: "DE:274", source: "test" }] },
      });

      const res = await app.inject({
        method: "GET",
        url: "/v1/snapshot?staticData=false",
        headers: await bulkImportAuth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.staticSigns).toEqual([]);
      expect(body.speedLimitSegments).toEqual([]);
      expect(body.snapshotSequence).toBeTypeOf("number");
    });
  });
});
