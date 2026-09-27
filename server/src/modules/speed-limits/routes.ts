import type { FastifyInstance } from "fastify";
import { findNearestSpeedLimit, findSpeedLimitSegmentsNearby } from "../../db/queries/speed-limit-segments.js";
import { parseLatLng, parseRadiusM } from "../../lib/query-params.js";
import { notFound } from "../../lib/errors.js";

export async function registerSpeedLimitRoutes(app: FastifyInstance) {
  app.get("/v1/speed-limit", async (req) => {
    const query = req.query as Record<string, unknown>;
    const { lat, lng } = parseLatLng(query);
    const result = await findNearestSpeedLimit(app.deps.db, lat, lng, app.deps.env.SPEED_LIMIT_LOOKUP_MAX_DISTANCE_METERS, app.deps.env.COMMUNITY_CORRECTIONS_ENABLED);
    if (!result) {
      throw notFound("No speed limit segment found within range of this position");
    }
    return result;
  });

  app.get("/v1/speed-limit-segments/nearby", async (req) => {
    const query = req.query as Record<string, unknown>;
    const { lat, lng } = parseLatLng(query);
    const radiusM = parseRadiusM(query.radiusM);
    const segments = await findSpeedLimitSegmentsNearby(app.deps.db, lat, lng, radiusM, app.deps.env.COMMUNITY_CORRECTIONS_ENABLED);
    return { segments };
  });
}
