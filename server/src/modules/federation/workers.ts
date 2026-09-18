import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import type { NodeIdentity } from "../network/node-identity.js";
import type { SubscriptionRegistry } from "../realtime/registry.js";
import { publishEvent } from "../realtime/publisher.js";
import { signEnvelope } from "../crypto/envelope.js";
import {
  listPeers,
  listPeersWithCursor,
  recordHealthCheckFailure,
  recordHealthCheckSuccess,
  setPeerLastPulledSequence,
  upsertPeer,
} from "../../db/queries/network-peers.js";
import { requestJoin, sendHeartbeat, pullEvents } from "./http-client.js";
import { ingestDeviceCreateEvent } from "./ingest.js";
import { getCapacityHint } from "./load.js";
import { FEDERATION_PROTOCOL_VERSION, type HeartbeatPayload, type JoinRequestPayload } from "./protocol.js";

/**
 * Federation background work (F-S3): joining configured seeds on startup,
 * periodic signed heartbeats to known peers, and periodic anti-entropy pull.
 * Mirrors the existing modules/expiry/{worker,retention}.ts pattern — plain
 * setInterval, .unref()'d so it never keeps the process alive on its own,
 * every failure caught and logged rather than thrown (an unreachable peer is
 * routine in an open federation, never a reason to crash this server).
 * Only ever constructed when env.FEDERATION_ENABLED — see src/server.ts.
 */

export interface FederationWorkersHandle {
  stop: () => void;
}

interface Deps {
  db: Database["db"];
  env: Env;
  nodeIdentity: NodeIdentity;
  realtime: SubscriptionRegistry;
  log: FastifyBaseLogger;
}

async function joinSeeds(deps: Deps): Promise<void> {
  const seeds = (deps.env.FEDERATION_SEEDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const seedUrl of seeds) {
    const payload: JoinRequestPayload = {
      nodeId: deps.nodeIdentity.nodeId,
      publicKey: deps.nodeIdentity.publicKeyRaw,
      // FEDERATION_PUBLIC_ADDRESS is required whenever FEDERATION_ENABLED is
      // true (see config/env.ts's refine) — this only runs when it's set.
      address: deps.env.FEDERATION_PUBLIC_ADDRESS!,
      requestedAt: new Date().toISOString(),
    };
    const envelope = signEnvelope(payload, deps.nodeIdentity);

    try {
      const response = await requestJoin(seedUrl, envelope, deps.env.FEDERATION_PEER_TIMEOUT_MS);
      await upsertPeer(deps.db, { nodeId: response.self.nodeId, publicKey: response.self.publicKey, address: seedUrl, discoveredVia: "seed" });
      for (const peer of response.peers) {
        if (peer.nodeId === deps.nodeIdentity.nodeId || peer.nodeId === response.self.nodeId) continue;
        await upsertPeer(deps.db, { nodeId: peer.nodeId, publicKey: peer.publicKey, address: peer.address, discoveredVia: "gossip" });
      }
      deps.log.info({ seedUrl, learnedPeers: response.peers.length }, "federation: joined seed");
    } catch (err) {
      deps.log.warn({ err, seedUrl }, "federation: failed to join seed (will retry on next heartbeat/anti-entropy cycle for already-known peers)");
    }
  }
}

async function sendHeartbeats(deps: Deps): Promise<void> {
  const peers = await listPeers(deps.db);
  for (const peer of peers) {
    const payload: HeartbeatPayload = {
      nodeId: deps.nodeIdentity.nodeId,
      address: deps.env.FEDERATION_PUBLIC_ADDRESS!,
      version: FEDERATION_PROTOCOL_VERSION,
      // Self-reported, like any heartbeat field — a receiving peer's own
      // reputation scoring (modules/federation/reputation.ts) never trusts
      // this on its own, only what it measures itself (see that module's
      // header comment). Still useful as an early, honest-by-default signal
      // for a well-behaved peer to back off before this server starts
      // actually returning 503s.
      capacityHint: getCapacityHint(deps.env),
      timestamp: new Date().toISOString(),
    };
    const envelope = signEnvelope(payload, deps.nodeIdentity);
    try {
      await sendHeartbeat(peer.address, envelope, deps.env.FEDERATION_PEER_TIMEOUT_MS);
      // A successful send is itself evidence this peer is reachable — see
      // db/queries/network-peers.ts's upsertPeer comment.
      await upsertPeer(deps.db, { nodeId: peer.nodeId, publicKey: peer.publicKey, address: peer.address, discoveredVia: peer.discoveredVia });
      await recordHealthCheckSuccess(deps.db, peer.nodeId);
    } catch (err) {
      deps.log.warn({ err, peer: peer.nodeId }, "federation: heartbeat to peer failed");
      await recordHealthCheckFailure(deps.db, peer.nodeId);
    }
  }
}

async function pullFromPeers(deps: Deps): Promise<void> {
  const peers = await listPeersWithCursor(deps.db);
  for (const peer of peers) {
    try {
      const page = await pullEvents(peer.address, peer.lastPulledSequence ?? 0, deps.env.FEDERATION_ANTI_ENTROPY_PAGE_SIZE, deps.env.FEDERATION_PEER_TIMEOUT_MS);
      for (const item of page.events) {
        const outcome = await ingestDeviceCreateEvent(deps.db, deps.env, item.envelope, peer.nodeId);
        if (outcome.status === "created" || outcome.status === "merged") {
          publishEvent(deps.realtime, outcome.event);
        }
      }
      if (page.nextAfter !== null) {
        await setPeerLastPulledSequence(deps.db, peer.nodeId, page.nextAfter);
      }
      if (page.events.length > 0) {
        deps.log.info({ peer: peer.nodeId, count: page.events.length }, "federation: anti-entropy pull ingested events");
      }
      // A response at all (even an empty page) is a successful reachability
      // check — same "active check, not self-report" signal as a heartbeat.
      await recordHealthCheckSuccess(deps.db, peer.nodeId);
    } catch (err) {
      deps.log.warn({ err, peer: peer.nodeId }, "federation: anti-entropy pull from peer failed");
      await recordHealthCheckFailure(deps.db, peer.nodeId);
    }
  }
}

export function startFederationWorkers(deps: Deps): FederationWorkersHandle {
  // Best-effort, one-shot, fire-and-forget — doesn't block server startup;
  // a seed being unreachable at boot is not fatal (see joinSeeds above).
  void joinSeeds(deps);

  const heartbeatTimer = setInterval(() => {
    sendHeartbeats(deps).catch((err) => deps.log.error(err, "federation: heartbeat cycle failed"));
  }, deps.env.FEDERATION_HEARTBEAT_INTERVAL_SECONDS * 1000);
  heartbeatTimer.unref();

  const antiEntropyTimer = setInterval(() => {
    pullFromPeers(deps).catch((err) => deps.log.error(err, "federation: anti-entropy cycle failed"));
  }, deps.env.FEDERATION_ANTI_ENTROPY_INTERVAL_SECONDS * 1000);
  antiEntropyTimer.unref();

  return {
    stop: () => {
      clearInterval(heartbeatTimer);
      clearInterval(antiEntropyTimer);
    },
  };
}
