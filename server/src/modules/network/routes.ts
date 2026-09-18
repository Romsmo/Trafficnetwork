import type { FastifyInstance } from "fastify";
import { listPeers } from "../../db/queries/network-peers.js";
import { applyDirectoryProbationCap, computeReputationTier } from "../federation/reputation.js";

/**
 * Single-node self-description — not the multi-server directory (below).
 * Lets an operator or another server confirm this node's identity/public
 * key without needing DB access.
 */
export async function registerNetworkRoutes(app: FastifyInstance) {
  app.get("/v1/network/node-info", async () => {
    return {
      nodeId: app.nodeIdentity.nodeId,
      publicKey: app.nodeIdentity.publicKeyRaw,
      federationEnabled: app.deps.env.FEDERATION_ENABLED,
    };
  });

  /**
   * F-S4: the reputation-scored, network-wide directory promised since F-S2
   * (docs/status.md's coordination note). Always registered, unlike the
   * /v1/federation/* endpoints — a non-federating server (the default) just
   * has an empty `peers` array, since nothing can ever join it (those
   * endpoints don't exist at all when FEDERATION_ENABLED=false), which is
   * harmless and needs no special-casing here. Public, like node-info: this
   * is exactly the data meant to be broadcast/mirrored (F-S0 plan decision
   * 6 — "eigener Modus des bestehenden Servers... zusätzlich als statische
   * JSON-Datei exportierbar", see scripts/network-export-directory.mts).
   */
  app.get("/v1/network/directory", async () => {
    const peers = await listPeers(app.deps.db);
    const withTier = peers
      .map((peer) => ({ ...peer, tier: computeReputationTier(peer, app.deps.env) }))
      .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt));
    const capped = applyDirectoryProbationCap(withTier, app.deps.env.REPUTATION_DIRECTORY_PROBATION_MAX_SHARE);

    return {
      self: {
        nodeId: app.nodeIdentity.nodeId,
        publicKey: app.nodeIdentity.publicKeyRaw,
        address: app.deps.env.FEDERATION_PUBLIC_ADDRESS ?? null,
        federationEnabled: app.deps.env.FEDERATION_ENABLED,
      },
      peers: capped.map((p) => ({
        nodeId: p.nodeId,
        publicKey: p.publicKey,
        address: p.address,
        tier: p.tier,
        discoveredVia: p.discoveredVia,
        joinedAt: p.joinedAt,
        lastSeenAt: p.lastSeenAt,
        lastKnownVersion: p.lastKnownVersion,
      })),
      generatedAt: new Date().toISOString(),
    };
  });
}
