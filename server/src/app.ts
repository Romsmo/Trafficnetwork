import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Env } from "./config/env.js";
import type { Database } from "./db/client.js";
import { ApiError } from "./lib/errors.js";
import { registerHealthRoutes } from "./modules/health/routes.js";
import { registerSpeedLimitRoutes } from "./modules/speed-limits/routes.js";
import { registerStaticDataRoutes } from "./modules/static-data/routes.js";
import { registerHazardReportRoutes } from "./modules/hazard-reports/routes.js";
import { registerSyncRoutes } from "./modules/sync/routes.js";
import { registerCameraRoutes } from "./modules/cameras/routes.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerAuthHook } from "./modules/auth/hook.js";
import { registerBulkImportRoutes } from "./modules/bulk-import/routes.js";
import { registerDeviceRoutes } from "./modules/devices/routes.js";
import { registerConfigRoutes } from "./modules/config/routes.js";
import { registerRealtimeModule } from "./modules/realtime/plugin.js";
import type { SubscriptionRegistry } from "./modules/realtime/registry.js";
import { loadOrCreateNodeIdentity, type NodeIdentity } from "./modules/network/node-identity.js";
import { registerNetworkRoutes } from "./modules/network/routes.js";
import type { NetworkConfigPayload } from "./modules/network/config.js";
import { CameraPolicyService } from "./modules/cameras/policy/policy.js";
import { syncCameraPolicy } from "./modules/cameras/policy/sync.js";
import { getPackageService } from "./modules/static-data/package-service.js";
import type { SignedEnvelope } from "./modules/crypto/envelope.js";
import { registerFederationRoutes } from "./modules/federation/routes.js";
import { registerSpeedLimitCorrectionRoutes } from "./modules/speed-limit-corrections/routes.js";
import { syncCorrectionsOverlaySwitch } from "./modules/speed-limit-corrections/switch.js";
import { OnlineTracker } from "./modules/online/tracker.js";
import { registerOnlineModule } from "./modules/online/plugin.js";
import { registerWebGuard } from "./modules/web/guard.js";
import { registerWebModule } from "./modules/web/plugin.js";
import { parseTrustProxy } from "./lib/trust-proxy.js";
import { privacyRequestSerializer } from "./lib/log-serializers.js";

