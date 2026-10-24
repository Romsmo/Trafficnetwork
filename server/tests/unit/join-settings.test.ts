import { describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { parseExpiry } from "../../src/join-cli.js";
import { joinSettings } from "../../src/modules/join/service.js";
import { qrSvg, qrTerminal } from "../../src/modules/join/qr.js";
import { formatJoinUri, generateJoinCode } from "../../src/modules/join/code.js";

const base = { DATABASE_URL: "postgres://x:x@localhost:1/x", JWT_SECRET: "a".repeat(32) };
const envWith = (extra: Record<string, string>) => {
  resetEnvCache();
  return loadEnv({ ...base, ...extra });
};

describe("join settings", () => {
  it("takes the address from JOIN_PUBLIC_ADDRESS first, then from FEDERATION_PUBLIC_ADDRESS", () => {
    expect(joinSettings(envWith({ JOIN_PUBLIC_ADDRESS: "https://trafficnetwork.link/" })).node).toBe("trafficnetwork.link");
    expect(joinSettings(envWith({ FEDERATION_PUBLIC_ADDRESS: "https://fed.example.org" })).node).toBe("fed.example.org");
    expect(joinSettings(envWith({ JOIN_PUBLIC_ADDRESS: "https://a.example.org", FEDERATION_PUBLIC_ADDRESS: "https://b.example.org" })).node).toBe("a.example.org");
  });

  it("explains why there is no node part when no usable address is configured", () => {
    const none = joinSettings(envWith({}));
    expect(none.node).toBeNull();
    expect(none.problem).toMatch(/JOIN_PUBLIC_ADDRESS/);
    // a loopback federation address (allowed for local testing) cannot be named in a join code
    const loopback = joinSettings(envWith({ FEDERATION_PUBLIC_ADDRESS: "http://127.0.0.1:3000" }));
    expect(loopback.node).toBeNull();
    expect(loopback.problem).toMatch(/cannot be named/);
  });

  it("refuses to start with a JOIN_PUBLIC_ADDRESS that no code could name", () => {
    for (const bad of ["http://node.example.org", "https://192.0.2.1", "https://localhost", "https://node.example.org/path"]) {
      expect(() => envWith({ JOIN_PUBLIC_ADDRESS: bad })).toThrow(/JOIN_PUBLIC_ADDRESS/);
    }
  });

  it("reads the network root key when it is a well-formed public key and ignores a malformed one", () => {
    const good = "oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8";
    expect(joinSettings(envWith({ JOIN_PUBLIC_ADDRESS: "https://a.example.org", NETWORK_ROOT_PUBLIC_KEY: good })).root?.length).toBe(32);
    expect(joinSettings(envWith({ JOIN_PUBLIC_ADDRESS: "https://a.example.org", NETWORK_ROOT_PUBLIC_KEY: "short" })).root).toBeNull();
  });

  it("defaults: public page on, 7 days grace, no daily cap", () => {
    const env = envWith({});
    expect([env.JOIN_CODE_PUBLIC, env.JOIN_ROTATE_GRACE_DAYS, env.JOIN_CODE_MAX_REGISTRATIONS_PER_DAY]).toEqual([true, 7, 0]);
  });
});

describe("join-cli: --expires", () => {
  const now = new Date("2026-10-24T12:00:00Z");
  it("understands days, hours and minutes", () => {
    expect(parseExpiry("7d", now).toISOString()).toBe("2026-10-31T12:00:00.000Z");
    expect(parseExpiry("12h", now).toISOString()).toBe("2026-10-25T00:00:00.000Z");
    expect(parseExpiry("90m", now).toISOString()).toBe("2026-10-24T13:30:00.000Z");
  });
  it("rejects anything else", () => {
    for (const bad of ["", "7", "0d", "-1d", "7 days", "1w", "d7"]) expect(() => parseExpiry(bad, now)).toThrow(/--expires/);
  });
});

describe("join QR code", () => {
  const uri = formatJoinUri(generateJoinCode("trafficnetwork.link", Buffer.alloc(32, 9)));

  it("is a self-contained SVG: no external reference, no script, no inline style", () => {
    const svg = qrSvg(uri, 'Title with <markup> & "quotes"');
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain("&lt;markup&gt; &amp; &quot;quotes&quot;");
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/https?:|href|<script|style=|<image|<use/i);
    expect(svg.length).toBeLessThan(40_000);
  });

  it("has the quiet zone of four modules on every side", () => {
    const svg = qrSvg(uri, "t");
    const size = Number(/viewBox="0 0 (\d+) /.exec(svg)![1]);
    const coordinates = [...svg.matchAll(/M(\d+) (\d+)h(\d+)v1/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]) }));
    expect(Math.min(...coordinates.map((c) => c.x), ...coordinates.map((c) => c.y))).toBe(4);
    expect(Math.max(...coordinates.map((c) => c.x + c.w))).toBeLessThanOrEqual(size - 4);
    expect(Math.max(...coordinates.map((c) => c.y + 1))).toBeLessThanOrEqual(size - 4);
  });

  it("renders for the terminal as black on white blocks", () => {
    const text = qrTerminal(uri);
    expect(text).toContain("\u001b[30;47m");
    expect(text.split("\n").length).toBeGreaterThan(20);
  });
});
