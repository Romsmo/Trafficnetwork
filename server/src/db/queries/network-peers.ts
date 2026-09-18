import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";

export interface NetworkPeerApi {
  nodeId: string;
  publicKey: string;
  address: string;
  discoveredVia: "seed" | "gossip" | "join";
  joinedAt: string;
  lastSeenAt: string | null;
  successfulHealthChecks: number;
  consecutiveHealthCheckFailures: number;
  invalidSignatureCount: number;
  lastKnownVersion: string | null;
}

interface Row extends Record<string, unknown> {
  node_id: string;
  public_key: string;
  address: string;
  discovered_via: "seed" | "gossip" | "join";
  joined_at: string;
  last_seen_at: string | null;
  last_pulled_sequence: number | null;
  successful_health_checks: number;
  consecutive_health_check_failures: number;
  invalid_signature_count: number;
  last_known_version: string | null;
}

const SELECT_COLUMNS = sql`
  node_id, public_key, address, discovered_via, joined_at, last_seen_at, last_pulled_sequence,
  successful_health_checks, consecutive_health_check_failures, invalid_signature_count, last_known_version
`;

function toApi(row: Row): NetworkPeerApi {
  return {
    nodeId: row.node_id,
    publicKey: row.public_key,
    address: row.address,
    discoveredVia: row.discovered_via,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
    successfulHealthChecks: row.successful_health_checks,
    consecutiveHealthCheckFailures: row.consecutive_health_check_failures,
    invalidSignatureCount: row.invalid_signature_count,
    lastKnownVersion: row.last_known_version,
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
  const rows = await db.execute<Row>(sql`select ${SELECT_COLUMNS} from network_peers order by joined_at asc`);
  return rows.map(toApi);
}

/** Internal use only (modules/federation/workers.ts's anti-entropy pull) — includes lastPulledSequence. */
export async function listPeersWithCursor(db: Queryable): Promise<NetworkPeerRow[]> {
  const rows = await db.execute<Row>(sql`select ${SELECT_COLUMNS} from network_peers order by joined_at asc`);
  return rows.map(toRow);
}

export async function findPeerByNodeId(db: Queryable, nodeId: string): Promise<NetworkPeerRow | null> {
  const rows = await db.execute<Row>(sql`select ${SELECT_COLUMNS} from network_peers where node_id = ${nodeId}`);
  const row = rows[0];
  return row ? toRow(row) : null;
}

/**
 * Upserts a peer by nodeId. `address`/`publicKey` are refreshed on conflict
 * (a peer can move address; a re-join with a rotated key replaces the old
 * one — see modules/federation/routes.ts's join handler), but
 * `discoveredVia`/`joinedAt` are only ever set on first insert, and
 * `lastSeenAt` is bumped to now() on every upsert since any successful
 * join/heartbeat/gossip-learn is itself evidence of reachability. Reputation
 * counters (F-S4) are left untouched on conflict — those only ever change
 * via the record* functions below, from this server's own active checks.
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

/**
 * Called after this server itself successfully reaches a peer (a heartbeat
 * send, or an anti-entropy pull that got a response at all, empty page or
 * not) — see modules/federation/workers.ts. `version` is optional since not
 * every kind of successful contact carries one (an anti-entropy pull
 * response doesn't).
 */
export async function recordHealthCheckSuccess(db: Queryable, nodeId: string, version?: string): Promise<void> {
  await db.execute(sql`
    update network_peers
    set successful_health_checks = successful_health_checks + 1,
        consecutive_health_check_failures = 0,
        last_seen_at = now(),
        last_known_version = ${version ?? sql`last_known_version`}
    where node_id = ${nodeId}
  `);
}

export async function recordHealthCheckFailure(db: Queryable, nodeId: string): Promise<void> {
  await db.execute(sql`
    update network_peers set consecutive_health_check_failures = consecutive_health_check_failures + 1
    where node_id = ${nodeId}
  `);
}

/**
 * Records what version a peer self-reports in a heartbeat *we received*
 * (modules/federation/routes.ts's inbound heartbeat handler) — plain
 * metadata, not a health-check success/failure signal (that only comes from
 * *this* server's own outbound checks — see recordHealthCheckSuccess above).
 */
export async function recordPeerVersion(db: Queryable, nodeId: string, version: string): Promise<void> {
  await db.execute(sql`update network_peers set last_known_version = ${version} where node_id = ${nodeId}`);
}

/**
 * A push from this peer contained an event whose signature didn't verify —
 * see modules/federation/routes.ts's push handler and
 * modules/federation/reputation.ts for how this feeds tier demotion.
 */
export async function recordInvalidSignature(db: Queryable, nodeId: string): Promise<void> {
  await db.execute(sql`
    update network_peers set invalid_signature_count = invalid_signature_count + 1
    where node_id = ${nodeId}
  `);
}
