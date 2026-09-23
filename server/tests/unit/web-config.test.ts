import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { isAcceptableTileUrl, tileOrigin } from "../../src/modules/web/tile.js";
import { parseTrustProxy } from "../../src/lib/trust-proxy.js";
import { privacyRequestSerializer } from "../../src/lib/log-serializers.js";
import { buildCsp, securityHeaders } from "../../src/modules/web/csp.js";

const base = { DATABASE_URL: "postgres://user:pass@localhost:5432/db", JWT_SECRET: "a".repeat(32) };

describe("web UI environment", () => {
  it("defaults: UI on, OSM tiles, privacy logging on, no proxy trust", () => {
    resetEnvCache();
    const env = loadEnv(base);
    expect(env.WEB_UI_ENABLED).toBe(true);
    expect(env.LOG_PRIVACY_MODE).toBe(true);
    expect(env.TRUST_PROXY).toBeUndefined();
    expect(env.PROJECT_REPO_URL).toBe("https://github.com/Romsmo/Trafficnetwork");
    expect(env.MAP_TILE_URL).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(env.MAP_TILE_ATTRIBUTION_TEXT).toContain("OpenStreetMap");
    expect(env.WEB_SESSION_TTL_SECONDS).toBe(900);
    expect(env.WEB_REPORT_LIMIT_PER_SESSION).toBe(3);
    expect(env.WEB_MAX_SEGMENT_RADIUS_M).toBe(1500);
  });

  it("can switch the UI off and the tiles off ('none'); an empty value means the default (docker-compose passes unset vars as empty)", () => {
    resetEnvCache();
    const env = loadEnv({ ...base, WEB_UI_ENABLED: "false", MAP_TILE_URL: "none" });
    expect(env.WEB_UI_ENABLED).toBe(false);
    expect(env.MAP_TILE_URL).toBe("");
    resetEnvCache();
    expect(loadEnv({ ...base, MAP_TILE_URL: "" }).MAP_TILE_URL).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    resetEnvCache();
    expect(loadEnv({ ...base, MAP_TILE_URL: "https://tiles.example/{z}/{x}/{y}.png" }).MAP_TILE_URL).toBe("https://tiles.example/{z}/{x}/{y}.png");
  });

  it.each(["not a url", "https://tiles.example/{z}/{x}.png", "https://a.example/{s}/{z}/{x}/{y}.png", "ftp://tiles.example/{z}/{x}/{y}.png", "https://user:pw@tiles.example/{z}/{x}/{y}.png", "https://t.example/{z}/{z}/{x}/{y}.png"])(
    "rejects an unusable MAP_TILE_URL: %s",
    (url) => {
      resetEnvCache();
      expect(() => loadEnv({ ...base, MAP_TILE_URL: url })).toThrow(/MAP_TILE_URL/);
    },
  );

  it("caps web radii at the API's own 50 km ceiling", () => {
    resetEnvCache();
    expect(() => loadEnv({ ...base, WEB_MAX_SEGMENT_RADIUS_M: "60000" })).toThrow(/WEB_MAX_SEGMENT_RADIUS_M/);
  });
});

describe("tile URL helpers", () => {
  it("accepts the standard template and derives the single origin the CSP needs", () => {
    expect(isAcceptableTileUrl("https://tile.openstreetmap.org/{z}/{x}/{y}.png")).toBe(true);
    expect(tileOrigin("https://tile.openstreetmap.org/{z}/{x}/{y}.png")).toBe("https://tile.openstreetmap.org");
    expect(tileOrigin("http://tiles.lan:8080/{z}/{x}/{y}.png")).toBe("http://tiles.lan:8080");
  });

  it("treats an empty value as 'no tiles'", () => {
    expect(isAcceptableTileUrl("")).toBe(true);
    expect(tileOrigin("")).toBeNull();
  });
});

describe("parseTrustProxy", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["true", true],
    ["1", 1],
    ["2", 2],
    ["172.18.0.0/16", ["172.18.0.0/16"]],
    ["10.0.0.1, 10.0.0.2", ["10.0.0.1", "10.0.0.2"]],
  ])("%j -> %j", (input, expected) => {
    expect(parseTrustProxy(input as string | undefined)).toEqual(expected);
  });
});

describe("privacyRequestSerializer", () => {
  it("drops the query string (coordinates) and the client address", () => {
    const line = privacyRequestSerializer({ method: "GET", url: "/v1/speed-limit?lat=48.1374&lng=11.5755", headers: { host: "node.example" } });
    expect(line).toEqual({ method: "GET", url: "/v1/speed-limit", host: "node.example" });
    expect(JSON.stringify(line)).not.toContain("48.1374");
  });
});

describe("Content-Security-Policy", () => {
  it("allows nothing external except the tile origin, and spells out this host's WebSocket", () => {
    const csp = buildCsp({ tileOrigin: "https://tile.openstreetmap.org", host: "node.example:3000" });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' data: https://tile.openstreetmap.org");
    expect(csp).toContain("connect-src 'self' ws://node.example:3000 wss://node.example:3000");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it("has no extra image origin without tiles, and ignores a malformed Host header", () => {
    const csp = buildCsp({ tileOrigin: null, host: "evil.example; script-src *" });
    expect(csp).toContain("img-src 'self' data:;");
    expect(csp).not.toContain("evil.example");
  });

  it("ships the usual hardening headers", () => {
    const headers = securityHeaders("x");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("geolocation=(self)");
  });
});
