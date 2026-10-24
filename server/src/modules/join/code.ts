import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { isIP } from "node:net";

/**
 * Join-Code v1 (docs/join-code.md): the string an app scans or pastes to learn a node's address, its app key and, optionally,
 * the public network root key. Pure functions only - no I/O, no logging. Nothing here may ever put a seed, a secret or a whole
 * code into an error message: parse errors carry a category, never the input.
 */

export const JOIN_SCHEME = "trafficnetwork";
export const JOIN_VERSION = 1;
export const JOIN_MAX_LENGTH = 512;
const HKDF_SALT = "trafficnetwork-join-v1";
const CHECK_DOMAIN = "tn-join-v1/check";
const KEY_LENGTH = 43;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const LABEL = /^[a-z0-9-]{1,63}$/;
const CHECK = /^[A-Z2-7]{8}$/;

export type JoinParseReason =
  | "too_long"
  | "not_a_join_code"
  | "duplicate_parameter"
  | "missing_parameter"
  | "newer_version"
  | "bad_version"
  | "bad_node"
  | "bad_seed"
  | "bad_root"
  | "bad_check";

export class JoinCodeError extends Error {
  readonly reason: JoinParseReason;
  constructor(reason: JoinParseReason) {
    super(`invalid join code: ${reason}`);
    this.reason = reason;
  }
}

export interface JoinCode {
  node: string;
  /** 32 bytes. Secret material: never log, never put in an error. */
  seed: Buffer;
  /** 32 bytes, the public Ed25519 root key; null when the code carries none. */
  root: Buffer | null;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, upper case, no padding. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Decodes a 43-character canonical base64url string into 32 bytes, or null when it is not exactly that. */
export function decodeKey(text: string): Buffer | null {
  if (text.length !== KEY_LENGTH || !BASE64URL.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  if (bytes.length !== 32 || b64url(bytes) !== text) return null;
  return bytes;
}

/** A.2 for `n`: lower-case host with at least one dot, optional port 1-65535, no IP address, no localhost. */
export function isValidNode(node: string): boolean {
  if (node.length === 0 || node.length > 253 + 6) return false;
  const colon = node.lastIndexOf(":");
  let host = node;
  if (colon !== -1) {
    host = node.slice(0, colon);
    const port = node.slice(colon + 1);
    if (!/^[0-9]{1,5}$/.test(port)) return false;
    const n = Number(port);
    if (n < 1 || n > 65535) return false;
  }
  if (host.length === 0 || host.length > 253) return false;
  if (isIP(host) !== 0) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  return labels.every((l) => LABEL.test(l));
}

/** A.4. */
export function computeCheck(node: string, seed: Uint8Array): string {
  const digest = createHash("sha256")
    .update(Buffer.concat([Buffer.from(CHECK_DOMAIN, "ascii"), Buffer.from([0]), Buffer.from(node, "ascii"), Buffer.from([0]), seed]))
    .digest();
  return base32(digest.subarray(0, 5));
}

/** A.5: five groups of four characters, for display and comparison only. */
export function rootFingerprint(root: Uint8Array): string {
  const text = base32(createHash("sha256").update(root).digest()).slice(0, 20);
  return text.match(/.{4}/g)!.join("-");
}

export interface DerivedCredentials {
  clientId: string;
  /** The app key's secret. Secret material. */
  clientSecret: string;
}

/** A.3: HKDF-SHA256 (RFC 5869) with the fixed salt; the node's id and secret for this seed. */
export function deriveCredentials(seed: Uint8Array): DerivedCredentials {
  const expand = (info: string, length: number) => Buffer.from(hkdfSync("sha256", seed, HKDF_SALT, info, length));
  return {
    clientId: `join-${expand("id", 8).toString("hex")}`,
    clientSecret: b64url(expand("secret", 32)),
  };
}

/** A fresh code for `node` (and `root`, when the node knows one): 32 CSPRNG bytes as the seed. */
export function generateJoinCode(node: string, root: Buffer | null): JoinCode {
  if (!isValidNode(node)) throw new JoinCodeError("bad_node");
  if (root && root.length !== 32) throw new JoinCodeError("bad_root");
  return { node, seed: randomBytes(32), root };
}

/** The shared string (QR content and text form): parameters in the order of A.2. */
export function formatJoinUri(code: JoinCode): string {
  const parts = [`v=${JOIN_VERSION}`, `n=${code.node}`, `k=${b64url(code.seed)}`];
  if (code.root) parts.push(`r=${b64url(code.root)}`);
  parts.push(`c=${computeCheck(code.node, code.seed)}`);
  return `${JOIN_SCHEME}://join?${parts.join("&")}`;
}

const KNOWN = new Set(["v", "n", "k", "r", "c"]);

/**
 * A.6. Strict: never throws anything but JoinCodeError, never echoes the input. Query values are taken literally (a join code
 * contains no characters that need percent-encoding; a percent sign anywhere makes the value fail its own alphabet check).
 */
export function parseJoinUri(input: string): JoinCode {
  if (typeof input !== "string") throw new JoinCodeError("not_a_join_code");
  if (input.length > JOIN_MAX_LENGTH) throw new JoinCodeError("too_long");
  const prefix = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/join\?/.exec(input);
  if (!prefix || prefix[1]!.toLowerCase() !== JOIN_SCHEME) throw new JoinCodeError("not_a_join_code");
  const query = input.slice(prefix[0].length);

  const values = new Map<string, string>();
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : pair.slice(eq + 1);
    if (!KNOWN.has(name)) continue; // forward compatibility: unknown parameters are ignored
    if (values.has(name)) throw new JoinCodeError("duplicate_parameter");
    values.set(name, value);
  }

  const v = values.get("v");
  const n = values.get("n");
  const k = values.get("k");
  const c = values.get("c");
  if (v === undefined || n === undefined || k === undefined || c === undefined) throw new JoinCodeError("missing_parameter");
  if (!/^[0-9]{1,6}$/.test(v)) throw new JoinCodeError("bad_version");
  if (Number(v) > JOIN_VERSION) throw new JoinCodeError("newer_version");
  if (Number(v) !== JOIN_VERSION) throw new JoinCodeError("bad_version");
  if (!isValidNode(n)) throw new JoinCodeError("bad_node");
  const seed = decodeKey(k);
  if (!seed) throw new JoinCodeError("bad_seed");
  let root: Buffer | null = null;
  const r = values.get("r");
  if (r !== undefined) {
    root = decodeKey(r);
    if (!root) throw new JoinCodeError("bad_root");
  }
  if (!CHECK.test(c) || c !== computeCheck(n, seed)) throw new JoinCodeError("bad_check");
  return { node: n, seed, root };
}

/**
 * The node part (`n`) for this node's public address: host (and a non-default port) of an https:// URL, or null when the
 * address cannot be a join-code node (not https, a path, an IP address, localhost, no dot).
 */
export function nodeFromAddress(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const node = url.host.toLowerCase();
  return isValidNode(node) ? node : null;
}
