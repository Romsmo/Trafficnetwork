import type { FastifyInstance } from "fastify";
import { findStaticSignsNearby } from "../../db/queries/static-signs.js";
import { parseLatLng, parseRadiusM } from "../../lib/query-params.js";
import { getStaticDataManifest, getStaticDataPartitionJson } from "./manifest.service.js";
import { notFound } from "../../lib/errors.js";

export async function registerStaticDataRoutes(app: FastifyInstance) {
  app.get("/v1/static-signs/nearby", async (req) => {
    const query = req.query as Record<string, unknown>;
    const { lat, lng } = parseLatLng(query);
    const radiusM = parseRadiusM(query.radiusM);
    const signs = await findStaticSignsNearby(app.deps.db, lat, lng, radiusM);
    return { signs };
  });

  // Partitioned static-data delivery (client-lib P2.0) — see
  // docs/prompt-phase2-client-lib.md section 4 / docs/api.md "Static data
  // packages". Complements, doesn't replace, /v1/snapshot.
  app.get("/v1/static-data/manifest", async () => {
    return getStaticDataManifest(app.deps.db, app.deps.env);
  });

  app.get("/v1/static-data/partitions/:tile", async (req, reply) => {
    const { tile } = req.params as { tile: string };
    const json = await getStaticDataPartitionJson(app.deps.db, app.deps.env, tile);
    if (json === null) throw notFound(`No static-data partition for tile ${tile}`);
    reply.header("content-type", "application/json").send(json);
  });
}
