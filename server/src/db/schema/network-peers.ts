import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { peerDiscoverySourceEnum } from "./enums.js";

/**
 * Federation peer directory (F-S3): every other server this node has joined
 * with or learned about via gossip (a joined peer's own peer list, returned
 * alongside its join response — see modules/federation/routes.ts). Also
 * carries the raw reputation signals (F-S4) this server has itself measured
 * about each peer — `modules/federation/reputation.ts` derives a tier from
 * these on read, rather than storing a tier value that could drift out of
 * sync with the signals it's supposed to summarize.
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
  // Same idea, for the separate speed-limit-correction vote stream
  // (GET /v1/federation/speed-limit-votes — add-on K-A): the highest
  // speed_limit_correction_votes.seq already pulled from this peer.
  lastPulledVotesSequence: integer("last_pulled_votes_sequence"),
  // Reputation signals (F-S4, modules/federation/reputation.ts), all
  // measured by *this* server actively checking on the peer (heartbeat send,
  // anti-entropy pull) or observing its behavior (a push it sent) — never
  // self-reported by the peer itself, per the F-S0 plan's decision 5
  // ("gemessene Latenz/Fehlerrate hält sie über Zeit ehrlich").
  successfulHealthChecks: integer("successful_health_checks").notNull().default(0),
  consecutiveHealthCheckFailures: integer("consecutive_health_check_failures").notNull().default(0),
  // Cumulative, never reset — per the plan, "jede ungültige Signatur von S
  // ist ein starkes Negativsignal": one bad signature is enough to matter,
  // not something that should quietly age out.
  invalidSignatureCount: integer("invalid_signature_count").notNull().default(0),
  lastKnownVersion: text("last_known_version"),
});
