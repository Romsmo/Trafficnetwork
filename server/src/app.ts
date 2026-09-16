import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
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
import { registerRealtimeModule } from "./modules/realtime/plugin.js";
import type { SubscriptionRegistry } from "./modules/realtime/registry.js";

export interface AppDependencies {
  env: Env;
  db: Database["db"];
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDependencies;
    realtime: SubscriptionRegistry;
  }
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.env.LOG_LEVEL },
  });

  app.decorate("deps", deps);

  await app.register(cors, { origin: true });
  // global: false — only routes that opt in via `config: { rateLimit: {...} }`
  // are limited (currently just POST /v1/auth/token, to blunt credential
  // brute-forcing; everything else is already protected by the per-reporter
  // moderation-gate rate limit, which is a different concern — see
  // modules/moderation/rate-limit.ts).
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
    app.log.error(err);
    reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });

  await registerAuthHook(app);
  app.decorate("realtime", await registerRealtimeModule(app));

  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerSpeedLimitRoutes(app);
  await registerStaticDataRoutes(app);
  await registerHazardReportRoutes(app);
  await registerCameraRoutes(app);
  await registerSyncRoutes(app);
  await registerBulkImportRoutes(app);

  return app;
}
