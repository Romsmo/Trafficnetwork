import type { FastifyInstance } from "fastify";
import type { SignedEnvelope } from "../crypto/envelope.js";
import type { DeviceCreateEventPayload } from "./device-event.js";
import type { SpeedLimitVoteEnvelope } from "../speed-limit-corrections/vote.js";
import { listPeers } from "../../db/queries/network-peers.js";
import { pushEvents } from "./http-client.js";

/**
 * Best-effort gossip fan-out, shared by the two places a device-signed
 * create event can first become known to this server: a peer's push
 * (modules/federation/routes.ts) and a device submitting directly to this
 * server's own POST /v1/hazard-reports (modules/hazard-reports/routes.ts).
 * Never awaited by its caller's HTTP response — dedup on the receiving end
 * (federationEventExists, see modules/federation/ingest.ts) is what actually
 * bounds re-flooding across the mesh, not anything here.
 */
export function broadcastFederationEvents(
  app: FastifyInstance,
  envelopes: SignedEnvelope<DeviceCreateEventPayload>[],
  excludeNodeId: string | null,
): void {
  if (!app.deps.env.FEDERATION_ENABLED || envelopes.length === 0) return;
  listPeers(app.deps.db)
    .then((peers) => {
      const targets = peers.filter((p) => p.nodeId !== excludeNodeId);
      for (const peer of targets) {
        pushEvents(peer.address, app.nodeIdentity.nodeId, envelopes, app.deps.env.FEDERATION_PEER_TIMEOUT_MS).catch((err) => {
          app.log.warn({ err, peer: peer.nodeId }, "federation: gossip fan-out to peer failed");
        });
      }
    })
    .catch((err) => app.log.warn({ err }, "federation: gossip fan-out could not list peers"));
}

/**
 * Same best-effort fan-out for device-signed speed-limit votes (add-on K-A).
 * Only when this server both federates and runs corrections; a peer that has
 * corrections switched off answers `ignored`, an older peer never sees the field.
 */
export function broadcastSpeedLimitVotes(
  app: FastifyInstance,
  votes: SpeedLimitVoteEnvelope[],
  excludeNodeId: string | null,
): void {
  if (!app.deps.env.FEDERATION_ENABLED || !app.deps.env.COMMUNITY_CORRECTIONS_ENABLED || votes.length === 0) return;
  listPeers(app.deps.db)
    .then((peers) => {
      for (const peer of peers.filter((p) => p.nodeId !== excludeNodeId)) {
        pushEvents(peer.address, app.nodeIdentity.nodeId, [], app.deps.env.FEDERATION_PEER_TIMEOUT_MS, votes).catch((err) => {
          app.log.warn({ err, peer: peer.nodeId }, "federation: speed-limit vote fan-out to peer failed");
        });
      }
    })
    .catch((err) => app.log.warn({ err }, "federation: speed-limit vote fan-out could not list peers"));
}
