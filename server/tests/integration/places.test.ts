import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";

/**
 * Place search on one node (docs/place-search.md): the node asks a geocoder (here a small local server that speaks Nominatim's
 * answer) on the visitor's behalf; web sessions may use it; a service that is down is a clear 502; PLACE_SEARCH_URL=none removes it.
 */
describe("place search", () => {
  let testDb: TestDatabase;
  let geocoder: Server;
  let geocoderUrl: string;
  const asked: { url: string; userAgent: string | undefined }[] = [];
  let mode: "ok" | "down" = "ok";
  const closers: (() => Promise<void>)[] = [];

  async function build(extra: Record<string, string> = {}): Promise<{ app: FastifyInstance; env: Env }> {
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      LOG_LEVEL: "silent",
      PLACE_SEARCH_URL: `${geocoderUrl}/search`,
      PLACE_SEARCH_MIN_INTERVAL_MS: "0",
      ...extra,
    });
    const app = await buildApp({ env, db: testDb.db });
    closers.push(() => app.close());
    return { app, env };
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    geocoder = createServer((req, res) => {
      asked.push({ url: req.url ?? "", userAgent: req.headers["user-agent"] });
      if (mode === "down") {
        res.writeHead(503).end("busy");
        return;
      }
      const q = new URL(req.url ?? "", "http://x").searchParams.get("q") ?? "";
      const items =
        q.toLowerCase() === "nichts"
          ? []
          : [
              { place_id: 1, osm_type: "relation", osm_id: 4711, lat: "48.5961", lon: "12.1923", display_name: `${q}, Landkreis Landshut, Bayern, Deutschland`, name: q, type: "administrative", boundingbox: ["48.55", "48.64", "12.15", "12.25"] },
              { place_id: 2, osm_type: "node", osm_id: 9, lat: "48.6", lon: "12.2", display_name: `${q} (Bahnhof), Bayern, Deutschland`, type: "station" },
            ];
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(items));
    });
    await new Promise<void>((resolve) => geocoder.listen(0, "127.0.0.1", resolve));
    geocoderUrl = `http://127.0.0.1:${(geocoder.address() as AddressInfo).port}`;
  }, 90_000);

  afterAll(async () => {
    for (const close of closers) await close();
    await new Promise((resolve) => geocoder.close(resolve));
    await testDb.teardown();
  });

  const webToken = async (app: FastifyInstance) => {
    const res = await app.inject({ method: "POST", url: "/v1/web/session", remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(200);
    return authHeader(res.json().accessToken as string);
  };

  it("finds a place for an anonymous web session, nearest first as the service ranks them, and identifies itself to the service", async () => {
    const { app } = await build();
    const before = asked.length;
    const res = await app.inject({ method: "GET", url: "/v1/places/search?q=Postau&lat=48.6&lng=12.2&lang=de", headers: await webToken(app) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { places } = res.json() as { places: { id: string; name: string; label: string; lat: number; lng: number; bbox: number[] | null }[] };
    expect(places.map((p) => p.name)).toEqual(["Postau", "Postau (Bahnhof)"]);
    expect(places[0]).toMatchObject({ id: "r4711", lat: 48.5961, lng: 12.1923, bbox: [12.15, 48.55, 12.25, 48.64] });
    // what went to the service: the term, a soft area, the node's user agent - nothing of the visitor
    const request = asked[before]!;
    expect(request.url).toContain("q=Postau");
    expect(request.url).toContain("viewbox=");
    expect(request.userAgent).toMatch(/^trafficnetwork-node \(\+https:\/\/github\.com\//);
  });

  it("asks the service once for the same search", async () => {
    const { app } = await build();
    const headers = await webToken(app);
    const before = asked.length;
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: "GET", url: "/v1/places/search?q=Weng", headers });
      expect(res.statusCode).toBe(200);
    }
    expect(asked.length - before).toBe(1);
  });

  it("an empty answer is an empty list, not an error", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/v1/places/search?q=nichts", headers: await webToken(app) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ places: [] });
  });

  it("refuses a term that is too short or too long, and a position that is not one", async () => {
    const { app } = await build();
    const headers = await webToken(app);
    for (const url of ["/v1/places/search", "/v1/places/search?q=a", `/v1/places/search?q=${"x".repeat(121)}`, "/v1/places/search?q=Postau&lat=abc&lng=1", "/v1/places/search?q=Postau&lat=95&lng=1"]) {
      const res = await app.inject({ method: "GET", url, headers });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it("needs a session like every other read", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/v1/places/search?q=Postau" });
    expect(res.statusCode).toBe(401);
  });

  it("a service that is down is a 502 with a code the page can show, and nothing is remembered about it", async () => {
    const { app } = await build();
    const headers = await webToken(app);
    mode = "down";
    const down = await app.inject({ method: "GET", url: "/v1/places/search?q=Moosthann", headers });
    expect(down.statusCode).toBe(502);
    expect(down.json().error.code).toBe("PLACE_SEARCH_UNAVAILABLE");
    mode = "ok";
    const up = await app.inject({ method: "GET", url: "/v1/places/search?q=Moosthann", headers });
    expect(up.statusCode).toBe(200);
  });

  it("counts against the heavy limit of web sessions", async () => {
    const { app } = await build({ WEB_HEAVY_READ_LIMIT_PER_IP_PER_MINUTE: "2" });
    const headers = await webToken(app);
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) codes.push((await app.inject({ method: "GET", url: `/v1/places/search?q=Ort${i}`, headers })).statusCode);
    expect(codes).toEqual([200, 200, 429, 429]);
  });

  it("is told to the clients: GET /v1/config, and the web page's config names the service for the privacy notice", async () => {
    const { app, env } = await build();
    const token = authHeader(await testToken(env));
    const config = (await app.inject({ method: "GET", url: "/v1/config", headers: token })).json();
    expect(config.placeSearch).toEqual({ enabled: true });
    const web = (await app.inject({ method: "GET", url: "/web-config.json" })).json();
    expect(web.placeSearchHost).toBe(new URL(geocoderUrl).host);
  });

  it("PLACE_SEARCH_URL=none: no endpoint, no search box, nothing asked", async () => {
    const { app, env } = await build({ PLACE_SEARCH_URL: "none" });
    const before = asked.length;
    const res = await app.inject({ method: "GET", url: "/v1/places/search?q=Postau", headers: await webToken(app) });
    expect(res.statusCode).toBe(404);
    const web = (await app.inject({ method: "GET", url: "/web-config.json" })).json();
    expect(web.placeSearchHost).toBeNull();
    expect(asked.length).toBe(before);
    const token = authHeader(await testToken(env));
    expect(((await app.inject({ method: "GET", url: "/v1/config", headers: token })).json()).placeSearch).toEqual({ enabled: false });
  });
});
