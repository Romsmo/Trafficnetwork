import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { peerDiscoverySourceEnum } from "./enums.js";

/**
 * Federation peer directory (F-S3): every other server this node has joined
 * with or learned about via gossip (a joined peer's own peer list, returned
 * alongside its join response — see modules/federation/routes.ts). This is
 * *not* the reputation-scored, network-wide directory planned for F-S4
 * (`GET /v1/network/nodes`, per docs/status.md's coordination note) — that's
 * a filtered/scored view assembled from data like this table, still to come.
 * This table is just "who do I currently know how to reach."
 */
export const networkPeers = pgTable("network_peers", {
  nodeId: text("node_id").primaryKey(),
  publicKey: text("public_key").notNull(),
  address: text("address").notNull(),
  discoveredVia: peerDiscoverySourceEnum("discovered_via").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  // Local-only bookkeeping for the anti-entropy pull worker: the highest
  // event_log.sequence this server has already pulled *from this specific
  // peer*. Sequence numbers aren't comparable across servers (each is a
  // per-process bigserial — see db/schema/events.ts), so this is never sent
  // to or compared against any other server, only used as "where did I leave
  // off asking this one peer" — a fresh, unrelated bookmark per peer.
  lastPulledSequence: integer("last_pulled_sequence"),
});
