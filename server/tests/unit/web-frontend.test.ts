import { describe, expect, it } from "vitest";
import { formatAge, formatDuration, formatKm, formatRemaining, isExpired, normalizeTimestamp, speedLimitColor } from "../../web/public/assets/js/format.js";
import { CAMERA_TYPES, GENERAL_TYPES, filterReports, selectableTypes, sortNewestFirst } from "../../web/public/assets/js/filter.js";
import { DICTIONARIES, createTranslator, detectLang, interpolate, normalizeLang } from "../../web/public/assets/js/i18n.js";
import { ApiClient, ApiError, buildQuery } from "../../web/public/assets/js/api.js";
import { LiveConnection } from "../../web/public/assets/js/live.js";
import { describeSubmitFailure } from "../../web/public/assets/js/report-dialog.js";
import { tileHost } from "../../web/public/assets/js/config.js";

const de = createTranslator("de");
const en = createTranslator("en");
const NOW = Date.parse("2026-09-23T19:00:00Z");

describe("i18n", () => {
  it("has exactly the same keys in German and English", () => {
    expect(Object.keys(DICTIONARIES.en).sort()).toEqual(Object.keys(DICTIONARIES.de).sort());
  });

  it("keeps placeholders identical in both languages", () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(",");
    for (const key of Object.keys(DICTIONARIES.de)) {
      expect(placeholders(DICTIONARIES.en[key as keyof typeof DICTIONARIES.en]), key).toBe(placeholders(DICTIONARIES.de[key as keyof typeof DICTIONARIES.de]));
    }
  });

  it("has a label for every report category the UI can show", () => {
    for (const type of [...GENERAL_TYPES, ...CAMERA_TYPES]) {
      expect(DICTIONARIES.de[`type.${type}` as keyof typeof DICTIONARIES.de]).toBeTruthy();
      expect(DICTIONARIES.en[`type.${type}` as keyof typeof DICTIONARIES.en]).toBeTruthy();
    }
  });

  it("detects the language: stored choice first, then browser order, then German", () => {
    expect(detectLang(["fr-FR", "en-GB", "de"], null)).toBe("en");
    expect(detectLang(["de-AT"], "en")).toBe("en");
    expect(detectLang(["fr", "es"], null)).toBe("de");
    expect(detectLang(undefined, "xx")).toBe("de");
    expect(normalizeLang("EN-us")).toBe("en");
    expect(normalizeLang("tlh")).toBeNull();
  });

  it("interpolates parameters, leaves unknown ones visible, and falls back to the key for gaps", () => {
    expect(interpolate("a {x} b {y}", { x: 1 })).toBe("a 1 b {y}");
    expect(de.t("does.not.exist")).toBe("does.not.exist");
    expect(de.t("limit.here", { value: 50, unit: "km/h" })).toBe("Tempolimit hier: 50 km/h");
    expect(en.t("limit.here", { value: 50, unit: "km/h" })).toBe("Speed limit here: 50 km/h");
  });

  it("picks singular and plural forms", () => {
    expect(de.tn("time.minutes", 1)).toBe("1 Minute");
    expect(de.tn("time.minutes", 5)).toBe("5 Minuten");
    expect(en.tn("time.hours", 1)).toBe("1 hour");
    expect(en.tn("time.hours", 3)).toBe("3 hours");
  });
});

