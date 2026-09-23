import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { classifyWebRequest, isWebSessionSubject, limitChecksFor, type WebPolicy, type WebRequestInfo } from "../../src/modules/web/guard.js";
import { SlidingWindowLimiter } from "../../src/modules/web/limits.js";
import { stripReporterIds } from "../../src/modules/web/redact.js";

const policy: WebPolicy = { maxSegmentRadiusM: 1500, maxHazardRadiusM: 25_000, cameraNamespaceEnabled: false };
const req = (over: Partial<WebRequestInfo>): WebRequestInfo => ({ method: "GET", path: "/v1/config", query: {}, body: undefined, ...over });

describe("classifyWebRequest (default-deny allowlist)", () => {
  it.each(["/v1/config", "/v1/speed-limit", "/v1/hazard-reports/by-tile", "/v1/speed-cameras/nearby", "/v1/speed-cameras/by-tile"])("allows reading %s", (path) => {
    expect(classifyWebRequest(req({ path }), policy)).toEqual({ kind: "allow", category: "read" });
  });

  it("treats the road-segment layer as heavy and caps its radius", () => {
    expect(classifyWebRequest(req({ path: "/v1/speed-limit-segments/nearby", query: { radiusM: "1500" } }), policy)).toEqual({ kind: "allow", category: "heavy-read" });
    const tooBig = classifyWebRequest(req({ path: "/v1/speed-limit-segments/nearby", query: { radiusM: "1501" } }), policy);
    expect(tooBig).toMatchObject({ kind: "deny", status: 400, code: "WEB_RADIUS_TOO_LARGE" });
  });

  it("caps the hazard radius too, but lets a missing radius through to the endpoint's own validation", () => {
    expect(classifyWebRequest(req({ path: "/v1/hazard-reports/nearby", query: { radiusM: "25000" } }), policy)).toMatchObject({ kind: "allow" });
    expect(classifyWebRequest(req({ path: "/v1/hazard-reports/nearby", query: { radiusM: "50000" } }), policy)).toMatchObject({ kind: "deny", code: "WEB_RADIUS_TOO_LARGE" });
    expect(classifyWebRequest(req({ path: "/v1/hazard-reports/nearby", query: {} }), policy)).toMatchObject({ kind: "allow" });
  });

  it.each([
    ["GET", "/v1/snapshot"],
    ["GET", "/v1/delta"],
    ["GET", "/v1/static-data/manifest"],
    ["GET", "/v1/static-data/partitions/821e37fffffffff"],
    ["GET", "/v1/static-signs/nearby"],
    ["POST", "/v1/devices/bind-key"],
    ["POST", "/v1/devices/register"],
    ["POST", "/v1/bulk-import/speed-limit-segments"],
    ["POST", "/v1/speed-cameras/abc/removal-reports"],
    ["GET", "/v1/some-endpoint-added-next-year"],
    ["DELETE", "/v1/hazard-reports"],
    ["GET", "/v1/hazard-reports"],
  ])("denies %s %s", (method, path) => {
    expect(classifyWebRequest(req({ method, path }), policy)).toMatchObject({ kind: "deny", status: 403, code: "WEB_SESSION_FORBIDDEN" });
  });

  it("allows creating a general report and confirming one, both as writes", () => {
    expect(classifyWebRequest(req({ method: "POST", path: "/v1/hazard-reports", body: { type: "ice", lat: 48.1, lng: 11.5 } }), policy)).toEqual({ kind: "allow", category: "write" });
    expect(classifyWebRequest(req({ method: "POST", path: "/v1/hazard-reports/1f2e3d/confirmations", body: { kind: "stillThere" } }), policy)).toEqual({ kind: "allow", category: "write" });
  });

  it("never lets a web session attach a device signature (its reports stay on this node)", () => {
    const decision = classifyWebRequest(req({ method: "POST", path: "/v1/hazard-reports", body: { type: "ice", lat: 1, lng: 2, deviceAssertion: { payload: {}, keyId: "x", signature: "y" } } }), policy);
    expect(decision).toMatchObject({ kind: "deny", code: "WEB_NO_DEVICE_SIGNATURE" });
  });

  it("refuses camera categories while the namespace flag is off, and allows them once it is on", () => {
    const camera = req({ method: "POST", path: "/v1/hazard-reports", body: { type: "mobileSpeedCamera", lat: 1, lng: 2 } });
    expect(classifyWebRequest(camera, policy)).toMatchObject({ kind: "deny", code: "WEB_TYPE_NOT_ALLOWED" });
    expect(classifyWebRequest({ ...camera, body: { type: "fixedSpeedCamera", lat: 1, lng: 2 } }, policy)).toMatchObject({ kind: "deny", code: "WEB_TYPE_NOT_ALLOWED" });
    expect(classifyWebRequest(camera, { ...policy, cameraNamespaceEnabled: true })).toMatchObject({ kind: "allow", category: "write" });
  });

  it("lets a body without a usable type through to the endpoint's own 400", () => {
    expect(classifyWebRequest(req({ method: "POST", path: "/v1/hazard-reports", body: null }), policy)).toMatchObject({ kind: "allow", category: "write" });
  });
});

