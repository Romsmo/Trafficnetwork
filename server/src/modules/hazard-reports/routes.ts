import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findHazardReportsByTiles, findHazardReportsNearby } from "../../db/queries/hazard-reports.js";
import { HAZARD_TYPES, NON_CAMERA_HAZARD_TYPES, type HazardType } from "../../config/constants.js";
import { expandTile } from "../../lib/h3.js";
import { parseHazardTypes, parseLatLng, parseRadiusM } from "../../lib/query-params.js";
import { badRequest } from "../../lib/errors.js";
import { confirmReport, createOrMergeReport } from "./service.js";
import { createOrMergeFixedCamera } from "../cameras/service.js";
import { publishEvent } from "../realtime/publisher.js";

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

  // reporterId is the authenticated client's own identity (the JWT subject set by
  // modules/auth/hook.ts), never a client-supplied field — one client credential
  // per device (see docs/concept.md's architecture), so the credential itself is
  // the reporter identity.
  const createBodySchema = z.object({
    type: z.enum(HAZARD_TYPES),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    speedKmh: z.number().optional(),
  });

  app.post("/v1/hazard-reports", async (req, reply) => {
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Invalid request body", parsed.error.issues);
    }
    const input = parsed.data;
    const reporterId = req.auth!.sub;

    // fixedSpeedCamera is a valid input classification but is never stored as a
    // hazard_reports row — it's routed into fixed_speed_cameras instead (see
    // modules/cameras/service.ts and docs/prompt-phase1-server.md section 6).
    if (input.type === "fixedSpeedCamera") {
      const cameraResult = await createOrMergeFixedCamera(app.deps.db, app.deps.env, {
        lat: input.lat,
        lng: input.lng,
        reporterId,
      });
      publishEvent(app.realtime, cameraResult.event);
      reply.status(cameraResult.merged ? 200 : 201);
      return { camera: cameraResult.camera, merged: cameraResult.merged };
    }

    const result = await createOrMergeReport(app.deps.db, app.deps.env, {
      type: input.type,
      lat: input.lat,
      lng: input.lng,
      speedKmh: input.speedKmh,
      reporterId,
    });
    publishEvent(app.realtime, result.event);
    reply.status(result.merged ? 200 : 201);
    return { report: result.report, merged: result.merged };
  });

  const confirmBodySchema = z.object({
    kind: z.enum(["stillThere", "gone"]),
  });

  app.post("/v1/hazard-reports/:id/confirmations", async (req) => {
    const params = req.params as { id: string };
    const parsed = confirmBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Invalid request body", parsed.error.issues);
    }
    const result = await confirmReport(app.deps.db, app.deps.env, {
      reportId: params.id,
      reporterId: req.auth!.sub,
      kind: parsed.data.kind,
    });
    if (result.event) publishEvent(app.realtime, result.event);
    return { report: result.report, recorded: result.recorded };
  });
}
