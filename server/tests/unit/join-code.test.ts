import { readFileSync } from "node:fs";
import { hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  JoinCodeError,
  b64url,
  computeCheck,
  deriveCredentials,
  formatJoinUri,
  generateJoinCode,
  isValidNode,
  nodeFromAddress,
  parseJoinUri,
  rootFingerprint,
} from "../../src/modules/join/code.js";

interface Valid {
  name: string;
  node: string;
  seedHex: string;
  rootHex: string | null;
  k: string;
  r: string | null;
  c: string;
  id: string;
  secret: string;
  fingerprint: string | null;
  uri: string;
}
interface Vectors {
  rfc5869TestCase1: { ikm: string; salt: string; info: string; length: number; okm: string };
  valid: Valid[];
  invalid: { name: string; uri: string; reason: string }[];
}

const vectors = JSON.parse(readFileSync(new URL("../../docs/join-code-vectors.json", import.meta.url), "utf8")) as Vectors;

function reasonOf(input: string): string | null {
  try {
    parseJoinUri(input);
    return null;
  } catch (err) {
    if (!(err instanceof JoinCodeError)) throw err;
    return err.reason;
  }
}

describe("join code: test vectors (Appendix A.9)", () => {
  for (const v of vectors.valid) {
    it(`${v.name}: parses, derives and re-formats exactly`, () => {
      const code = parseJoinUri(v.uri);
      expect(code.node).toBe(v.node);
      expect(code.seed.toString("hex")).toBe(v.seedHex);
      expect(code.root?.toString("hex") ?? null).toBe(v.rootHex);
      expect(b64url(code.seed)).toBe(v.k);
      expect(computeCheck(v.node, code.seed)).toBe(v.c);
      const credentials = deriveCredentials(code.seed);
      expect(credentials.clientId).toBe(v.id);
      expect(credentials.clientSecret).toBe(v.secret);
      expect(code.root ? rootFingerprint(code.root) : null).toBe(v.fingerprint);
      expect(formatJoinUri(code)).toBe(v.uri);
    });
  }

  for (const v of vectors.invalid) {
    it(`${v.name}: is rejected as ${v.reason}`, () => {
      expect(reasonOf(v.uri)).toBe(v.reason);
    });
  }

  it("HKDF-SHA256 matches RFC 5869 test case 1 (guards the library use)", () => {
    const t = vectors.rfc5869TestCase1;
    const okm = Buffer.from(hkdfSync("sha256", Buffer.from(t.ikm, "hex"), Buffer.from(t.salt, "hex"), Buffer.from(t.info, "hex"), t.length));
    expect(okm.toString("hex")).toBe(t.okm);
  });
});

describe("join code: generation", () => {
  it("creates codes that parse back and differ from one another", () => {
    const a = generateJoinCode("tn.example.org", null);
    const b = generateJoinCode("tn.example.org", null);
    expect(a.seed.equals(b.seed)).toBe(false);
    const parsed = parseJoinUri(formatJoinUri(a));
    expect(parsed.seed.equals(a.seed)).toBe(true);
    expect(parsed.root).toBeNull();
  });

  it("carries the root key when given and keeps the code within 512 characters", () => {
    const root = Buffer.alloc(32, 7);
    const uri = formatJoinUri(generateJoinCode("a-very-long-name.subdomain.example.org:8443", root));
    expect(uri.length).toBeLessThanOrEqual(512);
    expect(parseJoinUri(uri).root?.equals(root)).toBe(true);
  });

  it("refuses an address that cannot be a node", () => {
    expect(() => generateJoinCode("192.0.2.1", null)).toThrow(JoinCodeError);
  });
});

describe("join code: parser edge cases", () => {
  const good = vectors.valid[0]!.uri;

  it("never throws anything but JoinCodeError and never echoes the input", () => {
    const inputs = ["", " ", "x".repeat(10_000), "trafficnetwork://join?", "trafficnetwork://join", "ünï€ode://join?v=1", "%74rafficnetwork://join?v=1", "\u0000", "trafficnetwork://join?v=1&n=%74n.example.org"];
    for (const input of inputs) {
      try {
        parseJoinUri(input);
        throw new Error("expected a rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(JoinCodeError);
        if (input.length >= 8) expect((err as Error).message).not.toContain(input.slice(0, 20));
      }
    }
  });

  it("accepts any order, any case of the scheme, and ignores unknown parameters", () => {
    const shuffled = "TrafficNetwork://join?c=3477B6GZ&x=1&r=oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8&k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&n=tn.example.org&v=1";
    expect(parseJoinUri(shuffled).node).toBe("tn.example.org");
  });

  it("rejects wrong scheme, wrong host, an over-long code and a duplicate known parameter", () => {
    expect(reasonOf(good.replace("trafficnetwork://", "https://"))).toBe("not_a_join_code");
    expect(reasonOf(good.replace("://join?", "://other?"))).toBe("not_a_join_code");
    expect(reasonOf(good + "&u=" + "a".repeat(600))).toBe("too_long");
    expect(reasonOf(good + "&v=1")).toBe("duplicate_parameter");
  });

  it("rejects bad nodes", () => {
    for (const n of ["localhost", "tn", "tn.example.org:0", "tn.example.org:65536", "tn.example.org:80a", "[::1]", "a..b", "https://tn.example.org", "tn.example.org/path", "tn.example.org%2f", "bücher.example.org"]) {
      expect(isValidNode(n)).toBe(false);
    }
    expect(isValidNode("xn--bcher-kva.example.org")).toBe(true);
    expect(isValidNode("tn.example.org:65535")).toBe(true);
  });

  it("rejects a non-canonical or malformed root key", () => {
    expect(reasonOf(good.replace("vr8&c=", "vr9&c="))).toBe("bad_root");
    expect(reasonOf(good.replace(/&r=[^&]*/, "&r=short"))).toBe("bad_root");
  });
});

describe("join code: node from the public address", () => {
  it("takes host and a non-default port of an https address", () => {
    expect(nodeFromAddress("https://trafficnetwork.link/")).toBe("trafficnetwork.link");
    expect(nodeFromAddress("https://Node.Example.org:8443")).toBe("node.example.org:8443");
    expect(nodeFromAddress("https://node.example.org:443")).toBe("node.example.org");
  });

  it("returns null for anything a join code cannot name", () => {
    for (const a of ["http://node.example.org", "https://192.0.2.1", "https://localhost", "https://node", "https://node.example.org/api", "https://u:p@node.example.org", "https://node.example.org/?x=1", "nonsense"]) {
      expect(nodeFromAddress(a)).toBeNull();
    }
  });
});
