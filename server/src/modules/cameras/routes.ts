import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findFixedSpeedCamerasNearby } from "../../db/queries/fixed-speed-cameras.js";
import { findHazardReportsByTiles, findHazardReportsNearby } from "../../db/queries/hazard-reports.js";
import { DYNAMIC_CAMERA_TYPES, type HazardType } from "../../config/constants.js";
import { expandTile } from "../../lib/h3.js";
import { parseHazardTypes, parseLatLng, parseRadiusM } from "../../lib/query-params.js";
import { badRequest } from "../../lib/errors.js";
import { reportCameraRemoval } from "./service.js";

/** Splits a requested types filter into "include fixed cameras?" + "which dynamic camera types". */
function resolveCameraFilter(requested: HazardType[] | undefined): { includeFixed: boolean; dynamicTypes: HazardType[] } {
  if (!requested) return { includeFixed: true, dynamicTypes: [...DYNAMIC_CAMERA_TYPES] };
  return {
    includeFixed: requested.includes("fixedSpeedCamera"),
    dynamicTypes: requested.filter((t) => (DYNAMIC_CAMERA_TYPES as readonly HazardType[]).includes(t)),
  };
}

export async function registerCameraRoutes(app: FastifyInstance) {
  app.get("/v1/speed-cameras/nearby", async (req) => {
    if (!app.deps.env.SPEED_CAMERA_NAMESPACE_ENABLED) return { cameras: [] };

    const query = req.query as Record<string, unknown>;
    const { lat, lng } = parseLatLng(query);
    const radiusM = parseRadiusM(query.radiusM);
    const { includeFixed, dynamicTypes } = resolveCameraFilter(parseHazardTypes(query.types));

    const [fixed, dynamic] = await Promise.all([
      includeFixed ? findFixedSpeedCamerasNearby(app.deps.db, lat, lng, radiusM) : [],
      dynamicTypes.length > 0 ? findHazardReportsNearby(app.deps.db, lat, lng, radiusM, dynamicTypes) : [],
    ]);
    return { cameras: [...fixed, ...dynamic] };
  });

  // No fixed cameras here — they're globally synced (like static_signs), not
  // region-tiled, so a "by tile" query doesn't apply to them. Only the four
  // dynamic camera-adjacent hazard_reports types are tile-partitioned.
  app.get("/v1/speed-cameras/by-tile", async (req) => {
    if (!app.deps.env.SPEED_CAMERA_NAMESPACE_ENABLED) return { cameras: [] };

    const query = req.query as Record<string, unknown>;
    if (typeof query.tile !== "string" || query.tile.length === 0) {
      throw badRequest("tile query parameter is required");
    }
    const kResult = z.coerce.number().int().min(0).max(5).safeParse(query.k ?? 0);
    if (!kResult.success) throw badRequest("k must be an integer between 0 and 5");
    const { dynamicTypes } = resolveCameraFilter(parseHazardTypes(query.types));
    if (dynamicTypes.length === 0) return { cameras: [] };

    const tiles = expandTile(query.tile, kResult.data);
    const cameras = await findHazardReportsByTiles(app.deps.db, tiles, dynamicTypes);
    return { cameras };
  });

  // Writes are always accepted regardless of the flag — see modules/cameras/service.ts.
  const removalBodySchema = z.object({ reporterId: z.string().min(1) });

  app.post("/v1/speed-cameras/:id/removal-reports", async (req) => {
    const params = req.params as { id: string };
    const parsed = removalBodySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request body", parsed.error.issues);
    return reportCameraRemoval(app.deps.db, app.deps.env, {
      cameraId: params.id,
      reporterId: parsed.data.reporterId,
    });
  });
}
