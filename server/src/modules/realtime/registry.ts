import type { WebSocket } from "ws";
import { CLOSED_GATE, type CameraGate } from "../cameras/policy/events.js";

/**
 * In-process only — Map<tile, Set<connection>> plus a set of every connection for
 * global (regionTile-less) events. Consistent with the Phase-1 single-instance
 * scope for WebSocket (docs/prompt-phase1-server.md section 2.2 decision):
 * horizontal scaling would need this registry backed by something shared across
 * instances (Postgres LISTEN/NOTIFY or a pub/sub layer), which is explicitly out
 * of scope here.
 */
export class SubscriptionRegistry {
  /**
   * `cameraGate` is the camera policy as it applies right now (modules/cameras/policy/). A camera event is pushed as it is
   * at level `full`, as a zone event at level `zones` and not at all otherwise: the REST/sync endpoints already work that
   * way, and a WebSocket must not be the back door. Without a gate (unit tests) no camera event is ever pushed.
   */
  constructor(readonly cameraGate: CameraGate = CLOSED_GATE) {}

  private readonly byTile = new Map<string, Set<WebSocket>>();
  private readonly tilesByConnection = new Map<WebSocket, Set<string>>();
  private readonly allConnections = new Set<WebSocket>();
  /** Connections authenticated with an anonymous web-session token: they get events without reporter ids. */
  private readonly webConnections = new WeakSet<WebSocket>();

  addConnection(ws: WebSocket, opts: { webSession?: boolean } = {}): void {
    this.allConnections.add(ws);
    this.tilesByConnection.set(ws, new Set());
    if (opts.webSession) this.webConnections.add(ws);
  }

  isWebSession(ws: WebSocket): boolean {
    return this.webConnections.has(ws);
  }

  removeConnection(ws: WebSocket): void {
    const tiles = this.tilesByConnection.get(ws);
    if (tiles) {
      for (const tile of tiles) this.byTile.get(tile)?.delete(ws);
    }
    this.tilesByConnection.delete(ws);
    this.allConnections.delete(ws);
  }

  subscribe(ws: WebSocket, tiles: string[]): void {
    const set = this.tilesByConnection.get(ws);
    if (!set) return; // connection not registered (shouldn't happen — see plugin.ts)
    for (const tile of tiles) {
      set.add(tile);
      let conns = this.byTile.get(tile);
      if (!conns) {
        conns = new Set();
        this.byTile.set(tile, conns);
      }
      conns.add(ws);
    }
  }

  /** How many distinct tiles this connection would be subscribed to after also subscribing to `extra`. */
  tileCountWith(ws: WebSocket, extra: string[]): number {
    const union = new Set(this.tilesByConnection.get(ws) ?? []);
    for (const tile of extra) union.add(tile);
    return union.size;
  }

  unsubscribe(ws: WebSocket, tiles: string[]): void {
    const set = this.tilesByConnection.get(ws);
    for (const tile of tiles) {
      set?.delete(tile);
      const conns = this.byTile.get(tile);
      conns?.delete(ws);
      if (conns && conns.size === 0) this.byTile.delete(tile);
    }
  }

  /** Every connection subscribed to at least one of these tiles (once each). */
  connectionsForTiles(tiles: readonly string[]): Set<WebSocket> {
    const out = new Set<WebSocket>();
    for (const tile of tiles) for (const ws of this.byTile.get(tile) ?? []) out.add(ws);
    return out;
  }

  /** null tile means "global" (e.g. static-data events, which have no regionTile). */
  connectionsFor(tile: string | null): ReadonlySet<WebSocket> {
    if (tile === null) return this.allConnections;
    return this.byTile.get(tile) ?? new Set();
  }
}
