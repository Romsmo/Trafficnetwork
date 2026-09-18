import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyToken, type TokenClaims } from "./jwt.js";
import type { ClientScope } from "../../config/constants.js";
import { unauthorized, forbidden } from "../../lib/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: TokenClaims | null;
  }
}

/**
 * Routes exempt from this hook's header check: infrastructure, both token
 * exchanges (symmetric and device-signed — a client with no token yet is
 * exactly who needs to reach these), the WebSocket upgrade — which still
 * requires a valid credential, just via its own first-message handshake (see
 * modules/realtime/plugin.ts and docs/api.md's "Real-time push" section)
 * rather than a header, so bearer tokens don't end up in proxy/access logs —
 * and this node's own public self-description, which by nature has to be
 * fetchable before any credential exchange can happen (a peer server
 * introducing itself, F-S3+) and carries nothing confidential.
 *
 * The federation endpoints (F-S3, only registered when FEDERATION_ENABLED —
 * see app.ts) are public for the same reason as the token exchanges above: a
 * peer server has no client JWT and never will (it isn't a client) — each
 * endpoint authenticates itself instead, via a signed envelope
 * (join/heartbeat/events) or admission-checked sender identity (events push).
 * Omitting these here would silently require a Bearer token from every other
 * server in the network, which none of them have — see the identical mistake
 * caught for /v1/auth/device-token in F-S2.
 */
const PUBLIC_PATHS = new Set([
  "/v1/health",
  "/v1/auth/token",
  "/v1/auth/device-token",
  "/v1/ws",
  "/v1/network/node-info",
  "/v1/federation/join",
  "/v1/federation/peers",
  "/v1/federation/heartbeat",
  "/v1/federation/events",
]);

/**
 * Registered once, globally, in app.ts — per docs/prompt-phase1-server.md section 7
 * ("kein Sonderzugang am Auth-System vorbei") every /v1/* route requires a valid
 * client credential except the paths in PUBLIC_PATHS above. Scope checks are a
 * separate, per-route concern (see requireScope below) since which scope is
 * required varies by endpoint.
 */
export async function registerAuthHook(app: FastifyInstance) {
  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (req: FastifyRequest, _reply: FastifyReply) => {
    const path = req.url.split("?")[0] ?? "";
    if (PUBLIC_PATHS.has(path)) return;
    if (!path.startsWith("/v1/")) return;

    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw unauthorized("Missing or malformed Authorization header");
    }
    const token = header.slice("Bearer ".length);
    try {
      req.auth = await verifyToken(token, app.deps.env);
    } catch {
      throw unauthorized("Invalid or expired token");
    }
  });
}

/** Per-route preHandler — apply to routes that need more than just "any valid client". */
export function requireScope(scope: ClientScope) {
  return async (req: FastifyRequest) => {
    if (!req.auth?.scopes.includes(scope)) {
      throw forbidden(`This endpoint requires the "${scope}" scope`);
    }
  };
}
