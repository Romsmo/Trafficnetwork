import type { FastifyInstance } from "fastify";

/**
 * Single-node self-description — not the multi-server directory
 * (`GET /v1/network/nodes`, planned for F-S4 per docs/status.md's
 * coordination note with the client-lib instance; deliberately a different
 * path so the two are never confused). Lets an operator or another server
 * confirm this node's identity/public key without needing DB access.
 */
export async function registerNetworkRoutes(app: FastifyInstance) {
  app.get("/v1/network/node-info", async () => {
    return {
      nodeId: app.nodeIdentity.nodeId,
      publicKey: app.nodeIdentity.publicKeyRaw,
      federationEnabled: app.deps.env.FEDERATION_ENABLED,
    };
  });
}
