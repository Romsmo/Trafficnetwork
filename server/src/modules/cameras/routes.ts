import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  findEnforcementDeviceCandidatesInEnvelopes,
  findEnforcementDevicesNearby,
} from "../../db/queries/fixed-speed-cameras.js";
import { findHazardReportsByTiles, findHazardReportsNearby } from "../../db/queries/hazard-reports.js";
import {
  ADDITIONAL_PERSISTENT_CAMERA_TYPES,
  DYNAMIC_CAMERA_TYPES,
  PERSISTENT_CAMERA_TYPES,
  isPersistentCameraType,
  type HazardType,
  type PersistentCameraType,
} from "../../config/constants.js";
import { getResolution } from "h3-js";
import { expandTile } from "../../lib/h3.js";
import { parseHazardTypes, parseLatLng, parseRadiusM } from "../../lib/query-params.js";
import { badRequest } from "../../lib/errors.js";
import { reportCameraRemoval } from "./service.js";
import { publishEvent } from "../realtime/publisher.js";
import { pointTileOf, tileEnvelopes } from "../static-data/tiles.js";

/**
 * Splits a requested types filter into "which persistent device kinds" + "which dynamic camera types".
 * `redLightCamera` and `distanceControl` exist in both worlds (a persistent device and an expiring report),
 * so asking for one of them returns both; nothing asked for = everything.
 */
function resolveCameraFilter(requested: HazardType[] | undefined): { persistentTypes: PersistentCameraType[]; dynamicTypes: HazardType[] } {
  if (!requested) return { persistentTypes: [...PERSISTENT_CAMERA_TYPES], dynamicTypes: [...DYNAMIC_CAMERA_TYPES] };
  return {
    persistentTypes: requested.filter(isPersistentCameraType),
    dynamicTypes: requested.filter((t) => (DYNAMIC_CAMERA_TYPES as readonly HazardType[]).includes(t)),
  };
}

/** Persistent devices of the given kinds that really lie in one of the tiles: the bounding boxes find candidates through the index, an exact H3 check decides. */
async function devicesInTiles(app: FastifyInstance, tiles: string[], types: PersistentCameraType[]) {
  const wanted = new Set(tiles);
  const resolution = getResolution(tiles[0]!);
  const candidates = await findEnforcementDeviceCandidatesInEnvelopes(
    app.deps.db,
    tiles.flatMap((tile) => tileEnvelopes(tile)),
    types,
  );
  return candidates.filter((device) => wanted.has(pointTileOf(device.position, resolution)));
}

export async function registerCameraRoutes(app: FastifyInstance) {
  app.get("/v1/speed-cameras/nearby", async (req) => {
    if (!app.deps.env.SPEED_CAMERA_NAMESPACE_ENABLED) return { cameras: [] };

    const query = req.query as Record<string, unknown>;
    const { lat, lng } = parseLatLng(query);
    const radiusM = parseRadiusM(query.radiusM);
    const { persistentTypes, dynamicTypes } = resolveCameraFilter(parseHazardTypes(query.types));

    const [persistent, dynamic] = await Promise.all([
      findEnforcementDevicesNearby(app.deps.db, lat, lng, radiusM, persistentTypes),
      dynamicTypes.length > 0 ? findHazardReportsNearby(app.deps.db, lat, lng, radiusM, dynamicTypes) : [],
    ]);
    return { cameras: [...persistent, ...dynamic] };
  });

  // Speed cameras are not here — they're globally synced (like static_signs), not region-tiled,
  // so a "by tile" query never applied to them and still doesn't. The dynamic camera-adjacent
  // hazard_reports types are tile-partitioned; the persistent red-light and distance devices (add-on D)
  // have no region tile of their own and are found through the tiles' bounding boxes instead.
  app.get("/v1/speed-cameras/by-tile", async (req) => {
    if (!app.deps.env.SPEED_CAMERA_NAMESPACE_ENABLED) return { cameras: [] };

    const query = req.query as Record<string, unknown>;
    if (typeof query.tile !== "string" || query.tile.length === 0) {
      throw badRequest("tile query parameter is required");
    }
    const kResult = z.coerce.number().int().min(0).max(5).safeParse(query.k ?? 0);
    if (!kResult.success) throw badRequest("k must be an integer between 0 and 5");
    const { persistentTypes, dynamicTypes } = resolveCameraFilter(parseHazardTypes(query.types));
    const additionalTypes = persistentTypes.filter((t) => (ADDITIONAL_PERSISTENT_CAMERA_TYPES as readonly PersistentCameraType[]).includes(t));
    if (dynamicTypes.length === 0 && additionalTypes.length === 0) return { cameras: [] };

    const tiles = expandTile(query.tile, kResult.data);
    const [devices, reports] = await Promise.all([
      additionalTypes.length > 0 ? devicesInTiles(app, tiles, additionalTypes) : [],
      dynamicTypes.length > 0 ? findHazardReportsByTiles(app.deps.db, tiles, dynamicTypes) : [],
    ]);
    return { cameras: [...devices, ...reports] };
  });

  // Writes are always accepted regardless of the flag — see modules/cameras/service.ts.
  // reporterId is the authenticated client's own identity, see modules/hazard-reports/routes.ts.
  app.post("/v1/speed-cameras/:id/removal-reports", async (req) => {
    const params = req.params as { id: string };
    const result = await reportCameraRemoval(app.deps.db, app.deps.env, {
      cameraId: params.id,
      reporterId: req.auth!.sub,
    });
    if (result.event) publishEvent(app.realtime, result.event);
    return { camera: result.camera, recorded: result.recorded, removed: result.removed };
  });
}
