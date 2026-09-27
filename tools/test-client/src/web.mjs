import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_RADIUS_M } from "./core.mjs";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function snapshot(client) {
  const c = client.state.cache;
  return {
    status: client.syncStatus(),
    cache: c && { center: { lat: c.lat, lng: c.lng }, radiusM: c.radiusM, fetchedAt: c.fetchedAt, segments: c.segments, signs: c.signs, hazards: c.hazards },
    outbox: client.outbox,
    events: client.recentEvents.slice(0, 15),
  };
}

export async function startWebServer(client, { port }) {
  const sseClients = new Set();
  const notify = () => { const msg = `event: change\ndata: ${Date.now()}\n\n`; for (const r of sseClients) r.write(msg); };
  for (const ev of ["status", "event", "sent", "position", "failover"]) client.on(ev, notify);

  let syncing = null;
  const ensureCache = async (lat, lng) => {
    if (client.cacheCovers(lat, lng) || syncing) return;
    syncing = client.syncSurroundings(lat, lng, CACHE_RADIUS_M).catch(() => {}).finally(() => { syncing = null; notify(); });
  };

  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((ok, fail) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > 1e6) fail(new Error("body too large")); }); req.on("end", () => ok(d ? JSON.parse(d) : {})); req.on("error", fail); });

  const server = createServer(async (req, res) => {
    // Local-only hardening: right Host header (blocks DNS rebinding) and a custom header on writes (blocks cross-site POSTs).
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(403); return res.end("forbidden host"); }
    const url = new URL(req.url, `http://${host}`);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) { res.writeHead(200, { "content-type": TYPES[".html"] }); return res.end(readFileSync(join(PUBLIC_DIR, "index.html"))); }
      if (req.method === "GET" && url.pathname === "/app.js") { res.writeHead(200, { "content-type": TYPES[".js"] }); return res.end(readFileSync(join(PUBLIC_DIR, "app.js"))); }
      if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, snapshot(client));
      if (req.method === "GET" && url.pathname === "/api/network") return json(res, 200, await client.networkStatus());
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write("retry: 1500\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }
      if (req.method === "POST") {
        if (req.headers["x-test-client"] !== "1") return json(res, 403, { error: "missing x-test-client header" });
        const b = await readBody(req);
        if (url.pathname === "/api/position") {
          client.setPosition(b.lat, b.lng);
          ensureCache(b.lat, b.lng);
          client.subscribeAround();
          const limit = await client.speedLimitAt(b.lat, b.lng).catch((e) => ({ found: false, error: e.message }));
          return json(res, 200, { limit });
        }
        if (url.pathname === "/api/report") { const p = client.position; const results = await client.submit({ kind: "report", type: b.type, lat: b.lat ?? p?.lat, lng: b.lng ?? p?.lng, speedKmh: b.speedKmh, signed: !!b.signed }); return json(res, 200, results); }
        if (url.pathname === "/api/confirm") return json(res, 200, await client.submit({ kind: "confirm", reportId: b.reportId, confirmKind: b.kind }));
        if (url.pathname === "/api/flush") return json(res, 200, await client.flushOutbox());
        if (url.pathname === "/api/sync") { const p = client.position; if (!p) return json(res, 400, { error: "no position set" }); return json(res, 200, await client.syncSurroundings(p.lat, p.lng)); }
        if (url.pathname === "/api/bind-key") return json(res, 200, await client.bindDeviceKey());
      }
      res.writeHead(404); res.end("not found");
    } catch (e) { json(res, e.code === "OFFLINE" ? 503 : 500, { error: String(e.message ?? e) }); }
  });

  await new Promise((ok, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", ok); });
  console.log(`Test client "${client.profile}" UI: http://127.0.0.1:${port}  (local only)`);
  return server;
}