describe("formatting", () => {
  it("formats durations in the reader's units", () => {
    expect(formatDuration(20_000, en)).toBe("less than a minute");
    expect(formatDuration(5 * 60_000, en)).toBe("5 minutes");
    expect(formatDuration(60_000, de)).toBe("1 Minute");
    expect(formatDuration(3 * 3_600_000, en)).toBe("3 hours");
    expect(formatDuration(72 * 3_600_000, de)).toBe("3 Tagen");
  });

  it("phrases report age and remaining lifetime", () => {
    expect(formatAge("2026-09-23T18:55:00Z", NOW, de)).toBe("gemeldet vor 5 Minuten");
    expect(formatRemaining("2026-09-23T19:20:00Z", NOW, en)).toBe("expires in 20 minutes");
    expect(formatRemaining("2026-09-23T18:59:00Z", NOW, en)).toBe("expired");
    expect(formatAge("garbage", NOW, en)).toBe("");
  });

  it("understands the server's Postgres-style timestamps", () => {
    expect(normalizeTimestamp("2026-09-23 19:04:18.119+00")).toBe("2026-09-23T19:04:18.119+00:00");
    expect(Date.parse(normalizeTimestamp("2026-09-23 19:04:18.119+00"))).toBe(Date.parse("2026-09-23T19:04:18.119Z"));
    expect(normalizeTimestamp("2026-09-23T19:04:18.119Z")).toBe("2026-09-23T19:04:18.119Z");
    expect(isExpired("2026-09-23 18:59:00+00", NOW)).toBe(true);
    expect(isExpired("2026-09-23 19:01:00+00", NOW)).toBe(false);
    expect(isExpired(undefined, NOW)).toBe(false);
  });

  it("formats kilometres and colours speed limits by band (mph converted)", () => {
    expect(formatKm(25_000)).toBe("25");
    expect(formatKm(1500)).toBe("1.5");
    expect(speedLimitColor(30, "kmh")).toBe(speedLimitColor(18, "mph"));
    expect(speedLimitColor(30, "kmh")).not.toBe(speedLimitColor(50, "kmh"));
    expect(speedLimitColor(130, "kmh")).toBe(speedLimitColor(101, "kmh"));
  });
});

describe("category filter", () => {
  const reports = [
    { id: "1", type: "ice", reportedAt: "2026-09-23 18:00:00+00" },
    { id: "2", type: "accident", reportedAt: "2026-09-23 18:30:00+00" },
    { id: "3", type: "mobileSpeedCamera", reportedAt: "2026-09-23 18:45:00+00" },
  ];

  it("offers camera categories only when this node enables them", () => {
    expect(selectableTypes(false)).toEqual(GENERAL_TYPES);
    expect(selectableTypes(false).some((t: string) => CAMERA_TYPES.includes(t))).toBe(false);
    expect(selectableTypes(true)).toEqual([...GENERAL_TYPES, ...CAMERA_TYPES]);
  });

  it("hides camera reports completely while the flag is off, even if their type is 'enabled'", () => {
    const everything = new Set([...GENERAL_TYPES, ...CAMERA_TYPES]);
    expect(filterReports(reports, everything, false).map((r: { id: string }) => r.id)).toEqual(["1", "2"]);
    expect(filterReports(reports, everything, true).map((r: { id: string }) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("respects the visitor's category selection and sorts newest first", () => {
    expect(filterReports(reports, new Set(["ice"]), false).map((r: { id: string }) => r.id)).toEqual(["1"]);
    expect(sortNewestFirst(reports).map((r: { id: string }) => r.id)).toEqual(["3", "2", "1"]);
  });
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, json: async () => body } as unknown as Response;
}

describe("ApiClient", () => {
  it("mints one anonymous session, reuses it, and sends it as a Bearer token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let mints = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/v1/web/session") {
        mints++;
        return jsonResponse(200, { accessToken: `tok${mints}`, expiresIn: 900 });
      }
      return jsonResponse(200, { ok: true });
    };
    const api = new ApiClient({ fetchImpl: fetchImpl as never, now: () => 0 });
    await api.get("/v1/config");
    await api.get("/v1/speed-limit", { lat: "48.1", lng: "11.5" });
    expect(mints).toBe(1);
    expect(calls[1]?.init?.method).toBe("GET");
    expect((calls[1]?.init?.headers as Record<string, string>).authorization).toBe("Bearer tok1");
    expect(calls[2]?.url).toBe("/v1/speed-limit?lat=48.1&lng=11.5");
  });

  it("renews the session shortly before it expires", async () => {
    let now = 0;
    let mints = 0;
    const fetchImpl = async (url: string) => (url === "/v1/web/session" ? jsonResponse(200, { accessToken: `tok${++mints}`, expiresIn: 120 }) : jsonResponse(200, {}));
    const api = new ApiClient({ fetchImpl: fetchImpl as never, now: () => now });
    await api.get("/v1/config");
    now = 30_000; // 90 s left: still fine
    await api.get("/v1/config");
    expect(mints).toBe(1);
    now = 65_000; // under a minute left: renew before the call
    await api.get("/v1/config");
    expect(mints).toBe(2);
  });

  it("retries once with a fresh session when the node answers 401", async () => {
    let mints = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url === "/v1/web/session") return jsonResponse(200, { accessToken: `tok${++mints}`, expiresIn: 900 });
      const auth = (init?.headers as Record<string, string>).authorization;
      return auth === "Bearer tok1" ? jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "expired" } }) : jsonResponse(200, { fine: true });
    };
    const api = new ApiClient({ fetchImpl: fetchImpl as never, now: () => 0 });
    const { data } = await api.get("/v1/config");
    expect(data).toEqual({ fine: true });
    expect(mints).toBe(2);
  });

  it("turns error responses into ApiError, keeping the limit scope and Retry-After for the UI", async () => {
    const fetchImpl = async (url: string) => {
      if (url === "/v1/web/session") return jsonResponse(200, { accessToken: "t", expiresIn: 900 });
      return jsonResponse(429, { error: { code: "WEB_RATE_LIMITED", message: "slow down", details: { scope: "network", retryAfterSeconds: 120 } } }, { "retry-after": "120" });
    };
    const api = new ApiClient({ fetchImpl: fetchImpl as never });
    const error = await api.post("/v1/hazard-reports", { type: "ice" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: "WEB_RATE_LIMITED", retryAfterSeconds: 120, details: { scope: "network" } });
    expect(describeSubmitFailure(error)).toEqual({ kind: "rateLimited", scope: "network", minutes: 2 });
  });

  it("builds query strings without empty values", () => {
    expect(buildQuery({ a: 1, b: undefined, c: "x y" })).toBe("?a=1&c=x+y");
    expect(buildQuery(undefined)).toBe("");
  });

  it("classifies submit failures for the report dialog", () => {
    expect(describeSubmitFailure(new ApiError(400, "BAD_REQUEST", "Plausibility failed", undefined, undefined))).toEqual({ kind: "rejected", reason: "Plausibility failed" });
    expect(describeSubmitFailure(new ApiError(500, "INTERNAL", "boom", undefined, undefined))).toEqual({ kind: "error" });
    expect(describeSubmitFailure(new Error("network down"))).toEqual({ kind: "error" });
  });
});

