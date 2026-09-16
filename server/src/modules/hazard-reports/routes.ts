import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findHazardReportsByTiles, findHazardReportsNearby } from "../../db/queries/hazard-reports.js";
import { HAZARD_TYPES, NON_CAMERA_HAZARD_TYPES, type HazardType } from "../../config/constants.js";
import { expandTile } from "../../lib/h3.js";
import { parseHazardTypes, parseLatLng, parseRadiusM } from "../../lib/query-params.js";
import { badRequest } from "../../lib/errors.js";
import { confirmReport, createOrMergeReport } from "./service.js";

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

  // reporterId comes from the request body only until milestone P1.5's auth module
  // exists — it will then be derived from the authenticated client's JWT subject
  // instead, and this field will be removed rather than trusted from the client.
  const createBodySchema = z.object({
    type: z.enum(HAZARD_TYPES),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    speedKmh: z.number().optional(),
    reporterId: z.string().min(1),
  });

  app.post("/v1/hazard-reports", async (req, reply) => {
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Invalid request body", parsed.error.issues);
    }
    const { reporterId, ...input } = parsed.data;
    const result = await createOrMergeReport(app.deps.db, app.deps.env, { ...input, reporterId });
    reply.status(result.merged ? 200 : 201);
    return result;
  });

  const confirmBodySchema = z.object({
    kind: z.enum(["stillThere", "gone"]),
    reporterId: z.string().min(1),
  });

  app.post("/v1/hazard-reports/:id/confirmations", async (req) => {
    const params = req.params as { id: string };
    const parsed = confirmBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Invalid request body", parsed.error.issues);
    }
    return confirmReport(app.deps.db, app.deps.env, {
      reportId: params.id,
      reporterId: parsed.data.reporterId,
      kind: parsed.data.kind,
    });
  });
}
