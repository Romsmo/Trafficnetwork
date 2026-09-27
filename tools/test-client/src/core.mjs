// Test client core: talks to one or more Trafficnetwork servers over plain HTTP/WebSocket
// (no client-lib yet - see README). Zero dependencies, Node >= 22.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";

const HAZARD_TYPES = ["traffic", "ice", "accident", "construction", "breakdown", "obstacle"];
const CACHE_RADIUS_M = 3000;
const CACHE_REFETCH_M = 1000;

// RFC 8785 (JCS) for the JSON subset used in payloads: sorted keys, ES number/string serialization.
export function canonicalize(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}

const keyIdOf = (pub) => createHash("sha256").update(pub, "utf8").digest("hex").slice(0, 16);

export function generateDeviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKeyRaw: publicKey.export({ format: "jwk" }).x, privateKeyRaw: privateKey.export({ format: "jwk" }).d };
}

export function signEnvelope(payload, pair) {
  const priv = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: pair.publicKeyRaw, d: pair.privateKeyRaw }, format: "jwk" });
  const signature = edSign(null, Buffer.from(canonicalize(payload), "utf8"), priv).toString("base64url");
  return { payload, keyId: keyIdOf(pair.publicKeyRaw), signature };
}

export const haversineM = (lat1, lng1, lat2, lng2) => {
  const R = 6371000, r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

// Distance from a point to a polyline (meters, local equirectangular projection).
export function distToLineM(lat, lng, line) {
  const k = Math.cos((lat * Math.PI) / 180), m = 111320;
  const px = lng * k * m, py = lat * m;
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const ax = line[i][0] * k * m, ay = line[i][1] * m, bx = line[i + 1][0] * k * m, by = line[i + 1][1] * m;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

export class TestClient extends EventEmitter {
  /**
   * config: { servers: [{ url, appKey: { clientId, clientSecret } }], maxLookupDistanceM? }
   * profile: name of this simulated device; its state lives in <stateDir>/<profile>.json
   */
  constructor(config, { profile = "device-a", stateDir = "./state" } = {}) {
    super();
    this.config = config;
    this.profile = profile;
    this.statePath = join(stateDir, `${profile}.json`);
    this.maxLookupDistanceM = config.maxLookupDistanceM ?? 200;
    this.state = this.#loadState();
    this.servers = config.servers.map((s) => ({ url: s.url.replace(/\/$/, ""), appKey: s.appKey, down: false, downUntil: 0, failures: 0, lastLatencyMs: null, token: null, tokenExp: 0 }));
    this.active = 0;
    this.position = this.state.position ?? null;
    this.push = { connected: false, server: null, ws: null };
    this.recentEvents = [];
    this.timers = [];
  }

  // ---------- local state (device identity, cache, outbox) ----------
  #loadState() {
    if (existsSync(this.statePath)) {
      try { return JSON.parse(readFileSync(this.statePath, "utf8")); } catch { /* fall through */ }
    }
    return { devices: {}, deviceKey: generateDeviceKey(), cache: null, outbox: [], position: null, lastSync: null };
  }
  #save() {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = this.statePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.statePath);
  }

  // ---------- server selection / failover ----------
  #order() {
    const now = Date.now();
    const usable = this.servers.filter((s) => !s.down || s.downUntil <= now);
    // Prefer the currently active server while healthy, otherwise lowest latency.
    usable.sort((a, b) => (a === this.servers[this.active] ? -1 : b === this.servers[this.active] ? 1 : (a.lastLatencyMs ?? 1e9) - (b.lastLatencyMs ?? 1e9)));
    return usable;
  }
  #markDown(s, err) {
    s.failures++;
    s.down = true;
    s.downUntil = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(s.failures, 5));
    s.lastError = String(err?.message ?? err);
    this.emit("status");
  }
  #markUp(s, ms) {
    s.down = false; s.failures = 0; s.lastLatencyMs = ms; s.lastError = null;
    const idx = this.servers.indexOf(s);
    if (idx !== this.active) { this.active = idx; this.emit("failover", s.url); }
    this.emit("status");
  }

  async #rawFetch(s, path, opts = {}) {
    const started = Date.now();
    const res = await fetch(s.url + path, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs ?? 6000) });
    return { res, ms: Date.now() - started };
  }

  async #ensureToken(s) {
    if (s.token && s.tokenExp - 30000 > Date.now()) return s.token;
    // Reuse a token persisted by an earlier CLI run - /v1/auth/token is IP-rate-limited (10/min).
    const saved = this.state.tokens?.[s.url];
    if (saved && saved.exp - 30000 > Date.now()) { s.token = saved.token; s.tokenExp = saved.exp; return s.token; }
    const dev = (this.state.devices[s.url] ??= null);
    let creds = dev;
    if (!creds) {
      if (!s.appKey) throw new Error(`no app key configured for ${s.url}`);
      const tok = await this.#rawFetch(s, "/v1/auth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(s.appKey) });
      if (!tok.res.ok) throw new Error(`app key rejected by ${s.url}: HTTP ${tok.res.status}`);
      const appTok = (await tok.res.json()).accessToken;
      const reg = await this.#rawFetch(s, "/v1/devices/register", { method: "POST", headers: { authorization: `Bearer ${appTok}` } });
      if (!reg.res.ok) throw new Error(`device registration failed at ${s.url}: HTTP ${reg.res.status}`);
      creds = await reg.res.json();
      this.state.devices[s.url] = creds;
      this.#save();
    }
    const r = await this.#rawFetch(s, "/v1/auth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(creds) });
    if (!r.res.ok) throw new Error(`token request failed at ${s.url}: HTTP ${r.res.status}`);
    const j = await r.res.json();
    s.token = j.accessToken;
    s.tokenExp = Date.now() + j.expiresIn * 1000;
    (this.state.tokens ??= {})[s.url] = { token: s.token, exp: s.tokenExp };
    this.#save();
    return s.token;
  }

  /** Authenticated request with automatic failover. Throws only if every server failed. */
  async api(path, { method = "GET", body, servers } = {}) {
    let lastErr;
    for (const s of servers ?? this.#order()) {
      try {
        const token = await this.#ensureToken(s);
        let { res, ms } = await this.#rawFetch(s, path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
        if (res.status === 401) { s.token = null; const t2 = await this.#ensureToken(s); ({ res, ms } = await this.#rawFetch(s, path, { method, headers: { authorization: `Bearer ${t2}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined })); }
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        this.#markUp(s, ms);
        const text = await res.text();
        return { status: res.status, data: text ? JSON.parse(text) : null, server: s.url };
      } catch (err) {
        lastErr = err;
        this.#markDown(s, err);
      }
    }
    const e = new Error(`all servers unreachable: ${lastErr?.message ?? "no server usable"}`);
    e.code = "OFFLINE";
    throw e;
  }

  async publicGet(path) {
    let lastErr;
    for (const s of this.#order()) {
      try { const { res, ms } = await this.#rawFetch(s, path); this.#markUp(s, ms); return await res.json(); } catch (e) { lastErr = e; this.#markDown(s, e); }
    }
    throw lastErr ?? new Error("offline");
  }

  // ---------- local data cache (surroundings) ----------
  cacheCovers(lat, lng) {
    const c = this.state.cache;
    return !!c && haversineM(lat, lng, c.lat, c.lng) < c.radiusM - CACHE_REFETCH_M;
  }

  /** Downloads segments/signs around (lat,lng) into the local cache. Keeps the old cache if offline. */
  async syncSurroundings(lat, lng, radiusM = CACHE_RADIUS_M) {
    const q = `lat=${lat}&lng=${lng}&radiusM=${radiusM}`;
    const [seg, sign, haz] = await Promise.all([
      this.api(`/v1/speed-limit-segments/nearby?${q}`),
      this.api(`/v1/static-signs/nearby?${q}`),
      this.api(`/v1/hazard-reports/nearby?${q}`),
    ]);
    const list = (r, key) => (Array.isArray(r.data) ? r.data : r.data?.[key] ?? r.data?.items ?? []);
    this.state.cache = {
      lat, lng, radiusM, fetchedAt: new Date().toISOString(), server: seg.server,
      segments: list(seg, "segments"), signs: list(sign, "signs"), hazards: list(haz, "reports"),
    };
    this.state.lastSync = { at: this.state.cache.fetchedAt, server: seg.server, segments: this.state.cache.segments.length, signs: this.state.cache.signs.length, hazards: this.state.cache.hazards.length };
    this.#save();
    this.emit("status");
    return this.state.lastSync;
  }

  /** Speed limit at a point: server if reachable, otherwise computed from the local cache. */
  async speedLimitAt(lat, lng) {
    try {
      const r = await this.api(`/v1/speed-limit?lat=${lat}&lng=${lng}`);
      if (r.status !== 404) return { found: true, from: "server", server: r.server, ...r.data };
      // The server knows no segment here (e.g. a fresh node without static data): try what this device already has.
      const local = this.#lookupLocal(lat, lng);
      return local.found ? { ...local, from: "local-cache", note: `${r.server} had no segment here` } : { found: false, from: "server", server: r.server };
    } catch (e) {
      if (e.code !== "OFFLINE") throw e;
      return this.state.cache ? this.#lookupLocal(lat, lng) : { found: false, from: "offline-no-cache" };
    }
  }

  #lookupLocal(lat, lng) {
    let best = null;
    for (const seg of this.state.cache?.segments ?? []) {
      const line = seg.geometry?.coordinates;
      if (!line) continue;
      const d = distToLineM(lat, lng, line);
      if (d <= this.maxLookupDistanceM && (!best || d < best.d)) best = { d, seg };
    }
    return best ? { found: true, from: "local-cache", segmentId: best.seg.id, speedLimit: best.seg.speedLimit, speedLimitUnit: best.seg.speedLimitUnit, distanceMeters: best.d } : { found: false, from: "local-cache" };
  }

  setPosition(lat, lng) {
    this.position = { lat, lng };
    this.state.position = this.position;
    this.#save();
    this.emit("position", this.position);
  }

  // ---------- reports (outbox = offline buffer) ----------
  get outbox() { return this.state.outbox; }

  /** Queues a write and tries to send immediately; stays buffered if offline. */
  async submit(item) {
    this.state.outbox.push({ ...item, localId: `${this.profile}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, queuedAt: new Date().toISOString() });
    this.#save();
    this.emit("status");
    return this.flushOutbox();
  }

  async flushOutbox() {
    const results = [];
    while (this.state.outbox.length) {
      const item = this.state.outbox[0];
      try {
        const r = await this.#send(item);
        if (r.status >= 400 && r.status < 500 && r.status !== 429) { results.push({ localId: item.localId, sent: false, dropped: true, status: r.status, error: r.data }); }
        else if (r.status === 429) { results.push({ localId: item.localId, sent: false, retry: true, status: 429 }); break; }
        else results.push({ localId: item.localId, sent: true, status: r.status, server: r.server, data: r.data });
        this.state.outbox.shift();
        this.#save();
        this.emit("sent", results[results.length - 1]);
      } catch (e) {
        if (e.code === "OFFLINE") { results.push({ localId: item.localId, sent: false, buffered: true }); break; }
        throw e;
      }
    }
    this.emit("status");
    return results;
  }

  async #send(item) {
    if (item.kind === "report") {
      const body = { type: item.type, lat: item.lat, lng: item.lng, ...(item.speedKmh != null ? { speedKmh: item.speedKmh } : {}) };
      if (item.signed) body.deviceAssertion = signEnvelope({ kind: "create", type: body.type, lat: body.lat, lng: body.lng, ...(body.speedKmh != null ? { speedKmh: body.speedKmh } : {}), devicePublicKey: this.state.deviceKey.publicKeyRaw, timestamp: new Date().toISOString() }, this.state.deviceKey);
      return this.api("/v1/hazard-reports", { method: "POST", body });
    }
    if (item.kind === "confirm") return this.api(`/v1/hazard-reports/${item.reportId}/confirmations`, { method: "POST", body: { kind: item.confirmKind } });
    throw new Error(`unknown outbox item kind ${item.kind}`);
  }

  /** Binds the device's Ed25519 key to its client identity on the active server (enables signed/federated reports). */
  async bindDeviceKey() {
    const pair = this.state.deviceKey;
    const assertion = signEnvelope({ publicKey: pair.publicKeyRaw, timestamp: new Date().toISOString() }, pair);
    return this.api("/v1/devices/bind-key", { method: "POST", body: { assertion } });
  }

  // ---------- status ----------
  async networkStatus() {
    const out = [];
    for (const s of this.servers) {
      const entry = { url: s.url, active: s === this.servers[this.active], down: s.down, latencyMs: s.lastLatencyMs, lastError: s.lastError ?? null };
      try {
        const started = Date.now();
        const r = await fetch(s.url + "/v1/health", { signal: AbortSignal.timeout(3000) });
        entry.health = await r.json(); entry.latencyMs = Date.now() - started; entry.reachable = true;
        const info = await (await fetch(s.url + "/v1/network/directory", { signal: AbortSignal.timeout(3000) })).json();
        entry.nodeId = info.self?.nodeId; entry.peers = (info.peers ?? []).map((p) => ({ nodeId: p.nodeId, address: p.address, tier: p.tier }));
      } catch (e) { entry.reachable = false; entry.error = String(e.message ?? e); }
      out.push(entry);
    }
    return out;
  }

  syncStatus() {
    return {
      profile: this.profile, activeServer: this.servers[this.active]?.url, position: this.position,
      lastSync: this.state.lastSync, cache: this.state.cache ? { at: this.state.cache.fetchedAt, radiusM: this.state.cache.radiusM, center: { lat: this.state.cache.lat, lng: this.state.cache.lng }, segments: this.state.cache.segments.length, signs: this.state.cache.signs.length, hazards: this.state.cache.hazards.length } : null,
      outbox: this.state.outbox.length, push: { connected: this.push.connected, server: this.push.server },
      servers: this.servers.map((s) => ({ url: s.url, down: s.down, latencyMs: s.lastLatencyMs, lastError: s.lastError ?? null })),
    };
  }

  // ---------- real-time push (WebSocket) ----------
  startPush(tileFor) {
    const connect = async () => {
      const s = this.#order()[0];
      if (!s) return;
      try {
        const token = await this.#ensureToken(s);
        const ws = new WebSocket(s.url.replace(/^http/, "ws") + "/v1/ws");
        this.push.ws = ws;
        ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.type === "auth_ok") {
            this.push.connected = true; this.push.server = s.url; this.emit("status"); this.subscribeAround();
            // Events pushed while the socket was down are gone - catch up by re-reading the surroundings.
            const c = this.state.cache, p = this.position ?? (c && { lat: c.lat, lng: c.lng });
            if (p && (!this.state.lastSync || Date.now() - Date.parse(this.state.lastSync.at) > 5000)) this.syncSurroundings(p.lat, p.lng, c?.radiusM).catch(() => {});
          }
          else if (msg.type === "event") { const ev = { ...msg.event, receivedAt: new Date().toISOString(), via: s.url }; this.recentEvents.unshift(ev); this.recentEvents.length = Math.min(this.recentEvents.length, 50); this.applyEvent(ev); this.emit("event", ev); }
        };
        ws.onclose = () => { this.push.connected = false; this.push.ws = null; this.emit("status"); };
        ws.onerror = () => { if (!this.push.connected) this.#markDown(s, "websocket connect failed"); try { ws.close(); } catch { /* ignore */ } };
      } catch (e) { this.#markDown(s, e); }
    };
    this.tileFor = tileFor;
    this.timers.push(setInterval(() => { if (!this.push.ws) connect(); }, 3000));
    connect();
  }

  subscribeAround() {
    if (!this.push.connected || !this.position || !this.tileFor) return;
    const tile = this.tileFor(this.position.lat, this.position.lng);
    this.push.ws.send(JSON.stringify({ type: "subscribe", tile, k: 2 }));
  }

  /** Keeps the local cache's hazard list in step with pushed events. */
  applyEvent(ev) {
    const c = this.state.cache;
    if (!c || ev.entityType !== "hazardReport") return;
    const id = ev.entityId;
    const p = ev.payload?.report ?? ev.payload;
    if (ev.type === "ReportExpired") c.hazards = c.hazards.filter((h) => h.id !== id);
    else if (p && (ev.type === "ReportCreated" || ev.type === "ReportConfirmed")) {
      const i = c.hazards.findIndex((h) => h.id === id);
      const merged = { ...(i >= 0 ? c.hazards[i] : {}), ...p, id };
      if (i >= 0) c.hazards[i] = merged; else c.hazards.push(merged);
    }
    this.#save();
  }

  startBackground() {
    this.timers.push(setInterval(() => { if (this.state.outbox.length) this.flushOutbox().catch(() => {}); }, 4000));
    this.timers.push(setInterval(() => this.probeServers().catch(() => {}), 5000));
  }

  /** Cheap health probe of every server so failover/recovery does not wait for the next user action. */
  async probeServers() {
    const before = this.servers[this.active];
    await Promise.all(this.servers.map(async (s) => {
      try { const { res, ms } = await this.#rawFetch(s, "/v1/health", { timeoutMs: 2000 }); if (!res.ok) throw new Error(`HTTP ${res.status}`); s.lastLatencyMs = ms; if (s.down) { s.down = false; s.failures = 0; s.lastError = null; this.emit("status"); } }
      catch (e) { if (!s.down) this.#markDown(s, e); }
    }));
    if (this.servers[this.active].down) {
      const next = this.#order()[0];
      if (next) { this.active = this.servers.indexOf(next); this.emit("failover", next.url); }
    }
    if (this.servers[this.active] !== before) { this.emit("status"); try { this.push.ws?.close(); } catch { /* reconnects via the push timer */ } }
  }
  stop() { this.timers.forEach(clearInterval); try { this.push.ws?.close(); } catch { /* ignore */ } }
}

export { HAZARD_TYPES, CACHE_RADIUS_M, CACHE_REFETCH_M };
export const loadConfig = (path) => JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
