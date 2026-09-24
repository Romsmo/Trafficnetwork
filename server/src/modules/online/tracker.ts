import { createHmac, randomBytes } from "node:crypto";
import type { TokenClaims } from "../auth/jwt.js";

/**
 * A peer's reported figure above this is not a plausible head count for one
 * node — it is ignored rather than clamped (a claim that far out of range says
 * nothing useful, clamping it would still let a liar move the total).
 */
export const MAX_PLAUSIBLE_PEER_ONLINE = 1_000_000;

/** Distinct peers whose figure is remembered; only ever peers already in network_peers, so this is a safety net, not a working limit. */
const MAX_PEER_REPORTS = 10_000;

/** How often the activity map is swept as a side effect of recording (a read always sweeps). */
const PRUNE_INTERVAL_MS = 15_000;

export interface OnlineTrackerOptions {
  /** false: nothing is tracked and every count is 0 (ONLINE_COUNTER_ENABLED=false). */
  enabled: boolean;
  windowSeconds: number;
  maxTracked: number;
  peerStaleSeconds: number;
  /** Monotonic milliseconds. Injectable for tests; the default is performance.now(). */
  now?: () => number;
}

/**
 * Counts how many distinct clients are online at this node — numbers only.
 *
 * What is (and is not) kept, all in process memory, none of it ever written
 * to disk, the database or a log line:
 *  - a salted hash of each online client's token subject (the salt is random
 *    per process and never leaves it), so the same device connecting twice, or
 *    connecting and also polling, is counted once. Not the subject itself, no
 *    IP address, no position, no timestamp of anything but "last seen".
 *  - the last figure each known peer reported in a signed heartbeat.
 *
 * "Online" means: has an authenticated WebSocket open right now, OR made a sync
 * or write request within the window (see activity.ts for which requests), so
 * a client that only polls is not invisible. Only clients with the `client`
 * scope count — a bulk-import or device-registration service token is not a
 * user.
 */
export class OnlineTracker {
  private readonly enabled: boolean;
  private readonly windowMs: number;
  private readonly maxTracked: number;
  private readonly peerStaleMs: number;
  private readonly clock: () => number;
  private readonly salt = randomBytes(32);

  /** key -> number of open authenticated sockets for that client */
  private readonly socketRefs = new Map<string, number>();
  private readonly socketKeys = new Map<object, string>();
  /**
   * key -> last activity. Insertion order is ascending by time because a
   * refresh deletes and re-inserts, so expiry only ever walks the front.
   */
  private readonly activity = new Map<string, number>();
  private lastPrune = 0;

  private readonly peerReports = new Map<string, { count: number; at: number }>();

  constructor(options: OnlineTrackerOptions) {
    this.enabled = options.enabled;
    this.windowMs = options.windowSeconds * 1000;
    this.maxTracked = options.maxTracked;
    this.peerStaleMs = options.peerStaleSeconds * 1000;
    this.clock = options.now ?? (() => performance.now());
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get windowSeconds(): number {
    return this.windowMs / 1000;
  }

  /** An authenticated WebSocket opened (called again on the same socket if it re-authenticates). */
  wsConnected(socket: object, claims: TokenClaims): void {
    if (!this.enabled) return;
    this.wsDisconnected(socket);
    if (!isUser(claims)) return;
    const key = this.keyFor(claims.sub);
    this.socketKeys.set(socket, key);
    this.socketRefs.set(key, (this.socketRefs.get(key) ?? 0) + 1);
  }

  wsDisconnected(socket: object): void {
    const key = this.socketKeys.get(socket);
    if (key === undefined) return;
    this.socketKeys.delete(socket);
    const refs = (this.socketRefs.get(key) ?? 1) - 1;
    if (refs <= 0) this.socketRefs.delete(key);
    else this.socketRefs.set(key, refs);
  }

  /** An authenticated sync or write request succeeded. */
  recordActivity(claims: TokenClaims): void {
    if (!this.enabled || this.windowMs === 0 || !isUser(claims)) return;
    const now = this.clock();
    if (now - this.lastPrune >= PRUNE_INTERVAL_MS) this.prune(now);
    const key = this.keyFor(claims.sub);
    // Full: keep counting those already known, don't remember new ones — a
    // bounded (under-)count beats unbounded memory.
    if (!this.activity.has(key) && this.activity.size >= this.maxTracked) return;
    this.activity.delete(key);
    this.activity.set(key, now);
  }

  /** Distinct clients online at this node right now. */
  nodeCount(): number {
    if (!this.enabled) return 0;
    this.prune(this.clock());
    let count = this.socketRefs.size;
    for (const key of this.activity.keys()) {
      if (!this.socketRefs.has(key)) count += 1;
    }
    return count;
  }

  /**
   * Remembers what a known peer reported about itself in a signed heartbeat.
   * Returns whether the figure was usable — anything that is not a plausible
   * head count is ignored (the caller still accepts the heartbeat itself).
   */
  recordPeerReport(nodeId: string, count: unknown): boolean {
    if (!this.enabled) return false;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_PLAUSIBLE_PEER_ONLINE) return false;
    this.peerReports.delete(nodeId);
    this.peerReports.set(nodeId, { count, at: this.clock() });
    if (this.peerReports.size > MAX_PEER_REPORTS) {
      const oldest = this.peerReports.keys().next().value;
      if (oldest !== undefined) this.peerReports.delete(oldest);
    }
    return true;
  }

  /** The peer's last reported figure, or undefined if it never reported or its heartbeat is stale. */
  peerReport(nodeId: string): number | undefined {
    const report = this.peerReports.get(nodeId);
    if (!report) return undefined;
    if (this.clock() - report.at > this.peerStaleMs) {
      this.peerReports.delete(nodeId);
      return undefined;
    }
    return report.count;
  }

  private prune(now: number): void {
    this.lastPrune = now;
    const cutoff = now - this.windowMs;
    for (const [key, at] of this.activity) {
      if (at >= cutoff) break;
      this.activity.delete(key);
    }
  }

  private keyFor(subject: string): string {
    return createHmac("sha256", this.salt).update(subject).digest("base64url").slice(0, 16);
  }
}

function isUser(claims: TokenClaims): boolean {
  return claims.scopes.includes("client");
}
