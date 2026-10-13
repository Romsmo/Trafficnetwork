import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findClientByClientId } from "../../db/queries/clients.js";
import { findSpeedLimitSegmentsNearby } from "../../db/queries/speed-limit-segments.js";
import { findStaticSignsNearby } from "../../db/queries/static-signs.js";
import { badRequest } from "../../lib/errors.js";
import { projectOnSegment } from "../roads/geo.js";
import { publishEvent } from "../realtime/publisher.js";
import { deviceReporterId } from "../speed-limit-corrections/vote.js";
import { DEFECT_REASONS, DEFECT_TARGET_TYPES, reportCounts, reportDefect } from "./service.js";

const NEAR_DEFAULT_M = 30;
const NEAR_MAX_M = 100;
const NEAR_MAX_ITEMS = 20;

const reportBodySchema = z.object({
  targetType: z.enum(DEFECT_TARGET_TYPES),
  targetId: z.string().uuid(),
  reason: z.enum(DEFECT_REASONS).optional(),
});

/**
 * Registered only when DEFECT_REPORTS_ENABLED (docs/road-network.md, "Defect reports"): what could be marked near a point, and the
 * mark. A caller whose client has a bound device key is always that device, so one physical device counts once.
 */
export async function registerDefectRoutes(app: FastifyInstance): Promise<void> {
  const db = app.deps.db;
  const env = app.deps.env;

  app.get("/v1/data-defects/near", async (req) => {
    const query = req.query as Record<string, unknown>;
    const lat = Number(query.lat);
    const lng = Number(query.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw badRequest("lat and lng are required numbers");
    }
    const radius = query.radiusM === undefined ? NEAR_DEFAULT_M : Number(query.radiusM);
    if (!Number.isFinite(radius) || radius <= 0 || radius > NEAR_MAX_M) throw badRequest(`radiusM must be between 1 and ${NEAR_MAX_M}`);

    const segments = await findSpeedLimitSegmentsNearby(db, lat, lng, radius, env.COMMUNITY_CORRECTIONS_ENABLED);
    const signs = await findStaticSignsNearby(db, lat, lng, radius);
    const segmentCounts = await reportCounts(db, "speedLimitSegment", segments.map((s) => s.id));
    const signCounts = await reportCounts(db, "staticSign", signs.map((s) => s.id));

    const distanceToLine = (coords: [number, number][]): number => {
      let best = Infinity;
      for (let i = 0; i + 1 < coords.length; i += 1) best = Math.min(best, projectOnSegment([lng, lat], coords[i]!, coords[i + 1]!).distanceM);
      return best;
    };
    const items = [
      ...segments.map((s) => ({
        targetType: "speedLimitSegment" as const,
        targetId: s.id,
        distanceMeters: Math.round(distanceToLine((s.geometry as { coordinates: [number, number][] }).coordinates)),
        speedLimit: s.speedLimit,
        speedLimitUnit: s.speedLimitUnit,
        source: s.source,
        geometry: s.geometry,
        reports: segmentCounts.get(s.id) ?? 0,
      })),
      ...signs.map((s) => ({
        targetType: "staticSign" as const,
        targetId: s.id,
        distanceMeters: Math.round(
          Math.hypot(
            ((s.position as { coordinates: [number, number] }).coordinates[1] - lat) * 111_320,
            ((s.position as { coordinates: [number, number] }).coordinates[0] - lng) * 111_320 * Math.cos((lat * Math.PI) / 180),
          ),
        ),
        signType: s.signType,
        source: s.source,
        position: s.position,
        reports: signCounts.get(s.id) ?? 0,
      })),
    ]
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, NEAR_MAX_ITEMS)
      .map((item) => ({ ...item, threshold: env.DEFECT_REMOVAL_THRESHOLD }));
    return { items };
  });

  app.post("/v1/data-defects", async (req, reply) => {
    const body = reportBodySchema.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid request body", body.error.issues);
    const sub = req.auth!.sub;
    const client = await findClientByClientId(db, sub);
    const boundKey = client && !client.revokedAt ? client.devicePublicKey : null;
    const reporterId = boundKey ? deviceReporterId(boundKey) : `local:${sub}`;

    const outcome = await reportDefect(db, env, {
      type: body.data.targetType,
      id: body.data.targetId,
      reporterId,
      submittedBy: sub,
      reason: body.data.reason ?? null,
    });
    // the removal was appended as events inside the transaction; subscribers hear about it now it has committed
    for (const event of outcome.events) publishEvent(app.realtime, event);
    reply.status(outcome.recorded ? 201 : 200);
    return { recorded: outcome.recorded, reports: outcome.reports, threshold: outcome.threshold, removed: outcome.removed };
  });
}
