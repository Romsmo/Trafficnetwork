import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";

/**
 * The "currently online" counter (add-on O-A) against a real listening server
 * and real `ws` clients — the counter is fed by real WebSocket connections and
 * real authenticated requests, so app.inject() (no upgrade support) won't do
 * for the connection half. Each test builds its own app on the shared database
 * so tracker state never leaks between tests.
 */
describe("online counter (GET /v1/stats/online)", () => {
  let testDb: TestDatabase;
  const running: RunningApp[] = [];

  interface Figure {
    online: number | null;
    below?: number;
  }
  interface StatsBody {
    enabled: boolean;
    node: Figure & { windowSeconds: number };
    network?: Figure & { nodes: number; estimated: boolean; asOf: string };
    minDisplayThreshold: number;
  }
  interface RunningApp {
    app: FastifyInstance;
    env: Env;
    wsUrl: string;
    stats: () => Promise<{ statusCode: number; headers: Record<string, unknown>; body: StatsBody }>;
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
  });

  afterAll(async () => {
    for (const r of running) await r.app.close();
    await testDb.teardown();
  });

  async function startApp(envOverrides: Record<string, string> = {}): Promise<RunningApp> {
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      ONLINE_CACHE_SECONDS: "0",
      ONLINE_MIN_DISPLAY_THRESHOLD: "0",
      ...envOverrides,
    });
    const app = await buildApp({ env, db: testDb.db });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (typeof address !== "object" || address === null) throw new Error("no listen address");
    const running_: RunningApp = {
      app,
      env,
      wsUrl: `ws://127.0.0.1:${address.port}/v1/ws`,
      stats: async () => {
        const res = await app.inject({ method: "GET", url: "/v1/stats/online" });
        return { statusCode: res.statusCode, headers: res.headers, body: res.json() as StatsBody };
      },
    };
    running.push(running_);
    return running_;
  }

  /** Opens a socket and authenticates it as `sub`; resolves once the server has said auth_ok. */
  async function connectAs(node: RunningApp, sub: string, scopes: ("client" | "bulk-import")[] = ["client"]): Promise<WebSocket> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(node.wsUrl);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    const ok = new Promise<void>((resolve, reject) => {
      ws.once("message", (raw) => (JSON.parse(raw.toString()).type === "auth_ok" ? resolve() : reject(new Error(`unexpected: ${raw}`))));
    });
    ws.send(JSON.stringify({ type: "auth", token: await testToken(node.env, { sub, scopes }) }));
    await ok;
    return ws;
  }

  function closeAndWait(ws: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once("close", () => resolve());
      ws.close();
    });
  }

  async function waitForOnline(node: RunningApp, expected: number, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { body } = await node.stats();
      if (body.node?.online === expected) return;
      if (Date.now() > deadline) throw new Error(`online stayed ${body.node?.online}, expected ${expected}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it("is public (no Authorization header) and answers with the documented shape", async () => {
    const node = await startApp();
    const { statusCode, body, headers } = await node.stats();
    expect(statusCode).toBe(200);
    expect(body).toEqual({ enabled: true, node: { online: 0, windowSeconds: 300 }, minDisplayThreshold: 0 });
    // Not a federating node: there is no network to estimate, so no `network` part.
    expect(body).not.toHaveProperty("network");
    expect(headers["cache-control"]).toBe("public, max-age=0");
  });

  it("rises with each connected client and falls when they disconnect", async () => {
    const node = await startApp();
    const a = await connectAs(node, "client_a");
    await waitForOnline(node, 1);
    const b = await connectAs(node, "client_b");
    await waitForOnline(node, 2);

    await closeAndWait(a);
    await waitForOnline(node, 1);
    await closeAndWait(b);
    await waitForOnline(node, 0);
  });

  it("counts a device with several connections once", async () => {
    const node = await startApp();
    const first = await connectAs(node, "client_a");
    const second = await connectAs(node, "client_a");
    const other = await connectAs(node, "client_b");
    await waitForOnline(node, 2);

    await closeAndWait(first);
    await waitForOnline(node, 2); // client_a still has its second connection
    await closeAndWait(second);
    await waitForOnline(node, 1);
    await closeAndWait(other);
    await waitForOnline(node, 0);
  });

  it("does not count service credentials that open a socket", async () => {
    const node = await startApp();
    const importer = await connectAs(node, "importer", ["bulk-import"]);
    await new Promise((r) => setTimeout(r, 100));
    expect((await node.stats()).body.node.online).toBe(0);
    await closeAndWait(importer);
  });

  it("a socket that goes away while it is still authenticating is never left counted", async () => {
    const node = await startApp();
    const token = await testToken(node.env, { sub: "client_flaky" });
    for (let i = 0; i < 25; i++) {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const s = new WebSocket(node.wsUrl);
        s.once("open", () => resolve(s));
        s.once("error", reject);
      });
      ws.send(JSON.stringify({ type: "auth", token }));
      // 0-3 ms later, so the drop lands before, during or after the server's token check.
      await new Promise((r) => setTimeout(r, i % 4));
      ws.terminate();
    }
    await waitForOnline(node, 0);
    await new Promise((r) => setTimeout(r, 200)); // let any late auth finish, then look again
    expect((await node.stats()).body.node.online).toBe(0);
  });

  describe("polling clients (sync and write requests within the window)", () => {
    it("counts a client whose sync request succeeded, then stops counting it after the window", async () => {
      const node = await startApp({ ONLINE_WINDOW_SECONDS: "1" });
      const res = await node.app.inject({ method: "GET", url: "/v1/snapshot", headers: authHeader(await testToken(node.env, { sub: "client_poller" })) });
      expect(res.statusCode).toBe(200);
      await waitForOnline(node, 1);
      await waitForOnline(node, 0); // window is 1 s — gone shortly after
    });

    it("counts a client that reported a hazard", async () => {
      const node = await startApp();
      const res = await node.app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: authHeader(await testToken(node.env, { sub: "client_reporter" })),
        payload: { type: "traffic", lat: 52.52, lng: 13.405 },
      });
      expect(res.statusCode).toBe(201);
      await waitForOnline(node, 1);
    });

    it("counts a client once however many requests and connections it makes", async () => {
      const node = await startApp();
      const headers = authHeader(await testToken(node.env, { sub: "client_busy" }));
      for (let i = 0; i < 5; i++) await node.app.inject({ method: "GET", url: "/v1/snapshot", headers });
      const ws = await connectAs(node, "client_busy");
      await waitForOnline(node, 1);
      await closeAndWait(ws);
      await waitForOnline(node, 1); // still inside its polling window
    });

    it("does not count a failed request", async () => {
      const node = await startApp();
      const res = await node.app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: authHeader(await testToken(node.env, { sub: "client_bad" })),
        payload: { type: "not-a-hazard-type", lat: 1, lng: 1 },
      });
      expect(res.statusCode).toBe(400);
      expect((await node.stats()).body.node.online).toBe(0);
    });

    it("does not count plain lookups, only sync and writes", async () => {
      const node = await startApp();
      const res = await node.app.inject({
        method: "GET",
        url: "/v1/hazard-reports/nearby?lat=52.5&lng=13.4&radiusM=1000",
        headers: authHeader(await testToken(node.env, { sub: "client_lookup" })),
      });
      expect(res.statusCode).toBe(200);
      expect((await node.stats()).body.node.online).toBe(0);
    });

    it("does not count a service credential's requests", async () => {
      const node = await startApp();
      const res = await node.app.inject({
        method: "GET",
        url: "/v1/snapshot",
        headers: authHeader(await testToken(node.env, { sub: "importer", scopes: ["bulk-import"] })),
      });
      expect(res.statusCode).toBe(200);
      expect((await node.stats()).body.node.online).toBe(0);
    });

    it("does not count anything for a request without a valid token", async () => {
      const node = await startApp();
      const res = await node.app.inject({ method: "GET", url: "/v1/snapshot" });
      expect(res.statusCode).toBe(401);
      expect((await node.stats()).body.node.online).toBe(0);
    });
  });

  describe("threshold", () => {
    it("says \"fewer than N\" instead of the exact number below the threshold, and the exact number from it", async () => {
      const node = await startApp({ ONLINE_MIN_DISPLAY_THRESHOLD: "5" });
      const sockets: WebSocket[] = [];
      for (let i = 0; i < 4; i++) sockets.push(await connectAs(node, `client_${i}`));
      await new Promise((r) => setTimeout(r, 100));

      const below = await node.stats();
      expect(below.body.node).toEqual({ online: null, below: 5, windowSeconds: 300 });
      expect(below.body.minDisplayThreshold).toBe(5);
      expect(JSON.stringify(below.body)).not.toContain('"online":4');

      sockets.push(await connectAs(node, "client_4"));
      await waitForOnline(node, 5);
      expect((await node.stats()).body.node).toEqual({ online: 5, windowSeconds: 300 });

      for (const s of sockets) await closeAndWait(s);
    });
  });

  describe("switched off (ONLINE_COUNTER_ENABLED=false)", () => {
    it("still answers cleanly, saying so — and tracks nothing", async () => {
      const node = await startApp({ ONLINE_COUNTER_ENABLED: "false" });
      const ws = await connectAs(node, "client_a");
      await node.app.inject({ method: "GET", url: "/v1/snapshot", headers: authHeader(await testToken(node.env, { sub: "client_b" })) });

      const { statusCode, body } = await node.stats();
      expect(statusCode).toBe(200);
      expect(body).toEqual({ enabled: false });
      expect(node.app.online.nodeCount()).toBe(0);
      await closeAndWait(ws);
    });
  });

  describe("caching", () => {
    it("reuses an answer for ONLINE_CACHE_SECONDS", async () => {
      const node = await startApp({ ONLINE_CACHE_SECONDS: "60" });
      const first = await connectAs(node, "client_a");
      await new Promise((r) => setTimeout(r, 100));
      expect((await node.stats()).body.node.online).toBe(1);
      expect((await node.stats()).headers["cache-control"]).toBe("public, max-age=60");

      const second = await connectAs(node, "client_b");
      await new Promise((r) => setTimeout(r, 100));
      expect((await node.stats()).body.node.online).toBe(1); // still the cached answer
      await closeAndWait(first);
      await closeAndWait(second);
    });
  });
});
