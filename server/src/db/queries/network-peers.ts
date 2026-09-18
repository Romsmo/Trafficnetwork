import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";

export interface NetworkPeerApi {
  nodeId: string;
  publicKey: string;
  address: string;
  discoveredVia: "seed" | "gossip" | "join";
  joinedAt: string;
  lastSeenAt: string | null;
}

interface Row extends Record<string, unknown> {
  node_id: string;
  public_key: string;
  address: string;
  discovered_via: "seed" | "gossip" | "join";
  joined_at: string;
  last_seen_at: string | null;
  last_pulled_sequence: number | null;
}

function toApi(row: Row): NetworkPeerApi {
  return {
    nodeId: row.node_id,
    publicKey: row.public_key,
    address: row.address,
    discoveredVia: row.discovered_via,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
  };
}

export interface NetworkPeerRow extends NetworkPeerApi {
  lastPulledSequence: number | null;
}

function toRow(row: Row): NetworkPeerRow {
  return { ...toApi(row), lastPulledSequence: row.last_pulled_sequence };
}

/** Public-facing shape (GET /v1/federation/peers) — omits the internal per-peer pull cursor. */
export async function listPeers(db: Queryable): Promise<NetworkPeerApi[]> {
  const rows = await db.execute<Row>(sql`
    select node_id, public_key, address, discovered_via, joined_at, last_seen_at, last_pulled_sequence
    from network_peers order by joined_at asc
  `);
  return rows.map(toApi);
}

/** Internal use only (modules/federation/workers.ts's anti-entropy pull) — includes lastPulledSequence. */
export async function listPeersWithCursor(db: Queryable): Promise<NetworkPeerRow[]> {
  const rows = await db.execute<Row>(sql`
    select node_id, public_key, address, discovered_via, joined_at, last_seen_at, last_pulled_sequence
    from network_peers order by joined_at asc
  `);
  return rows.map(toRow);
}

export async function findPeerByNodeId(db: Queryable, nodeId: string): Promise<NetworkPeerRow | null> {
  const rows = await db.execute<Row>(sql`
    select node_id, public_key, address, discovered_via, joined_at, last_seen_at, last_pulled_sequence
    from network_peers where node_id = ${nodeId}
  `);
  const row = rows[0];
  return row ? toRow(row) : null;
}

/**
 * Upserts a peer by nodeId. `address`/`publicKey` are refreshed on conflict
 * (a peer can move address; a re-join with a rotated key replaces the old
 * one — see modules/federation/routes.ts's join handler), but
 * `discoveredVia`/`joinedAt` are only ever set on first insert, and
 * `lastSeenAt` is bumped to now() on every upsert since any successful
 * join/heartbeat/gossip-learn is itself evidence of reachability.
 */
export async function upsertPeer(
  db: Queryable,
  input: { nodeId: string; publicKey: string; address: string; discoveredVia: "seed" | "gossip" | "join" },
): Promise<void> {
  await db.execute(sql`
    insert into network_peers (node_id, public_key, address, discovered_via, last_seen_at)
    values (${input.nodeId}, ${input.publicKey}, ${input.address}, ${input.discoveredVia}::peer_discovery_source, now())
    on conflict (node_id) do update set
      public_key = excluded.public_key,
      address = excluded.address,
      last_seen_at = now()
  `);
}

export async function setPeerLastPulledSequence(db: Queryable, nodeId: string, sequence: number): Promise<void> {
  await db.execute(sql`update network_peers set last_pulled_sequence = ${sequence} where node_id = ${nodeId}`);
}
