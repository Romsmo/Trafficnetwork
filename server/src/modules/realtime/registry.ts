import type { WebSocket } from "ws";

/**
 * In-process only — Map<tile, Set<connection>> plus a set of every connection for
 * global (regionTile-less) events. Consistent with the Phase-1 single-instance
 * scope for WebSocket (docs/prompt-phase1-server.md section 2.2 decision):
 * horizontal scaling would need this registry backed by something shared across
 * instances (Postgres LISTEN/NOTIFY or a pub/sub layer), which is explicitly out
 * of scope here.
 */
export class SubscriptionRegistry {
  private readonly byTile = new Map<string, Set<WebSocket>>();
  private readonly tilesByConnection = new Map<WebSocket, Set<string>>();
  private readonly allConnections = new Set<WebSocket>();

  addConnection(ws: WebSocket): void {
    this.allConnections.add(ws);
    this.tilesByConnection.set(ws, new Set());
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

  unsubscribe(ws: WebSocket, tiles: string[]): void {
    const set = this.tilesByConnection.get(ws);
    for (const tile of tiles) {
      set?.delete(tile);
      const conns = this.byTile.get(tile);
      conns?.delete(ws);
      if (conns && conns.size === 0) this.byTile.delete(tile);
    }
  }

  /** null tile means "global" (e.g. static-data events, which have no regionTile). */
  connectionsFor(tile: string | null): ReadonlySet<WebSocket> {
    if (tile === null) return this.allConnections;
    return this.byTile.get(tile) ?? new Set();
  }
}
