import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";

/**
 * docs/prompt-phase1-server.md section "ROLLE & ARBEITSWEISE" point 6 and
 * docs/concept.md section 7: a freshly set-up server with an empty database is a
 * valid, functioning state — it must not 500, it just has no data yet. This test
 * covers that for the routes that exist as of milestone P1.1 (health); later
 * milestones extend it as each new read endpoint (nearby, snapshot, delta, ...)
 * lands, per the plan's P1.5 task list.
 */
describe("empty database", () => {
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

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  it("reports healthy against a freshly migrated, empty database", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", database: "ok" });
  });
});
