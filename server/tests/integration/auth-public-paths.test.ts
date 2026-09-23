import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";

/**
 * Regression test for one specific class of mistake that has now happened
 * three times in this project (POST /v1/auth/device-token in F-S2, the
 * /v1/federation/* endpoints in F-S3, GET /v1/network/directory in F-S4,
 * the last one only caught by CI going red rather than at review time — see
 * modules/auth/hook.ts's PUBLIC_PATHS comment): a route meant to be reachable
 * without a client Bearer token gets left out of PUBLIC_PATHS and silently
 * 401s on every call. Every intentionally-public route is asserted here
 * explicitly, and one ordinary authenticated route is asserted the other way,
 * so this fails loudly the next time a new public route is added without the
 * matching PUBLIC_PATHS entry, instead of waiting for CI to notice.
 */
describe("auth hook: PUBLIC_PATHS coverage", () => {
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

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  const publicGets = [
    "/v1/health",
    "/v1/network/node-info",
    "/v1/network/directory",
    "/v1/federation/peers",
  ];

  it.each(publicGets)("GET %s is reachable with no Authorization header (not a 401)", async (url) => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).not.toBe(401);
  });

  // POST /v1/auth/token and /v1/auth/device-token are deliberately not
  // checked here with a blind "not 401" assertion — both legitimately
  // return 401 for bad credentials/assertions as their own business logic
  // (see modules/auth/routes.ts), same status code the auth *hook* itself
  // uses when it blocks a request, so that check would be meaningless for
  // these two specifically. They're already proven reachable without a
  // Bearer header by their own dedicated tests elsewhere
  // (auth-and-bulk-import.test.ts's "issues a token for a valid client
  // credential", device-signed-auth.test.ts's device-token flow) — both
  // succeed with no Authorization header sent at all.

  it("POST /v1/federation/join is reachable with no Authorization header (not a 401)", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/federation/join", payload: {} });
    expect(res.statusCode).not.toBe(401);
  });

  it("POST /v1/federation/heartbeat is reachable with no Authorization header (not a 401)", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/federation/heartbeat", payload: {} });
    expect(res.statusCode).not.toBe(401);
  });

  it("POST /v1/federation/events is reachable with no Authorization header (not a 401)", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/federation/events", payload: { senderNodeId: "x", events: [] } });
    expect(res.statusCode).not.toBe(401);
  });

  it("GET /v1/federation/events is reachable with no Authorization header (not a 401)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/federation/events?after=0" });
    expect(res.statusCode).not.toBe(401);
  });

  it("POST /v1/web/session (web UI, default on) hands out a token with no Authorization header", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/web/session" });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toEqual(expect.any(String));
  });

  it.each(["/", "/connect", "/about", "/web-config.json", "/web/js/map-page.js"])("web UI file GET %s needs no token (only /v1/* is guarded)", async (url) => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
  });

  it("sanity check: an ordinary route still requires auth (control case, so the assertions above are meaningful)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/config" });
    expect(res.statusCode).toBe(401);
  });
});