class FakeSocket {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.();
  }
  serverSays(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe("LiveConnection", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("authenticates, subscribes, delivers events, and resyncs after a reconnect", async () => {
    FakeSocket.instances = [];
    const timers: (() => void)[] = [];
    const events: unknown[] = [];
    const status: boolean[] = [];
    let resyncs = 0;
    const live = new LiveConnection({
      api: { ensureToken: async () => "tok" } as never,
      url: "ws://node/v1/ws",
      WebSocketImpl: FakeSocket as never,
      setTimeoutImpl: ((fn: () => void) => (timers.push(fn), timers.length)) as never,
      clearTimeoutImpl: (() => {}) as never,
      onEvent: (e: unknown) => events.push(e),
      onStatus: (c: boolean) => status.push(c),
      onResync: () => resyncs++,
    });

    live.subscribe("871f8d1dbffffff", 2); // desired before the socket even exists
    live.start();
    await flush();
    const first = FakeSocket.instances[0]!;
    first.onopen?.();
    expect(JSON.parse(first.sent[0]!)).toEqual({ type: "auth", token: "tok" });

    first.serverSays({ type: "auth_ok" });
    expect(status).toEqual([true]);
    expect(JSON.parse(first.sent[1]!)).toEqual({ type: "subscribe", tile: "871f8d1dbffffff", k: 2 });
    expect(resyncs).toBe(0);

    first.serverSays({ type: "event", event: { type: "ReportCreated", entityType: "hazardReport" } });
    expect(events).toHaveLength(1);

    // moving the map: old tile is dropped, new one subscribed
    live.subscribe("871f8d1d0ffffff", 2);
    expect(first.sent.slice(2).map((s) => JSON.parse(s).type)).toEqual(["unsubscribe", "subscribe"]);

    first.close(); // connection lost
    expect(status).toEqual([true, false]);
    timers.shift()!(); // backoff timer fires
    await flush();
    const second = FakeSocket.instances[1]!;
    second.onopen?.();
    second.serverSays({ type: "auth_ok" });
    expect(resyncs).toBe(1);
    expect(JSON.parse(second.sent[1]!)).toEqual({ type: "subscribe", tile: "871f8d1d0ffffff", k: 2 });
  });
});

describe("web config helpers", () => {
  it("extracts the tile host for the privacy text, or null without tiles", () => {
    expect(tileHost({ tiles: { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png" } })).toBe("tile.openstreetmap.org");
    expect(tileHost({ tiles: null })).toBeNull();
  });
});
