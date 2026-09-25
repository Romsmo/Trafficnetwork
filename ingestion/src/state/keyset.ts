/**
 * The "already imported" set of dedup keys.
 *
 * At Bayern scale a plain `Set<string>` is fine (0.5 M keys). At Europe scale
 * (≈15 M keys) it is not: every key string costs ≈90 B on the V8 heap (≈1.4 GB
 * total), which is more than the rest of the run combined. The keys this
 * pipeline produces all have the same shape — `<kind>:<node|way|relation>/<id>`
 * with an optional `#<n>` suffix (normalize.ts) — so they fit losslessly into one
 * integer below 2^53 and live in an open-addressing hash table on a Float64Array
 * (8 B per slot, ≈0.27 GB for 15 M keys). Anything that doesn't match that shape
 * (a future source with its own key format) falls back to a plain string Set, so
 * correctness never depends on the shape.
 */

const KIND_CODE: Record<string, number> = { "speed-limit-segment": 0, "static-sign": 1, "fixed-speed-camera": 2 };
const OSM_TYPE_CODE: Record<string, number> = { node: 0, way: 1, relation: 2 };
const KEY_PATTERN = /^([a-z-]+):(node|way|relation)\/(\d{1,15})(?:#(\d{1,2}))?$/;

/** Suffix index 0..13 → 1..14 (0 = no suffix), so it fits in 4 bits. */
const MAX_SUFFIX_INDEX = 13;

/** Encodes a key into a positive safe integer, or undefined if it does not have the numeric shape. Exported for tests. */
export function encodeKey(key: string): number | undefined {
  const match = KEY_PATTERN.exec(key);
  if (!match) return undefined;
  const kind = KIND_CODE[match[1]!];
  if (kind === undefined) return undefined;
  const osmType = OSM_TYPE_CODE[match[2]!]!;
  const id = Number(match[3]);
  const suffix = match[4] === undefined ? 0 : Number(match[4]) + 1;
  if (match[4] !== undefined && Number(match[4]) > MAX_SUFFIX_INDEX) return undefined;
  // Round-trip guard: reject leading zeros ("way/007") so two different strings never share a code.
  if (String(id) !== match[3]) return undefined;
  const encoded = ((id * 4 + osmType) * 16 + suffix) * 4 + kind + 1; // +1: 0 marks an empty slot
  return Number.isSafeInteger(encoded) ? encoded : undefined;
}

const TWO_POW_32 = 4294967296;

function hashSlot(value: number, mask: number): number {
  const lo = value % TWO_POW_32 >>> 0;
  const hi = Math.floor(value / TWO_POW_32) >>> 0;
  let h = Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi + 0x7f4a7c15, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 13;
  return (h >>> 0) & mask;
}

export class KeySet {
  private table = new Float64Array(1 << 16);
  private count = 0;
  private readonly fallback = new Set<string>();

  get size(): number {
    return this.count + this.fallback.size;
  }

  has(key: string): boolean {
    const encoded = encodeKey(key);
    if (encoded === undefined) return this.fallback.has(key);
    const mask = this.table.length - 1;
    for (let slot = hashSlot(encoded, mask); ; slot = (slot + 1) & mask) {
      const stored = this.table[slot]!;
      if (stored === 0) return false;
      if (stored === encoded) return true;
    }
  }

  /** Adds `key`; returns false if it was already present. */
  add(key: string): boolean {
    const encoded = encodeKey(key);
    if (encoded === undefined) {
      const before = this.fallback.size;
      this.fallback.add(key);
      return this.fallback.size !== before;
    }
    if ((this.count + 1) * 10 > this.table.length * 6) this.grow();
    const mask = this.table.length - 1;
    for (let slot = hashSlot(encoded, mask); ; slot = (slot + 1) & mask) {
      const stored = this.table[slot]!;
      if (stored === 0) {
        this.table[slot] = encoded;
        this.count++;
        return true;
      }
      if (stored === encoded) return false;
    }
  }

  private grow(): void {
    const old = this.table;
    this.table = new Float64Array(old.length * 2);
    const mask = this.table.length - 1;
    for (let i = 0; i < old.length; i++) {
      const value = old[i]!;
      if (value === 0) continue;
      let slot = hashSlot(value, mask);
      while (this.table[slot] !== 0) slot = (slot + 1) & mask;
      this.table[slot] = value;
    }
  }
}
