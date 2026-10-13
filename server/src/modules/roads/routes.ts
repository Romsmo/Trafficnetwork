import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findSegmentsUnder } from "../../db/queries/speed-limit-gaps.js";
import { listCorrections } from "../../db/queries/speed-limit-corrections.js";
import { badRequest, unprocessable } from "../../lib/errors.js";
import { stretchGeoJson, stretchOfInterval } from "../speed-limit-corrections/stretch.js";
import { RoadResolveError, resolveInterval } from "./resolve.js";

const pointSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const resolveBodySchema = z.object({ from: pointSchema, to: pointSchema });

/**
 * `POST /v1/roads/resolve` (docs/road-network.md): which stretch of which road two picked points name - the preview a client
 * draws before anybody proposes a value, and the answer to "what is on record there already, and what is proposed".
 * Nothing is stored about the request (the lookup service may be asked for the area, once, and keeps nothing about who).
 */
export async function registerRoadRoutes(app: FastifyInstance): Promise<void> {
  const db = app.deps.db;
  const env = app.deps.env;

  app.post("/v1/roads/resolve", async (req) => {
    const body = resolveBodySchema.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid request body", body.error.issues);
    const { from, to } = body.data;
    for (const p of [from, to]) {
      if (p.lat === 0 && p.lng === 0) throw badRequest("Position (0, 0) is rejected as implausible (\"null island\")");
    }
    let stretch;
    try {
      stretch = stretchOfInterval(await resolveInterval({ db, env, warn: (m, d) => app.log.warn({ detail: d }, m) }, from, to));
    } catch (error) {
      if (error instanceof RoadResolveError) throw unprocessable(error.code, error.message, error.details);
      throw error;
    }
    const covered = await findSegmentsUnder(db, stretch.coordinates);
    const proposals = env.COMMUNITY_CORRECTIONS_ENABLED
      ? await listCorrections(db, { statuses: ["proposed", "applied"], segmentKey: stretch.segmentKey, limit: 20 })
      : [];
    return {
      ref: stretch.ref,
      segmentKey: stretch.segmentKey,
      geometry: stretchGeoJson(stretch),
      lengthM: stretch.lengthM,
      road: { name: stretch.roadName, ref: stretch.roadRef, class: stretch.roadClass },
      /** Limits on record under the stretch (what a proposal would replace). */
      covered,
      /** Proposals and applied values for exactly this stretch. */
      proposals,
    };
  });
}
