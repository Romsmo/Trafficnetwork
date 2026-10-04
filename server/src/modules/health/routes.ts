import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

/**
 * No auth required (see work order "phase1-server" (kept outside the repo) section 7 "Querschnitt" —
 * this is infrastructure, not one of the versioned /v1 API resources). Checks the
 * database is reachable so a broken DB shows up as a failed liveness probe rather
 * than opaque 500s on every other route.
 */
export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/v1/health", async (_req, reply) => {
    try {
      await app.deps.db.execute(sql`select 1`);
    } catch (err) {
      app.log.error(err, "health check: database unreachable");
      reply.status(503).send({ status: "error", database: "unreachable" });
      return;
    }
    reply.send({ status: "ok", database: "ok" });
  });
}
