import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findClientByClientId } from "../../db/queries/clients.js";
import { verifySecret } from "./credentials.js";
import { signToken } from "./jwt.js";
import { unauthorized } from "../../lib/errors.js";
import { isFreshTimestamp, verifySignedEnvelope, type SignedEnvelope } from "../crypto/envelope.js";

const tokenBodySchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

const ASSERTION_FRESHNESS_WINDOW_SECONDS = 60;

interface DeviceTokenAssertion {
  clientId: string;
  timestamp: string;
}

const deviceTokenBodySchema = z.object({
  clientId: z.string().min(1),
  assertion: z.object({
    // .passthrough(): the signed payload must reach verifySignedEnvelope()
    // byte-for-byte as the signer canonicalized it. zod's default object
    // parsing *strips* unrecognized keys from its output — if a client ever
    // signs a payload with an extra field this schema doesn't know about,
    // stripping it here would silently change what gets re-canonicalized
    // and verification would spuriously fail. We only need to *validate
    // that* clientId/timestamp are present with the right type, not force
    // the payload closed.
    payload: z.object({
      clientId: z.string().min(1),
      timestamp: z.string(),
    }).passthrough(),
    keyId: z.string(),
    signature: z.string(),
  }),
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

  /**
   * Additive alternative to POST /v1/auth/token for clients that have bound
   * a device key (POST /v1/devices/bind-key) — same output shape, same
   * downstream auth hook/scope handling, just a different way to prove
   * identity: a signature the device's own private key produced, verified
   * against the public key stored on its clients row, rather than a shared
   * secret. This is the whole point of asymmetric device identity
   * (docs/federation.md section 2) — any server that has this client's
   * public key (not just the one that originally issued its credential) can
   * verify it, with no shared secret ever changing hands between servers.
   */
  app.post(
    "/v1/auth/device-token",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const parsed = deviceTokenBodySchema.safeParse(req.body);
      if (!parsed.success) throw unauthorized("Invalid assertion");

      const client = await findClientByClientId(app.deps.db, parsed.data.clientId);
      if (!client || client.revokedAt || !client.devicePublicKey) throw unauthorized("Invalid assertion");

      const assertion = parsed.data.assertion as SignedEnvelope<DeviceTokenAssertion>;
      if (assertion.payload.clientId !== parsed.data.clientId) throw unauthorized("Invalid assertion");
      if (!isFreshTimestamp(assertion.payload.timestamp, ASSERTION_FRESHNESS_WINDOW_SECONDS)) {
        throw unauthorized("Invalid assertion");
      }
      if (!verifySignedEnvelope(assertion, client.devicePublicKey)) throw unauthorized("Invalid assertion");

      const token = await signToken({ sub: client.clientId, scopes: client.scopes }, app.deps.env);
      return { accessToken: token, tokenType: "Bearer", expiresIn: app.deps.env.JWT_TTL_SECONDS, scopes: client.scopes };
    },
  );
}
