import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bindDevicePublicKey, countDevicesRegisteredInLastDay, findClientByClientId, insertClient } from "../../db/queries/clients.js";
import { generateClientId, generateClientSecret, hashSecret } from "../auth/credentials.js";
import { requireScope } from "../auth/hook.js";
import { badRequest, conflict, tooManyRequests } from "../../lib/errors.js";
import { isFreshTimestamp, verifySignedEnvelope, type SignedEnvelope } from "../crypto/envelope.js";

const ASSERTION_FRESHNESS_WINDOW_SECONDS = 60;

interface BindKeyAssertion {
  publicKey: string;
  timestamp: string;
}

/**
 * Anonymous device registration (client-lib P2.0, docs/concept.md section 6):
 * an app authenticates with its own app-key credential (scope
 * `device-registration`, provisioned like any other client via
 * `create-client`) and gets back a fresh, pseudonymous device credential —
 * its own reporter identity, indistinguishable from one created via
 * create-client, just self-service and traceable back to the app that
 * requested it (clients.registered_by_client_id). No new auth mechanism: the
 * device uses the returned credential against the ordinary POST
 * /v1/auth/token exactly like any other client.
 */
export async function registerDeviceRoutes(app: FastifyInstance) {
  app.post(
    "/v1/devices/register",
    {
      preHandler: requireScope("device-registration"),
      // Per-IP throttle on top of the per-app-key daily cap below — same
      // pattern as POST /v1/auth/token (modules/auth/routes.ts).
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req) => {
      const appClientId = req.auth!.sub;
      const appClient = await findClientByClientId(app.deps.db, appClientId);
      if (!appClient || appClient.revokedAt) {
        // The token was valid at sign time but the app key has since been
        // revoked — should be rare given short JWT_TTL_SECONDS, but device
        // registration is exactly the capability a revoked app key must lose.
        throw tooManyRequests("App key is no longer active");
      }

      const registeredToday = await countDevicesRegisteredInLastDay(app.deps.db, appClient.id);
      if (registeredToday >= app.deps.env.DEVICE_REGISTRATION_RATE_LIMIT_MAX_PER_DAY) {
        throw tooManyRequests(
          `App key has reached its daily device-registration limit (${app.deps.env.DEVICE_REGISTRATION_RATE_LIMIT_MAX_PER_DAY})`,
        );
      }

      const clientId = generateClientId();
      const clientSecret = generateClientSecret();
      const clientSecretHash = await hashSecret(clientSecret);

      await insertClient(app.deps.db, {
        clientId,
        clientSecretHash,
        scopes: ["client"],
        name: `device:${clientId}`,
        registeredByClientId: appClient.id,
      });

      return { clientId, clientSecret };
    },
  );

  const bindKeyBodySchema = z.object({
    // .passthrough() on payload: see the identical comment in
    // modules/auth/routes.ts's deviceTokenBodySchema — the signed payload
    // must reach verifySignedEnvelope() exactly as the signer canonicalized
    // it, not with zod-stripped unrecognized keys.
    assertion: z.object({
      payload: z.object({
        publicKey: z.string().min(1),
        timestamp: z.string(),
      }).passthrough(),
      keyId: z.string(),
      signature: z.string(),
    }),
  });

  /**
   * Additive migration path (F-S2, docs/threat-model.md): any existing
   * client — symmetric-secret P1/P2 clients included — can bind a
   * device-generated Ed25519 key to its own identity, preserving its
   * clientId/history instead of needing to start over as a stranger.
   * Authenticated normally (existing Bearer token proves *which* client is
   * binding); the signed assertion proves possession of the new key's
   * private half — the payload names its own signer (`publicKey`) and is
   * verified against exactly that key, which is what actually proves
   * possession, not the Bearer token. One-shot: see
   * db/queries/clients.ts's bindDevicePublicKey for why rotation isn't this
   * endpoint.
   */
  app.post("/v1/devices/bind-key", async (req) => {
    const parsed = bindKeyBodySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request body", parsed.error.issues);

    const assertion = parsed.data.assertion as SignedEnvelope<BindKeyAssertion>;
    if (!isFreshTimestamp(assertion.payload.timestamp, ASSERTION_FRESHNESS_WINDOW_SECONDS)) {
      throw badRequest("Assertion timestamp is stale or invalid");
    }
    if (!verifySignedEnvelope(assertion, assertion.payload.publicKey)) {
      throw badRequest("Assertion signature does not verify against its own claimed publicKey");
    }

    const bound = await bindDevicePublicKey(app.deps.db, req.auth!.sub, assertion.payload.publicKey);
    if (!bound) {
      throw conflict("KEY_ALREADY_BOUND", "This client already has a device key bound, or no longer exists/is revoked");
    }

    return { bound: true, publicKey: assertion.payload.publicKey };
  });
}