describe("web session subjects", () => {
  it("recognises only the web: prefix", () => {
    expect(isWebSessionSubject("web:abc")).toBe(true);
    expect(isWebSessionSubject("client_abc")).toBe(false);
    expect(isWebSessionSubject(undefined)).toBe(false);
  });
});

describe("SlidingWindowLimiter", () => {
  it("allows up to max hits in the window, then reports how long to wait", () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowLimiter(() => now);
    const check = { key: "k", max: 2, windowMs: 60_000, scope: "network" };
    expect(limiter.tryConsume([check]).allowed).toBe(true);
    now += 10_000;
    expect(limiter.tryConsume([check]).allowed).toBe(true);
    now += 10_000;
    const blocked = limiter.tryConsume([check]);
    expect(blocked).toEqual({ allowed: false, scope: "network", retryAfterSeconds: 40 });
    now += 41_000;
    expect(limiter.tryConsume([check]).allowed).toBe(true);
  });

  it("is all-or-nothing: a request refused by one limit does not use up the others", () => {
    const limiter = new SlidingWindowLimiter(() => 5);
    const tight = { key: "tight", max: 1, windowMs: 1000, scope: "session" };
    const loose = { key: "loose", max: 100, windowMs: 1000, scope: "node" };
    expect(limiter.tryConsume([tight, loose]).allowed).toBe(true);
    expect(limiter.tryConsume([tight, loose])).toMatchObject({ allowed: false, scope: "session" });
    // the refused attempt must not have been counted against "loose"
    for (let i = 0; i < 99; i++) expect(limiter.tryConsume([loose]).allowed).toBe(true);
    expect(limiter.tryConsume([loose]).allowed).toBe(false);
  });

  it("prunes idle keys", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(() => now);
    limiter.tryConsume([{ key: "a", max: 5, windowMs: 1000, scope: "x" }]);
    now = 10_000;
    limiter.prune(5000);
    expect(limiter.size).toBe(0);
  });
});

describe("limitChecksFor", () => {
  resetEnvCache();
  const env = loadEnv({ DATABASE_URL: "postgres://u:p@h/d", JWT_SECRET: "a".repeat(32) });

  it("write requests are limited per session, per IP and per node", () => {
    const checks = limitChecksFor("write", "web:s1", "203.0.113.7", env);
    expect(checks.map((c) => c.key)).toEqual(["wsess:web:s1", "wip:203.0.113.7", "wnode"]);
    expect(checks[0]).toMatchObject({ max: 3, windowMs: 10 * 60_000 });
    expect(checks[1]).toMatchObject({ max: 10, windowMs: 3_600_000 });
    expect(checks[2]).toMatchObject({ max: 300, windowMs: 3_600_000 });
  });

  it("the segment layer counts against both the general read budget and its own tighter one", () => {
    const keys = limitChecksFor("heavy-read", "web:s1", "203.0.113.7", env).map((c) => c.key);
    expect(keys).toEqual(["read:203.0.113.7", "heavy:203.0.113.7"]);
  });
});

describe("stripReporterIds", () => {
  it("removes reporter ids everywhere in a response or event, without touching the original", () => {
    const original = {
      reports: [{ id: "1", reporterId: "client_abc", type: "ice" }],
      report: { id: "2", reporterId: "web:zzz" },
      event: { payload: { id: "3", reporterId: "client_def", confirmCount: 2 } },
    };
    const clean = stripReporterIds(original);
    expect(JSON.stringify(clean)).not.toContain("reporterId");
    expect(clean.reports[0]).toEqual({ id: "1", type: "ice" });
    expect(clean.event.payload.confirmCount).toBe(2);
    expect(original.reports[0]?.reporterId).toBe("client_abc");
  });
});
