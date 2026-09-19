import { describe, expect, it } from "vitest";
import { toCanonicalJson } from "../../src/modules/crypto/canonical.js";

describe("toCanonicalJson", () => {
  it("sorts object keys regardless of insertion order", () => {
    const a = toCanonicalJson({ b: 1, a: 2, c: 3 });
    const b = toCanonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("strips whitespace", () => {
    expect(toCanonicalJson({ a: 1 })).toBe('{"a":1}');
  });

  it("sorts nested object keys too", () => {
    const result = toCanonicalJson({ z: { y: 1, x: 2 }, a: 1 });
    expect(result).toBe('{"a":1,"z":{"x":2,"y":1}}');
  });

  it("preserves array order (only object keys are sorted)", () => {
    expect(toCanonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it("is stable for repeated calls on the same input", () => {
    const payload = { type: "auth", scopes: ["client", "bulk-import"], nested: { x: 1, y: 2 } };
    expect(toCanonicalJson(payload)).toBe(toCanonicalJson(payload));
  });
});