export interface AppDependencies {
  env: Env;
  db: Database["db"];
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDependencies;
    realtime: SubscriptionRegistry;
    nodeIdentity: NodeIdentity;
    /** "Currently online" head count (numbers only, in memory) — see modules/online/. */
    online: OnlineTracker;
    /**
     * Full signed envelope (not just the payload) so /v1/config can expose the raw signature for independent client verification.
     * A getter: the signed config is re-read while the node runs (modules/cameras/policy/policy.ts), so this is the one in force *now*.
     */
    networkConfig: SignedEnvelope<NetworkConfigPayload> | null;
    /** The country-based camera policy (docs/camera-country-policy.md): what camera data this node may deliver, per country. */
    cameraPolicy: CameraPolicyService;
  }
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const options: FastifyServerOptions = {
    logger: {
      level: deps.env.LOG_LEVEL,
      ...(deps.env.LOG_PRIVACY_MODE ? { serializers: { req: privacyRequestSerializer } } : {}),
    },
    // A hop count (number) is supported at runtime; the type definitions just don't list it.
    trustProxy: parseTrustProxy(deps.env.TRUST_PROXY) as FastifyServerOptions["trustProxy"],
  };
  const app = Fastify(options);

  app.decorate("deps", deps);

  // Load the signed network config (if any) before anything else is registered. What camera data may be delivered is
  // decided by the camera policy derived from it (per country; the global flag is the emergency brake) — every
  // delivery path asks app.cameraPolicy, none reads the flag itself. See modules/cameras/policy/.
  const cameraPolicy = await CameraPolicyService.load(deps.env, app.log);
  app.decorate("cameraPolicy", cameraPolicy);
  app.decorate("networkConfig", { getter: () => cameraPolicy.current().envelope });
  app.addHook("onClose", async () => {
    cameraPolicy.stop();
    // a rebuild of policy-stale package tiles started by a policy change must not outlive the server (or its database connection)
    await getPackageService(deps.db, deps.env, app.log).idle();
  });

  await app.register(cors, { origin: true });
  // global: false — only routes that opt in via `config: { rateLimit: {...} }`
  // are limited (POST /v1/auth/token and POST /v1/devices/register, both
  // credential-issuing endpoints worth blunting brute-forcing/abuse on;
  // everything else is already protected by the per-reporter moderation-gate
  // rate limit, which is a different concern — see modules/moderation/rate-limit.ts).
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err: FastifyError | ApiError, _req, reply) => {
    if (err instanceof ApiError) {
      reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    if (err.validation) {
      reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: err.message, details: err.validation },
      });
      return;
    }
    // Fastify itself (or a plugin, e.g. @fastify/rate-limit's 429) throws plain
    // Errors carrying their own statusCode rather than an ApiError — respect it
    // instead of flattening every non-ApiError into a 500.
    if (err.statusCode && err.statusCode < 500) {
      reply.status(err.statusCode).send({
        error: { code: err.code ?? "REQUEST_ERROR", message: err.message },
      });
      return;
    }
    app.log.error(err);
    reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });

  app.decorate("nodeIdentity", await loadOrCreateNodeIdentity(deps.db));

  // Bring the static-data packages in line with the policy in force: now (a change made while the node was down) and on
  // every change while it runs. Only the tiles of countries whose level changed are marked.
  const logPolicySync = (result: Awaited<ReturnType<typeof syncCameraPolicy>>) => {
    if (result.tilesMarked > 0 || result.changedCountries.length > 0 || result.defaultChanged) app.log.info(result, "camera policy: static-data packages marked for rebuild");
    // A country got stricter: the packages of its tiles are not served until rebuilt, so start rebuilding now.
    if (result.staleTiles > 0) getPackageService(deps.db, deps.env, app.log, () => cameraPolicy.current()).kickPolicyRebuild();
  };
  logPolicySync(await syncCameraPolicy(deps.db, deps.env, cameraPolicy.current()));
  cameraPolicy.onChange(async (next) => logPolicySync(await syncCameraPolicy(deps.db, deps.env, next)));

  app.decorate(
    "online",
    new OnlineTracker({
      enabled: deps.env.ONLINE_COUNTER_ENABLED,
      windowSeconds: deps.env.ONLINE_WINDOW_SECONDS,
      maxTracked: deps.env.ONLINE_MAX_TRACKED,
      peerStaleSeconds: deps.env.ONLINE_PEER_STALE_SECONDS,
    }),
  );

  await registerAuthHook(app);
  // After the auth hook (reads req.auth) and before the routes it observes
  // (a hook only covers routes registered after it).
  await registerOnlineModule(app);
  // Must come after the auth hook (it reads req.auth) and before any route it is meant to guard.
  await registerWebGuard(app);
  app.decorate("realtime", await registerRealtimeModule(app));

  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerSpeedLimitRoutes(app);
  await registerStaticDataRoutes(app);
  await registerHazardReportRoutes(app);
  await registerCameraRoutes(app);
  await registerSyncRoutes(app);
  await registerBulkImportRoutes(app);
  await registerDeviceRoutes(app);
  await registerConfigRoutes(app);
  await registerNetworkRoutes(app);
  // Community speed-limit corrections (add-on K-A): with the switch off the
  // endpoints don't exist and reads skip the overlay. A flip since the last
  // boot is recorded (and announced) here, before the first request is served.
  await syncCorrectionsOverlaySwitch(deps.db, deps.env, app.log);
  if (deps.env.COMMUNITY_CORRECTIONS_ENABLED) {
    await registerSpeedLimitCorrectionRoutes(app);
  }
  // Web UI pages/files + POST /v1/web/session; only when WEB_UI_ENABLED (docs/web-ui.md).
  await registerWebModule(app);
  // Only registered when federating (F-S3) — an isolated server (the
  // default) has no join/heartbeat/push/pull endpoints at all, exactly like
  // before this milestone, rather than exposing them but rejecting every
  // call. See the retired status log (git history)'s migration-path note.
  if (deps.env.FEDERATION_ENABLED) {
    await registerFederationRoutes(app);
  }

  return app;
}
