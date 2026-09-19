import canonicalize from "canonicalize";

/**
 * RFC 8785 (JSON Canonicalization Scheme) — the deterministic byte
 * representation everything in the federation protocol signs and hashes
 * over, so the same logical payload always produces the same signature
 * regardless of which server/language serialized it first. See
 * docs/threat-model.md and the F-S0 plan's decision 3 for why RFC 8785
 * specifically (not a hand-rolled canonicalization).
 */
export function toCanonicalJson(payload: unknown): string {
  const result = canonicalize(payload);
  if (result === undefined) {
    // canonicalize() returns undefined for inputs with no JSON representation
    // (e.g. a bare `undefined` or a function) — never expected for the plain
    // data objects this project signs.
    throw new Error("toCanonicalJson: payload has no canonical JSON representation");
  }
  return result;
}

export function toCanonicalBytes(payload: unknown): Buffer {
  return Buffer.from(toCanonicalJson(payload), "utf8");
}
