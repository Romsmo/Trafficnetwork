import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { generateClientId, generateClientSecret, hashSecret } from "../../src/modules/auth/credentials.js";
import { insertClient } from "../../src/db/queries/clients.js";
import { authHeader, testToken } from "./auth-helper.js";

describe("auth + bulk-import", () => {
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

  describe("POST /v1/auth/token", () => {
    it("issues a token for a valid client credential", async () => {
      const clientId = generateClientId();
      const clientSecret = generateClientSecret();
      await insertClient(testDb.db, {
        clientId,
        clientSecretHash: await hashSecret(clientSecret),
        scopes: ["client"],
        name: "test",
      });

      const res = await app.inject({ method: "POST", url: "/v1/auth/token", payload: { clientId, clientSecret } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accessToken).toBeTypeOf("string");
      expect(body.scopes).toEqual(["client"]);

      const health = await app.inject({
        method: "GET",
        url: "/v1/speed-limit?lat=52.5&lng=13.4",
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(health.statusCode).toBe(404); // authenticated, just no data — not 401
    });

    it("rejects an unknown clientId", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/token",
        payload: { clientId: "does-not-exist", clientSecret: "whatever" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects a wrong secret for a real client", async () => {
      const clientId = generateClientId();
      await insertClient(testDb.db, {
        clientId,
        clientSecretHash: await hashSecret(generateClientSecret()),
        scopes: ["client"],
        name: "test",
      });
      const res = await app.inject({ method: "POST", url: "/v1/auth/token", payload: { clientId, clientSecret: "wrong" } });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("scope enforcement", () => {
    it("rejects a client-scope token on a bulk-import endpoint with 403", async () => {
      const token = authHeader(await testToken(app.deps.env, { scopes: ["client"] }));
      const res = await app.inject({
        method: "POST",
        url: "/v1/bulk-import/static-signs",
        headers: token,
        payload: { rows: [{ lat: 1, lng: 1, signType: "DE:274", source: "test" }] },
      });
      expect(res.statusCode).toBe(403);
    });

    it("accepts a bulk-import-scope token on a bulk-import endpoint", async () => {
      const token = authHeader(await testToken(app.deps.env, { scopes: ["bulk-import"] }));
      const res = await app.inject({
        method: "POST",
        url: "/v1/bulk-import/static-signs",
        headers: token,
        payload: { rows: [{ lat: 1, lng: 1, signType: "DE:274", source: "test" }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ inserted: 1 });
    });
  });

  describe("bulk import", () => {
    async function bulkImportAuth() {
      return authHeader(await testToken(app.deps.env, { scopes: ["bulk-import"] }));
    }

    it("inserts speed-limit-segments and makes them visible via snapshot, without logging events", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/bulk-import/speed-limit-segments",
        headers: await bulkImportAuth(),
        payload: {
          rows: [
            {
              lineString: [
                [13.4, 52.52],
                [13.41, 52.53],
              ],
              speedLimit: 50,
              speedLimitUnit: "kmh",
              source: "osm",
              sourceLicense: "ODbL",
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ inserted: 1 });

      const snapshot = await app.inject({
        method: "GET",
        url: "/v1/snapshot",
        headers: await bulkImportAuth(),
      });
      expect(snapshot.json().speedLimitSegments).toHaveLength(1);
      expect(snapshot.json().speedLimitSegments[0].source).toBe("osm");

      const events = await testDb.db.execute<{ count: number } & Record<string, unknown>>(
        sql`select count(*)::int as count from event_log`,
      );
      expect(events[0]?.count).toBe(0);
    });

    it("inserts fixed speed cameras via bulk-import (independent of the namespace flag)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/bulk-import/speed-cameras",
        headers: await bulkImportAuth(),
        payload: { rows: [{ lat: 50, lng: 8, source: "seed" }] },
      });
      expect(res.json()).toEqual({ inserted: 1 });
    });

    it("rejects a batch larger than the row cap", async () => {
      const rows = Array.from({ length: 5001 }, () => ({ lat: 1, lng: 1, signType: "DE:274", source: "test" }));
      const res = await app.inject({
        method: "POST",
        url: "/v1/bulk-import/static-signs",
        headers: await bulkImportAuth(),
        payload: { rows },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("token endpoint rate limit", () => {
    // Own app instance — @fastify/rate-limit's in-memory store is per-registration,
    // and sharing it with the other describe blocks above (which also call
    // /v1/auth/token) would make this test's outcome depend on run order.
    let limitedApp: FastifyInstance;

    beforeAll(async () => {
      resetEnvCache();
      const env = loadEnv({ DATABASE_URL: testDb.container.getConnectionUri(), JWT_SECRET: "a".repeat(32) });
      limitedApp = await buildApp({ env, db: testDb.db });
    });

    afterAll(async () => limitedApp.close());

    it("returns 429 after 10 attempts within a minute (blunts credential brute-forcing)", async () => {
      let last;
      for (let i = 0; i < 11; i++) {
        last = await limitedApp.inject({
          method: "POST",
          url: "/v1/auth/token",
          payload: { clientId: "does-not-exist", clientSecret: "whatever" },
        });
      }
      expect(last!.statusCode).toBe(429);
    });
  });
});
