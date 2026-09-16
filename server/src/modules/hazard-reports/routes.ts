import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findHazardReportsByTiles, findHazardReportsNearby } from "../../db/queries/hazard-reports.js";
import { NON_CAMERA_HAZARD_TYPES, type HazardType } from "../../config/constants.js";
import { expandTile } from "../../lib/h3.js";
import { parseHazardTypes, parseLatLng, parseRadiusM } from "../../lib/query-params.js";
import { badRequest } from "../../lib/errors.js";

/** Intersects the caller's requested types with what this endpoint is allowed to serve. */
function resolveTypes(requested: HazardType[] | undefined): HazardType[] {
  if (!requested) return [...NON_CAMERA_HAZARD_TYPES];
  const allowed = requested.filter((t) => (NON_CAMERA_HAZARD_TYPES as readonly HazardType[]).includes(t));
  return allowed.length > 0 ? allowed : [...NON_CAMERA_HAZARD_TYPES];
}

export async function registerHazardReportRoutes(app: FastifyInstance) {
  app.get("/v1/hazard-reports/nearby", async (req) => {
    const query = req.query as Record<string, unknown>;
    const { lat, lng } = parseLatLng(query);
    const radiusM = parseRadiusM(query.radiusM);
    const types = resolveTypes(parseHazardTypes(query.types));
    const reports = await findHazardReportsNearby(app.deps.db, lat, lng, radiusM, types);
    return { reports };
  });

  app.get("/v1/hazard-reports/by-tile", async (req) => {
    const query = req.query as Record<string, unknown>;
    if (typeof query.tile !== "string" || query.tile.length === 0) {
      throw badRequest("tile query parameter is required");
    }
    const kResult = z.coerce.number().int().min(0).max(5).safeParse(query.k ?? 0);
    if (!kResult.success) {
      throw badRequest("k must be an integer between 0 and 5");
    }
    const types = resolveTypes(parseHazardTypes(query.types));
    const tiles = expandTile(query.tile, kResult.data);
    const reports = await findHazardReportsByTiles(app.deps.db, tiles, types);
    return { reports };
  });
}
