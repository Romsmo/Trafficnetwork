import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { expandTile } from "../../lib/h3.js";
import { parseHazardTypes, parseLatLng, parseRadiusM } from "../../lib/query-params.js";
import { badRequest } from "../../lib/errors.js";
import { reportCameraRemoval } from "./service.js";
import { publishEvent } from "../realtime/publisher.js";
import { readCamerasInTiles, readCamerasNear, requestedCameraTypes } from "./policy/delivery.js";
import { mayShowCamera } from "./write-response.js";

export async function registerCameraRoutes(app: FastifyInstance) {
  // The routes say what is asked; which countries' cameras come back, individually or as zones, is decided in one place:
  // modules/cameras/policy/ (docs/camera-country-policy.md). Nothing here knows about countries.
  app.get("/v1/speed-cameras/nearby", async (req) => {
    const query = req.query as Record<string, unknown>;
    const { lat, lng } = parseLatLng(query);
    const radiusM = parseRadiusM(query.radiusM);
    const types = requestedCameraTypes(parseHazardTypes(query.types));
    return readCamerasNear(app.deps.db, app.cameraPolicy.current(), { lat, lng, radiusM, types });
  });

  // Classic speed cameras are not here — they're globally synced (like static_signs), not region-tiled,
  // so a "by tile" query never applied to them and still doesn't. The dynamic camera-adjacent
  // hazard_reports types are tile-partitioned; the persistent red-light and distance devices (add-on D)
  // have no region tile of their own and are found through the tiles' bounding boxes instead.
  app.get("/v1/speed-cameras/by-tile", async (req) => {
    const query = req.query as Record<string, unknown>;
    if (typeof query.tile !== "string" || query.tile.length === 0) {
      throw badRequest("tile query parameter is required");
    }
    const kResult = z.coerce.number().int().min(0).max(5).safeParse(query.k ?? 0);
    if (!kResult.success) throw badRequest("k must be an integer between 0 and 5");
    const types = requestedCameraTypes(parseHazardTypes(query.types));

    const tiles = expandTile(query.tile, kResult.data);
    return readCamerasInTiles(app.deps.db, app.cameraPolicy.current(), { tiles, types });
  });

  // Writes are always accepted regardless of the policy — see modules/cameras/service.ts. What the answer discloses
  // depends on the camera's country (modules/cameras/write-response.ts).
  // reporterId is the authenticated client's own identity, see modules/hazard-reports/routes.ts.
  app.post("/v1/speed-cameras/:id/removal-reports", async (req) => {
    const params = req.params as { id: string };
    const result = await reportCameraRemoval(app.deps.db, app.deps.env, {
      cameraId: params.id,
      reporterId: req.auth!.sub,
    });
    if (result.event) publishEvent(app.realtime, result.event);
    if (!mayShowCamera(app, result.camera)) return { recorded: result.recorded, removed: result.removed };
    return { camera: result.camera.item, recorded: result.recorded, removed: result.removed };
  });
}
