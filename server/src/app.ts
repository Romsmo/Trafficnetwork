import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Env } from "./config/env.js";
import type { Database } from "./db/client.js";
import { ApiError } from "./lib/errors.js";
import { registerHealthRoutes } from "./modules/health/routes.js";
import { registerSpeedLimitRoutes } from "./modules/speed-limits/routes.js";
import { registerStaticDataRoutes } from "./modules/static-data/routes.js";
import { registerHazardReportRoutes } from "./modules/hazard-reports/routes.js";
import { registerSyncRoutes } from "./modules/sync/routes.js";

export interface AppDependencies {
  env: Env;
  db: Database["db"];
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDependencies;
  }
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.env.LOG_LEVEL },
  });

  app.decorate("deps", deps);

  await app.register(cors, { origin: true });

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

  await registerHealthRoutes(app);
  await registerSpeedLimitRoutes(app);
  await registerStaticDataRoutes(app);
  await registerHazardReportRoutes(app);
  await registerSyncRoutes(app);

  return app;
}
