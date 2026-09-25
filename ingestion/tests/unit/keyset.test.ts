import { describe, expect, it } from "vitest";
import { encodeKey, KeySet } from "../../src/state/keyset.js";

describe("encodeKey", () => {
  it("encodes the pipeline's key shapes and keeps different keys apart", () => {
    const keys = [
      "speed-limit-segment:way/1",
      "static-sign:way/1",
      "fixed-speed-camera:node/1",
      "static-sign:node/1",
      "static-sign:node/1#0",
      "static-sign:node/1#1",
      "static-sign:node/12345678901", // node ids are > 2^32 in current OSM data
    ];
    const encoded = keys.map((key) => encodeKey(key));
    expect(encoded.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0)).toBe(true);
    expect(new Set(encoded).size).toBe(keys.length);
  });

  it("returns undefined for anything that is not the numeric shape", () => {
    expect(encodeKey("other-source:thing/abc")).toBeUndefined();
    expect(encodeKey("speed-limit-segment:way/007")).toBeUndefined(); // leading zero would alias way/7
    expect(encodeKey("static-sign:node/1#99")).toBeUndefined();
    expect(encodeKey("static-sign:node/99999999999999")).toBeUndefined(); // would overflow 2^53 once packed
  });
});

describe("KeySet", () => {
  it("behaves like a Set for adds, duplicates and lookups, across many growth steps", () => {
    const set = new KeySet();
    const reference = new Set<string>();
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 200_000; i++) {
      const kind = ["speed-limit-segment", "static-sign", "fixed-speed-camera"][next() % 3]!;
      const type = ["node", "way", "relation"][next() % 3]!;
      const id = next() * 7 + (next() % 5) * 4_000_000_000;
      const key = `${kind}:${type}/${id}${next() % 10 === 0 ? `#${next() % 4}` : ""}`;
      expect(set.add(key)).toBe(!reference.has(key));
      reference.add(key);
    }
    expect(set.size).toBe(reference.size);
    for (const key of reference) expect(set.has(key)).toBe(true);
    expect(set.has("speed-limit-segment:way/999999999999")).toBe(false);
  });

  it("falls back to a string set for keys without the numeric shape, without ever confusing them", () => {
    const set = new KeySet();
    expect(set.add("mobilithek:dataset-7/row-3")).toBe(true);
    expect(set.add("mobilithek:dataset-7/row-3")).toBe(false);
    expect(set.has("mobilithek:dataset-7/row-3")).toBe(true);
    expect(set.has("mobilithek:dataset-7/row-4")).toBe(false);
    expect(set.size).toBe(1);
  });

  it("starts empty", () => {
    const set = new KeySet();
    expect(set.size).toBe(0);
    expect(set.has("static-sign:node/1")).toBe(false);
  });
});
