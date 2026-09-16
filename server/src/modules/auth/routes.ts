import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findClientByClientId } from "../../db/queries/clients.js";
import { verifySecret } from "./credentials.js";
import { signToken } from "./jwt.js";
import { unauthorized } from "../../lib/errors.js";

const tokenBodySchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

/**
 * Not a full OAuth2 client_credentials implementation (no token endpoint auth
 * methods negotiation, no refresh tokens) — deliberately minimal for a
 * single-operator MVP, per docs/prompt-phase1-server.md section 2's tech-stack
 * guidance ("kein Overengineering für ein MVP").
 */
export async function registerAuthRoutes(app: FastifyInstance) {
  app.post(
    "/v1/auth/token",
    // IP-based, on top of (not instead of) the DB lookup below — blunts
    // credential brute-forcing since this route has no other rate limit
    // (the moderation-gate limiter only applies to authenticated writes).
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const parsed = tokenBodySchema.safeParse(req.body);
      if (!parsed.success) throw unauthorized("Invalid credentials");

      const client = await findClientByClientId(app.deps.db, parsed.data.clientId);
      if (!client || client.revokedAt) throw unauthorized("Invalid credentials");

      const valid = await verifySecret(parsed.data.clientSecret, client.clientSecretHash);
      if (!valid) throw unauthorized("Invalid credentials");

      const token = await signToken({ sub: client.clientId, scopes: client.scopes }, app.deps.env);
      return { accessToken: token, tokenType: "Bearer", expiresIn: app.deps.env.JWT_TTL_SECONDS, scopes: client.scopes };
    },
  );
}
