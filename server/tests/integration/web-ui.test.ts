import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { sql } from "drizzle-orm";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { positionToRegionTile } from "../../src/lib/h3.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { insertHazardReport, insertSpeedLimitSegment } from "./helpers.js";
import { createPolicyFixture, loadBoundaries, WORLD_AS_DE, type PolicyFixture } from "./camera-policy-helper.js";

const MUNICH = { lat: 48.1374, lng: 11.5755 };

describe("web UI (server/web)", () => {
  let testDb: TestDatabase;
  let baseEnv: Record<string, string>;
  let app: FastifyInstance;
  let env: Env;
  let limited: FastifyInstance;
  let limitedEnv: Env;
  let cameras: FastifyInstance;
  let corrections: FastifyInstance; // its own node: the session-minting limit is per app, and these tests mint a few sessions
  let off: FastifyInstance;
  let cameraPolicy: PolicyFixture;
  const closers: (() => Promise<void>)[] = [];

  async function build(extra: Record<string, string> = {}): Promise<{ app: FastifyInstance; env: Env }> {
    resetEnvCache();
    const e = loadEnv({ ...baseEnv, ...extra });
    const a = await buildApp({ env: e, db: testDb.db });
    closers.push(() => a.close());
    return { app: a, env: e };
  }

  const webToken = async (a: FastifyInstance, remoteAddress = "127.0.0.1", headers: Record<string, string> = {}): Promise<string> => {
    const res = await a.inject({ method: "POST", url: "/v1/web/session", remoteAddress, headers });
    expect(res.statusCode).toBe(200);
    return res.json().accessToken as string;
  };

  const report = (a: FastifyInstance, token: string, body: Record<string, unknown>, remoteAddress = "127.0.0.1", headers: Record<string, string> = {}) =>
    a.inject({ method: "POST", url: "/v1/hazard-reports", headers: { ...authHeader(token), ...headers }, payload: body, remoteAddress });

  beforeAll(async () => {
    testDb = await startTestDatabase();
    baseEnv = { DATABASE_URL: testDb.container.getConnectionUri(), JWT_SECRET: "a".repeat(32), LOG_LEVEL: "silent" };
    ({ app, env } = await build());
    ({ app: limited, env: limitedEnv } = await build({
      TRUST_PROXY: "true",
      REPORT_RATE_LIMIT_MAX: "100",
      WEB_REPORT_LIMIT_PER_SESSION: "100",
      WEB_REPORT_LIMIT_PER_IP_PER_HOUR: "4",
      WEB_WS_MAX_TILES_PER_CONNECTION: "10",
    }));
    // Cameras are released for the one synthetic country that covers the test coordinates.
    cameraPolicy = createPolicyFixture();
    await loadBoundaries(testDb.db, WORLD_AS_DE);
    cameraPolicy.write({ DE: "full" });
    ({ app: cameras } = await build(cameraPolicy.env()));
    ({ app: off } = await build({ WEB_UI_ENABLED: "false" }));
    ({ app: corrections } = await build());

    await insertSpeedLimitSegment(testDb.db, { lineString: [[MUNICH.lng, MUNICH.lat], [MUNICH.lng + 0.001, MUNICH.lat + 0.0006]], speedLimit: 30, source: "osm" });
    await insertSpeedLimitSegment(testDb.db, { lineString: [[MUNICH.lng - 0.02, MUNICH.lat], [MUNICH.lng - 0.01, MUNICH.lat + 0.005]], speedLimit: 50, source: "osm" });
    await insertHazardReport(testDb.db, {
      lat: MUNICH.lat,
      lng: MUNICH.lng,
      type: "ice",
      regionTile: positionToRegionTile(MUNICH.lat, MUNICH.lng, env),
      expiresAt: new Date(Date.now() + 20 * 60_000),
      reporterId: "client_someones_phone",
    });
  });

  afterAll(async () => {
    for (const close of closers) await close();
    cameraPolicy.cleanup();
    await testDb.teardown();
  });

  describe("serving the pages", () => {
    it.each(["/", "/connect", "/about"])("serves %s as HTML with a strict CSP and hardening headers", async (url) => {
      const res = await app.inject({ method: "GET", url, headers: { host: "node.example:3000" } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
      const csp = String(res.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("img-src 'self' data: https://tile.openstreetmap.org");
      expect(csp).toContain("wss://node.example:3000");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.body).toContain("<script");
    });

    it("serves static files with ETag revalidation and pre-compression", async () => {
      const first = await app.inject({ method: "GET", url: "/web/vendor/leaflet/leaflet.js", headers: { "accept-encoding": "br, gzip" } });
      expect(first.statusCode).toBe(200);
      expect(first.headers["content-encoding"]).toBe("br");
      expect(first.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      const etag = String(first.headers.etag);
      const revalidated = await app.inject({ method: "GET", url: "/web/vendor/leaflet/leaflet.js", headers: { "if-none-match": etag } });
      expect(revalidated.statusCode).toBe(304);
    });

    it("lets browsers keep a release's own files for good, and only revalidates URLs that do not carry the build id", async () => {
      const page = await app.inject({ method: "GET", url: "/" });
      expect(page.body).toContain('<link rel="preconnect" href="https://tile.openstreetmap.org">');
      const versioned =[...page.body.matchAll(/(?:href|src)="(\/web\/[^"]+\?v=[0-9a-f]{12})"/g)].map((m) => m[1]!);
      expect(versioned.length).toBeGreaterThan(3);
      for (const url of versioned) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(200);
        expect(res.headers["cache-control"], url).toBe("public, max-age=31536000, immutable");
      }
      // the same file requested without (or with another) build id is not promised to stay the same
      expect((await app.inject({ method: "GET", url: "/web/js/map-page.js" })).headers["cache-control"]).toBe("no-cache");
      expect((await app.inject({ method: "GET", url: "/web/js/map-page.js?v=old" })).headers["cache-control"]).toBe("no-cache");
      // the module graph the page hints at is real: every preloaded module exists
      for (const [, url] of page.body.matchAll(/rel="modulepreload" href="([^"]+)"/g)) {
        expect((await app.inject({ method: "GET", url: url! })).statusCode, url).toBe(200);
      }
    });

    it("answers 404 for anything outside the fixed file table, including traversal attempts", async () => {
      for (const url of ["/web/nope.js", "/web/../package.json", "/web/%2e%2e/package.json", "/web/js/../../.env", "/web/"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(404);
      }
    });

    it("with MAP_TILE_URL=none there is no tile origin in the CSP and no tile source in the config", async () => {
      const { app: noTiles } = await build({ MAP_TILE_URL: "none" });
      const page = await noTiles.inject({ method: "GET", url: "/" });
      expect(String(page.headers["content-security-policy"])).toContain("img-src 'self' data:;");
      expect(String(page.headers["content-security-policy"])).not.toContain("openstreetmap");
      expect(page.body).not.toContain("preconnect");
      expect((await noTiles.inject({ method: "GET", url: "/web-config.json" })).json().tiles).toBeNull();
    });

    it("publishes /web-config.json: version, repo link, tile source, region of this node's data, limits", async () => {
      const res = await app.inject({ method: "GET", url: "/web-config.json" });
      expect(res.statusCode).toBe(200);
      const config = res.json();
      expect(config.repoUrl).toBe("https://github.com/Romsmo/Trafficnetwork");
      expect(config.license).toBe("Apache-2.0");
      expect(config.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(config.tiles).toMatchObject({ url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19 });
      expect(config.limits).toEqual({ maxSegmentRadiusM: 1500, maxHazardRadiusM: 25_000 });
      expect(config.privacyLogging).toBe(true);
      const [[south, west], [north, east]] = config.region.bounds as [[number, number], [number, number]];
      expect(south).toBeLessThan(MUNICH.lat);
      expect(north).toBeGreaterThan(MUNICH.lat);
      expect(west).toBeLessThan(MUNICH.lng);
      expect(east).toBeGreaterThan(MUNICH.lng);
    });
  });

  describe("anonymous web sessions", () => {
    it("mints a short-lived token whose subject is a random web: identity, and each session is a new one", async () => {
      const a = decodeJwt(await webToken(app));
      const b = decodeJwt(await webToken(app));
      expect(String(a.sub)).toMatch(/^web:[A-Za-z0-9_-]{20,}$/);
      expect(a.sub).not.toBe(b.sub);
      expect((a.exp ?? 0) - (a.iat ?? 0)).toBe(env.WEB_SESSION_TTL_SECONDS);
    });

    it("refuses to mint a session for a request another site triggered (Sec-Fetch-Site)", async () => {
      const cross = await app.inject({ method: "POST", url: "/v1/web/session", headers: { "sec-fetch-site": "cross-site" } });
      expect(cross.statusCode).toBe(403);
      const sameSite = await app.inject({ method: "POST", url: "/v1/web/session", headers: { "sec-fetch-site": "same-site" } });
      expect(sameSite.statusCode).toBe(403);
      const own = await app.inject({ method: "POST", url: "/v1/web/session", headers: { "sec-fetch-site": "same-origin" } });
      expect(own.statusCode).toBe(200);
    });

    it("limits how fast one IP can mint sessions", async () => {
      const { app: strict } = await build({ WEB_SESSION_MINT_LIMIT_PER_MINUTE: "3" });
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await strict.inject({ method: "POST", url: "/v1/web/session", remoteAddress: "198.51.100.77" })).statusCode);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    });
  });

  describe("what a web session may do (default-deny)", () => {
    it("reads config, speed limits, road segments (within the radius cap) and reports", async () => {
      const token = await webToken(app);
      const get = (url: string) => app.inject({ method: "GET", url, headers: authHeader(token) });

      expect((await get("/v1/config")).statusCode).toBe(200);
      const limit = await get(`/v1/speed-limit?lat=${MUNICH.lat}&lng=${MUNICH.lng}`);
      expect(limit.statusCode).toBe(200);
      expect(limit.json().speedLimit).toBe(30);
      const segments = await get(`/v1/speed-limit-segments/nearby?lat=${MUNICH.lat}&lng=${MUNICH.lng}&radiusM=1500`);
      expect(segments.statusCode).toBe(200);
      expect(segments.json().segments.length).toBeGreaterThanOrEqual(1);
      expect((await get(`/v1/hazard-reports/nearby?lat=${MUNICH.lat}&lng=${MUNICH.lng}&radiusM=25000`)).statusCode).toBe(200);
    });

    it("rejects oversized radii with an explanation instead of running an expensive query", async () => {
      const token = await webToken(app);
      const res = await app.inject({ method: "GET", url: `/v1/speed-limit-segments/nearby?lat=${MUNICH.lat}&lng=${MUNICH.lng}&radiusM=1501`, headers: authHeader(token) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("WEB_RADIUS_TOO_LARGE");
    });

    it.each([
      ["GET", "/v1/snapshot?staticData=true"],
      ["GET", "/v1/delta?since=0"],
      ["GET", "/v1/static-data/manifest"],
      ["GET", `/v1/static-signs/nearby?lat=${MUNICH.lat}&lng=${MUNICH.lng}&radiusM=100`],
      ["POST", "/v1/devices/register"],
      ["POST", "/v1/devices/bind-key"],
      ["POST", "/v1/bulk-import/speed-limit-segments"],
    ])("is refused %s %s — while an ordinary client token is not affected by the guard", async (method, url) => {
      const web = await webToken(app);
      const denied = await app.inject({ method: method as "GET" | "POST", url, headers: authHeader(web), payload: method === "POST" ? {} : undefined });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("WEB_SESSION_FORBIDDEN");

      const normal = await app.inject({ method: method as "GET" | "POST", url, headers: authHeader(await testToken(env)), payload: method === "POST" ? {} : undefined });
      expect(normal.json()?.error?.code).not.toBe("WEB_SESSION_FORBIDDEN");
    });
  });

  describe("speed-limit corrections (add-on K-A) — the guard's side of it", () => {
    // The correction endpoints exist only on nodes that have the K-A add-on. What this checks is the guard: a web session is
    // let through to them (on a node without the add-on the route then answers 404, with it the endpoint's own validation
    // answers), except for a device signature, which a browser can never legitimately carry.
    const segment = "2b7c6d10-0000-4000-8000-000000000000";

    it.each([
      ["GET", "/v1/speed-limit-corrections?tiles=871f8d922ffffff", undefined],
      ["GET", `/v1/speed-limit-segments/${segment}/corrections`, undefined],
      ["POST", `/v1/speed-limit-segments/${segment}/corrections`, { value: 30, unit: "kmh" }],
      ["POST", `/v1/speed-limit-corrections/${segment}/confirmations`, { kind: "confirm" }],
    ])("lets %s %s pass the guard", async (method, url, payload) => {
      const res = await corrections.inject({ method: method as "GET" | "POST", url, headers: authHeader(await webToken(corrections)), payload });
      expect(res.statusCode).not.toBe(429);
      expect(res.json()?.error?.code).not.toBe("WEB_SESSION_FORBIDDEN");
      expect(res.json()?.error?.code).not.toBe("WEB_NO_DEVICE_SIGNATURE");
    });

    it("refuses a device signature on a vote, and counts the votes like other writes", async () => {
      const token = await webToken(corrections);
      const signed = await corrections.inject({
        method: "POST",
        url: `/v1/speed-limit-segments/${segment}/corrections`,
        headers: authHeader(token),
        payload: { value: 30, unit: "kmh", deviceAssertion: { payload: {}, keyId: "x", signature: "y" } },
      });
      expect(signed.statusCode).toBe(403);
      expect(signed.json().error.code).toBe("WEB_NO_DEVICE_SIGNATURE");

      const { app: tight } = await build({ WEB_REPORT_LIMIT_PER_SESSION: "1" });
      const tightToken = await webToken(tight);
      const vote = () => tight.inject({ method: "POST", url: `/v1/speed-limit-corrections/${segment}/confirmations`, headers: authHeader(tightToken), payload: { kind: "confirm" } });
      expect((await vote()).statusCode).not.toBe(429);
      const limited = await vote();
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe("WEB_RATE_LIMITED");
    });
  });

  describe("reporting from the browser", () => {
    it("accepts a general report, keeps it anonymous and local, and shows it to everyone", async () => {
      const token = await webToken(app);
      const res = await report(app, token, { type: "obstacle", lat: 48.2, lng: 11.6 });
      expect(res.statusCode).toBe(201);
      expect(res.json().merged).toBe(false);
      expect(JSON.stringify(res.json())).not.toContain("reporterId");

      // stored under the random web: identity — that is how a web report stays recognisable as such
      const stored = await testDb.db.execute<{ reporter_id: string } & Record<string, unknown>>(sql`select reporter_id from hazard_reports where id = ${res.json().report.id}`);
      expect(stored[0]?.reporter_id).toMatch(/^web:/);

      const seen = await app.inject({ method: "GET", url: "/v1/hazard-reports/nearby?lat=48.2&lng=11.6&radiusM=500", headers: authHeader(await testToken(env)) });
      expect(seen.json().reports.some((r: { type: string }) => r.type === "obstacle")).toBe(true);
    });

    it("hides other devices' reporter ids from web sessions but not from authenticated clients", async () => {
      const query = `/v1/hazard-reports/nearby?lat=${MUNICH.lat}&lng=${MUNICH.lng}&radiusM=500`;
      const asWeb = await app.inject({ method: "GET", url: query, headers: authHeader(await webToken(app)) });
      expect(asWeb.json().reports.length).toBeGreaterThanOrEqual(1);
      expect(asWeb.body).not.toContain("reporterId");
      expect(asWeb.body).not.toContain("client_someones_phone");

      const asClient = await app.inject({ method: "GET", url: query, headers: authHeader(await testToken(env)) });
      expect(asClient.json().reports[0].reporterId).toBe("client_someones_phone");
    });

    it("never accepts a device signature from a browser session (its reports must not federate)", async () => {
      const token = await webToken(app);
      const res = await report(app, token, { type: "traffic", lat: 48.3, lng: 11.7, deviceAssertion: { payload: { kind: "create" }, keyId: "k", signature: "s" } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("WEB_NO_DEVICE_SIGNATURE");
    });

    it("refuses every camera category while the namespace flag is off, and allows them when the operator enabled it", async () => {
      const token = await webToken(app);
      for (const type of ["fixedSpeedCamera", "mobileSpeedCamera", "trailerCamera", "redLightCamera", "distanceControl"]) {
        const res = await report(app, token, { type, lat: 48.4, lng: 11.8 });
        expect(res.statusCode, type).toBe(403);
        expect(res.json().error.code).toBe("WEB_TYPE_NOT_ALLOWED");
      }
      const allowed = await report(cameras, await webToken(cameras), { type: "mobileSpeedCamera", lat: 48.4, lng: 11.8 });
      expect(allowed.statusCode).toBe(201);
    });

    it("lets a web session confirm a report, counted once per session", async () => {
      const created = await report(app, await testToken(env, { sub: "client_creator" }), { type: "breakdown", lat: 48.5, lng: 11.9 });
      const id = created.json().report.id as string;
      const token = await webToken(app);
      const confirm = () => app.inject({ method: "POST", url: `/v1/hazard-reports/${id}/confirmations`, headers: authHeader(token), payload: { kind: "stillThere" } });
      const first = await confirm();
      expect(first.statusCode).toBe(200);
      expect(first.json().recorded).toBe(true);
      expect(first.json().report.confirmCount).toBe(1);
      expect(first.body).not.toContain("reporterId");
      expect((await confirm()).json().recorded).toBe(false);
    });

    it("stops a session after its own write budget, telling it honestly why and for how long", async () => {
      const token = await webToken(app);
      const types = ["traffic", "accident", "construction", "ice"];
      const codes: number[] = [];
      let last;
      for (const [i, type] of types.entries()) {
        last = await report(app, token, { type, lat: 47.0 + i, lng: 9.0 + i });
        codes.push(last.statusCode);
      }
      expect(codes).toEqual([201, 201, 201, 429]);
      expect(last?.json().error).toMatchObject({ code: "WEB_RATE_LIMITED", details: { scope: "session" } });
      expect(Number(last?.headers["retry-after"])).toBeGreaterThan(0);
    });
  });

  describe("per-IP limits and proxy awareness", () => {
    it("counts a network's writes across fresh sessions, so re-minting a session does not reset the limit", async () => {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) {
        const token = await webToken(limited, "203.0.113.50", { "x-forwarded-for": "203.0.113.50" });
        codes.push((await report(limited, token, { type: "traffic", lat: 43 + i * 0.5, lng: 5 + i * 0.5 }, "127.0.0.1", { "x-forwarded-for": "203.0.113.50" })).statusCode);
      }
      expect(codes).toEqual([201, 201, 201, 201, 429, 429]);
    });

    it("with TRUST_PROXY, different client addresses behind the proxy get independent budgets; without it they share the proxy's", async () => {
      const post = async (a: FastifyInstance, xff: string, i: number) => {
        const token = await webToken(a, "127.0.0.1", { "x-forwarded-for": xff });
        return (await report(a, token, { type: "obstacle", lat: 45 + i * 0.3, lng: 7 + i * 0.3 }, "127.0.0.1", { "x-forwarded-for": xff })).statusCode;
      };
      // trusted proxy: six visitors, one write each, all fine
      const trusted = await Promise.all(["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4", "198.51.100.5", "198.51.100.6"].map((ip, i) => post(limited, ip, 20 + i)));
      expect(trusted).toEqual([201, 201, 201, 201, 201, 201]);
      // untrusted: the header is ignored, all six look like 127.0.0.1 and hit the per-IP budget together (default 10/h -> use 11 sends)
      const { app: strict } = await build({ WEB_REPORT_LIMIT_PER_IP_PER_HOUR: "4", WEB_REPORT_LIMIT_PER_SESSION: "100", REPORT_RATE_LIMIT_MAX: "100" });
      const untrusted: number[] = [];
      for (let i = 0; i < 6; i++) untrusted.push(await post(strict, `198.51.100.${i + 1}`, 30 + i));
      expect(untrusted).toEqual([201, 201, 201, 201, 429, 429]);
      expect(limitedEnv.TRUST_PROXY).toBe("true");
    });
  });

  describe("live updates", () => {
    it("caps the tiles a web session may subscribe to, and pushes events without reporter ids", async () => {
      await limited.listen({ port: 0, host: "127.0.0.1" });
      const address = limited.server.address();
      if (typeof address !== "object" || address === null) throw new Error("no address");
      const wsUrl = `ws://127.0.0.1:${address.port}/v1/ws`;

      const open = (): Promise<WebSocket> => new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
      const inbox = (ws: WebSocket) => {
        const messages: { type: string; message?: string; event?: Record<string, unknown> }[] = [];
        ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
        return messages;
      };
      const until = async (predicate: () => boolean) => {
        for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 25));
        expect(predicate()).toBe(true);
      };

      const webWs = await open();
      const webMessages = inbox(webWs);
      webWs.send(JSON.stringify({ type: "auth", token: await webToken(limited) }));
      await until(() => webMessages.some((m) => m.type === "auth_ok"));

      const clientWs = await open();
      const clientMessages = inbox(clientWs);
      clientWs.send(JSON.stringify({ type: "auth", token: await testToken(limitedEnv, { sub: "client_watcher" }) }));
      await until(() => clientMessages.some((m) => m.type === "auth_ok"));

      const tile = positionToRegionTile(MUNICH.lat, MUNICH.lng, limitedEnv);
      webWs.send(JSON.stringify({ type: "subscribe", tile, k: 2 })); // 19 tiles > cap of 10
      await until(() => webMessages.some((m) => m.type === "error" && /Too many subscribed tiles/.test(m.message ?? "")));
      webWs.send(JSON.stringify({ type: "subscribe", tile, k: 1 })); // 7 tiles: fine
      clientWs.send(JSON.stringify({ type: "subscribe", tile, k: 1 }));
      await new Promise((r) => setTimeout(r, 100));

      const created = await limited.inject({ method: "POST", url: "/v1/hazard-reports", headers: authHeader(await testToken(limitedEnv, { sub: "client_reporter" })), payload: { type: "accident", lat: MUNICH.lat + 0.002, lng: MUNICH.lng } });
      expect(created.statusCode).toBe(201);

      await until(() => webMessages.some((m) => m.type === "event") && clientMessages.some((m) => m.type === "event"));
      const webEvent = webMessages.find((m) => m.type === "event")!;
      const clientEvent = clientMessages.find((m) => m.type === "event")!;
      expect(JSON.stringify(clientEvent)).toContain("client_reporter");
      expect(JSON.stringify(webEvent)).not.toContain("reporterId");
      expect(JSON.stringify(webEvent)).not.toContain("client_reporter");

      // camera-namespace events are not pushed to anyone while the flag is off (REST hides them, the socket must too)
      const before = clientMessages.length;
      await limited.inject({ method: "POST", url: "/v1/hazard-reports", headers: authHeader(await testToken(limitedEnv, { sub: "client_reporter" })), payload: { type: "mobileSpeedCamera", lat: MUNICH.lat + 0.001, lng: MUNICH.lng + 0.001 } });
      await limited.inject({ method: "POST", url: "/v1/hazard-reports", headers: authHeader(await testToken(limitedEnv, { sub: "client_reporter" })), payload: { type: "ice", lat: MUNICH.lat - 0.003, lng: MUNICH.lng } });
      await until(() => clientMessages.length > before);
      const newest = clientMessages.slice(before);
      expect(newest.every((m) => (m.event?.["payload"] as { type?: string } | undefined)?.type !== "mobileSpeedCamera")).toBe(true);
      expect(newest.some((m) => (m.event?.["payload"] as { type?: string } | undefined)?.type === "ice")).toBe(true);

      webWs.close();
      clientWs.close();
    });
  });

  describe("WEB_UI_ENABLED=false", () => {
    it.each(["/", "/connect", "/about", "/web-config.json", "/web/js/map-page.js"])("does not serve %s", async (url) => {
      const res = await off.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
    });

    it("has no session endpoint, and the API itself is unaffected", async () => {
      expect((await off.inject({ method: "POST", url: "/v1/web/session" })).statusCode).toBe(404);
      expect((await off.inject({ method: "GET", url: "/v1/health" })).json()).toEqual({ status: "ok", database: "ok" });
      const res = await off.inject({ method: "GET", url: `/v1/speed-limit?lat=${MUNICH.lat}&lng=${MUNICH.lng}`, headers: authHeader(await testToken(env)) });
      expect(res.statusCode).toBe(200);
      // a token that merely looks like a web session gets no special treatment (and no restriction) on such a node
      const lookalike = await testToken(env, { sub: "web:pretender" });
      const snapshot = await off.inject({ method: "GET", url: "/v1/snapshot", headers: authHeader(lookalike) });
      expect(snapshot.statusCode).toBe(200);
    });
  });
});
