import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import WebSocket from "ws";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { testToken } from "./auth-helper.js";
import { positionToRegionTile } from "../../src/lib/h3.js";
import type { FastifyInstance } from "fastify";

/**
 * Uses a real listening server + a real `ws` client, not app.inject() — Fastify's
 * light-weight HTTP injection doesn't support the WebSocket upgrade handshake
 * (see the plan's testing-strategy note).
 */
describe("realtime WebSocket push", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;
  let env: Env;
  let baseUrl: string;
  let wsUrl: string;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    resetEnvCache();
    env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
    });
    app = await buildApp({ env, db: testDb.db });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (typeof address !== "object" || address === null) throw new Error("Failed to determine listen address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}/v1/ws`;
  });

  afterEach(async () => {
    await testDb.db.execute(sql`truncate table hazard_reports, event_log restart identity cascade`);
  });

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  interface ServerMessage {
    type: string;
    message?: string;
    event?: { type: string; entityId: string; regionTile: string | null };
  }

  function nextMessage(ws: WebSocket): Promise<ServerMessage> {
    return new Promise((resolve) => ws.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
  }

  it("authenticates, subscribes to a tile, and receives a report created in that tile", async () => {
    const ws = await connect();
    const token = await testToken(env);
    ws.send(JSON.stringify({ type: "auth", token }));
    expect(await nextMessage(ws)).toEqual({ type: "auth_ok" });

    const tile = positionToRegionTile(52.52, 13.405, { REGION_TILE_H3_RESOLUTION: 7 });
    ws.send(JSON.stringify({ type: "subscribe", tile, k: 0 }));

    const res = await fetch(`${baseUrl}/v1/hazard-reports`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: "traffic", lat: 52.52, lng: 13.405 }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { report: { id: string } };

    const pushed = await nextMessage(ws);
    expect(pushed.type).toBe("event");
    expect(pushed.event?.type).toBe("ReportCreated");
    expect(pushed.event?.entityId).toBe(created.report.id);

    ws.close();
  });

  it("does not push events for a tile the connection never subscribed to", async () => {
    const ws = await connect();
    const token = await testToken(env);
    ws.send(JSON.stringify({ type: "auth", token }));
    await nextMessage(ws);
    // Deliberately not subscribing to any tile.

    let received = false;
    ws.on("message", () => {
      received = true;
    });

    await fetch(`${baseUrl}/v1/hazard-reports`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: "traffic", lat: 10, lng: 10 }),
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toBe(false);

    ws.close();
  });

  it("rejects messages before authentication", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "subscribe", tile: "871f200d3ffffff", k: 0 }));
    const msg = await nextMessage(ws);
    expect(msg).toEqual({ type: "error", message: "Not authenticated" });
    ws.close();
  });

  it("closes the connection on an invalid token", async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "auth", token: "not-a-real-token" }));
    const closeCode = await new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    expect(closeCode).toBe(4001);
  });
});
