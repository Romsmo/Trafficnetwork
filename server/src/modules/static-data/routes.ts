import type { FastifyInstance } from "fastify";
import { findStaticSignsNearby } from "../../db/queries/static-signs.js";
import { parseLatLng, parseRadiusM } from "../../lib/query-params.js";

export async function registerStaticDataRoutes(app: FastifyInstance) {
  app.get("/v1/static-signs/nearby", async (req) => {
    const query = req.query as Record<string, unknown>;
    const { lat, lng } = parseLatLng(query);
    const radiusM = parseRadiusM(query.radiusM);
    const signs = await findStaticSignsNearby(app.deps.db, lat, lng, radiusM);
    return { signs };
  });
}
