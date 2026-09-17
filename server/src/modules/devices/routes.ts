import type { FastifyInstance } from "fastify";
import { countDevicesRegisteredInLastDay, findClientByClientId, insertClient } from "../../db/queries/clients.js";
import { generateClientId, generateClientSecret, hashSecret } from "../auth/credentials.js";
import { requireScope } from "../auth/hook.js";
import { tooManyRequests } from "../../lib/errors.js";

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
}
