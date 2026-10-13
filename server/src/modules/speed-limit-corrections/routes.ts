import type { FastifyInstance } from "fastify";
import { cellsToMultiPolygon, isValidCell } from "h3-js";
import { z } from "zod";
import { CORRECTION_REASONS, CORRECTION_STATUSES, SPEED_LIMIT_UNITS, type CorrectionReason, type CorrectionStatus } from "../../config/constants.js";
import type { Env } from "../../config/env.js";
import type { Queryable } from "../../db/client.js";
import { findClientByClientId } from "../../db/queries/clients.js";
import { listCorrections } from "../../db/queries/speed-limit-corrections.js";
import { findSpeedLimitSegmentById, type SpeedLimitSegmentApi } from "../../db/queries/speed-limit-segments.js";
import { ApiError, badRequest, notFound, unprocessable } from "../../lib/errors.js";
import { findSegmentsUnder, type CoveredSegment } from "../../db/queries/speed-limit-gaps.js";
import { stretchGeoJson, stretchOfInterval } from "./stretch.js";
import { RoadResolveError, resolveInterval } from "../roads/resolve.js";
import { parseCsv } from "../../lib/query-params.js";
import { isFreshTimestamp } from "../crypto/envelope.js";
import { computeFederationEventId } from "../federation/device-event.js";
import { broadcastSpeedLimitVotes } from "../federation/broadcast.js";
import { publishEvent } from "../realtime/publisher.js";
import { castLocalVote, loadCorrectionTarget, targetOfSegment, type CastVoteResult, type LocalCaller } from "./service.js";
import {
  deviceReporterId,
  speedLimitVoteEnvelopeSchema,
  verifySpeedLimitVoteEnvelope,
  type SpeedLimitVoteEnvelope,
} from "./vote.js";

const DEVICE_ASSERTION_FRESHNESS_SECONDS = 60;
const LIST_MAX_TILES = 100;
const LIST_DEFAULT_LIMIT = 200;
const LIST_MAX_LIMIT = 1000;

const idParamSchema = z.object({ id: z.string().uuid() });

const proposeBodySchema = z.object({
  value: z.number().int(),
  unit: z.enum(SPEED_LIMIT_UNITS),
  reason: z.enum(CORRECTION_REASONS).optional(),
  // Optional, exactly like a hazard report's: a client whose device has bound a
  // key (POST /v1/devices/bind-key) signs the vote itself, which is what makes
  // it eligible for federation. Without it the vote counts on this server only.
  deviceAssertion: speedLimitVoteEnvelopeSchema.optional(),
});

const pointSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

// A limit for a stretch of road (docs/road-network.md): two points picked on a road. The node finds the road and the road's own
// shape between the points; the visitor names no direction and no segment. Used for a road the import has no limit for and to
// replace a limit that is wrong on part of a road.
const intervalBodySchema = z.object({
  from: pointSchema,
  to: pointSchema,
  value: z.number().int(),
  unit: z.enum(SPEED_LIMIT_UNITS),
  reason: z.enum(CORRECTION_REASONS).optional(),
  deviceAssertion: speedLimitVoteEnvelopeSchema.optional(),
});

/** What of the road under a stretch already carries one and the same limit (>= 90 % of its length): a proposal for that value changes nothing. */
function uniformLimit(covered: CoveredSegment[], lengthM: number): { value: number; unit: "kmh" | "mph" } | null {
  const sums = new Map<string, number>();
  for (const c of covered) sums.set(`${c.speedLimit}|${c.unit}`, (sums.get(`${c.speedLimit}|${c.unit}`) ?? 0) + c.coveredMeters);
  for (const [key, meters] of sums) {
    if (meters >= lengthM * 0.9) {
      const [value, unit] = key.split("|");
      return { value: Number(value), unit: unit as "kmh" | "mph" };
    }
  }
  return null;
}

const confirmBodySchema = z.object({
  kind: z.enum(["confirm", "deny"]),
  deviceAssertion: speedLimitVoteEnvelopeSchema.optional(),
});

/**
 * Who this caller votes as (docs D10). A caller whose client has a bound
 * device key is always that device — signed or not — so one physical device
 * can never count twice. A signed vote must use exactly that bound key: a
 * client could otherwise generate as many keys, i.e. "distinct devices", as it likes.
 */
async function resolveCaller(db: Queryable, sub: string, assertion: SpeedLimitVoteEnvelope | undefined): Promise<LocalCaller> {
  const client = await findClientByClientId(db, sub);
  const boundKey = client && !client.revokedAt ? client.devicePublicKey : null;
  if (assertion && (!boundKey || boundKey !== assertion.payload.devicePublicKey)) {
    throw new ApiError(
      403,
      "DEVICE_KEY_NOT_BOUND",
      "deviceAssertion must be signed with the device key bound to this client (POST /v1/devices/bind-key)",
    );
  }
  return { sub, reporterId: boundKey ? deviceReporterId(boundKey) : `local:${sub}` };
}

function verifyAssertion(
  envelope: SpeedLimitVoteEnvelope,
  expected: { vote: "support" | "deny"; segmentKey: string | readonly string[]; value: number; unit: string; reason: CorrectionReason | null },
) {
  const p = envelope.payload;
  const acceptedKeys = typeof expected.segmentKey === "string" ? [expected.segmentKey] : expected.segmentKey;
  if (
    p.vote !== expected.vote ||
    !acceptedKeys.includes(p.segmentKey) ||
    p.value !== expected.value ||
    p.unit !== expected.unit ||
    (p.reason ?? null) !== expected.reason
  ) {
    throw badRequest("deviceAssertion.payload does not match the submitted vote");
  }
  if (!verifySpeedLimitVoteEnvelope(envelope)) {
    throw badRequest("deviceAssertion signature does not verify against its own claimed devicePublicKey");
  }
  if (!isFreshTimestamp(p.timestamp, DEVICE_ASSERTION_FRESHNESS_SECONDS)) {
    throw badRequest("deviceAssertion timestamp is stale or invalid");
  }
  return { voteId: computeFederationEventId(envelope), voteTimestamp: new Date(p.timestamp), envelope, originNodeId: null } as const;
}

/** The segment as a client needs it right after voting — without the (large) geometry. */
function segmentSummary(segment: SpeedLimitSegmentApi): Omit<SpeedLimitSegmentApi, "geometry"> {
  const summary: Partial<SpeedLimitSegmentApi> = { ...segment };
  delete summary.geometry;
  return summary as Omit<SpeedLimitSegmentApi, "geometry">;
}

function parseStatuses(raw: unknown): CorrectionStatus[] {
  if (raw === undefined) return ["proposed", "applied"];
  const statuses = parseCsv(raw) ?? [];
  const invalid = statuses.filter((s) => !(CORRECTION_STATUSES as readonly string[]).includes(s));
  if (statuses.length === 0 || invalid.length > 0) {
    throw badRequest(`status must be a comma-separated list of: ${CORRECTION_STATUSES.join(", ")}`);
  }
  return statuses as CorrectionStatus[];
}

function parseLimit(raw: unknown): number {
  const parsed = z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT).safeParse(raw);
  if (!parsed.success) throw badRequest(`limit must be an integer between 1 and ${LIST_MAX_LIMIT}`);
  return parsed.data;
}

/** Union of the given H3 cells as a GeoJSON MultiPolygon — the spatial filter for `?tiles=`, so no tile column has to be stored. */
function tilesToArea(tiles: string[]): unknown {
  if (tiles.length > LIST_MAX_TILES) throw badRequest(`at most ${LIST_MAX_TILES} tiles per request`);
  if (!tiles.every((t) => isValidCell(t))) throw badRequest("tiles must be valid H3 cell ids");
  return { type: "MultiPolygon", coordinates: cellsToMultiPolygon(tiles, true) };
}

function respond(app: FastifyInstance, reply: { status: (code: number) => unknown }, result: CastVoteResult, signed: SpeedLimitVoteEnvelope | undefined) {
  for (const event of result.events) publishEvent(app.realtime, event);
  if (signed && result.recorded) broadcastSpeedLimitVotes(app, [signed], null);
  reply.status(result.recorded && !result.merged ? 201 : 200);
  return {
    correction: result.correction,
    recorded: result.recorded,
    merged: result.merged,
    // null while a road without a limit on record is still below its threshold: there is no segment yet
    segment: result.segment ? segmentSummary(result.segment) : null,
  };
}

/**
 * Only registered when COMMUNITY_CORRECTIONS_ENABLED (see app.ts) — with the
 * feature off these endpoints don't exist, the same way the federation
 * endpoints don't on an isolated server.
 */
export async function registerSpeedLimitCorrectionRoutes(app: FastifyInstance) {
  const env: Env = app.deps.env;
  const db = app.deps.db;

  app.post("/v1/speed-limit-segments/:id/corrections", async (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) throw badRequest("Segment id must be a UUID");
    const body = proposeBodySchema.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid request body", body.error.issues);
    const input = body.data;

    const segment = await findSpeedLimitSegmentById(db, params.data.id, true);
    if (!segment) throw notFound(`No speed-limit segment with id ${params.data.id}`);

    const assertion = input.deviceAssertion as SpeedLimitVoteEnvelope | undefined;
    const caller = await resolveCaller(db, req.auth!.sub, assertion);
    const signed = assertion
      ? verifyAssertion(assertion, { vote: "support", segmentKey: segment.segmentKey, value: input.value, unit: input.unit, reason: input.reason ?? null })
      : null;

    const result = await castLocalVote(db, env, {
      target: targetOfSegment(segment),
      kind: "support",
      value: input.value,
      unit: input.unit,
      reason: input.reason ?? null,
      caller,
      signed,
    });
    return respond(app, reply, result, result.recorded ? assertion : undefined);
  });

  app.post("/v1/speed-limit-corrections/:id/confirmations", async (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) throw badRequest("Correction id must be a UUID");
    const body = confirmBodySchema.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid request body", body.error.issues);
    const input = body.data;

    const { row, target } = await loadCorrectionTarget(db, env, params.data.id);
    const kind = input.kind === "confirm" ? "support" : "deny";

    const assertion = input.deviceAssertion as SpeedLimitVoteEnvelope | undefined;
    const caller = await resolveCaller(db, req.auth!.sub, assertion);
    const signed = assertion
      ? verifyAssertion(assertion, { vote: kind, segmentKey: target.segmentKey, value: row.value, unit: row.unit, reason: null })
      : null;

    const result = await castLocalVote(db, env, { target, kind, value: row.value, unit: row.unit, reason: null, caller, signed });
    return respond(app, reply, result, result.recorded ? assertion : undefined);
  });

  // A limit for a stretch of road, named by two points on it (docs/road-network.md). Several devices naming the same stretch
  // are one proposal; at the threshold it becomes the stretch of the road's own shape with the value on it - and replaces what the
  // import says under it. Editing a limit on part of a road is the same call.
  app.post("/v1/speed-limit-intervals", async (req, reply) => {
    const body = intervalBodySchema.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid request body", body.error.issues);
    const input = body.data;
    for (const p of [input.from, input.to]) {
      if (p.lat === 0 && p.lng === 0) throw badRequest("Position (0, 0) is rejected as implausible (\"null island\")");
    }

    let stretch;
    try {
      stretch = stretchOfInterval(await resolveInterval({ db, env, warn: (m, d) => app.log.warn({ detail: d }, m) }, input.from, input.to));
    } catch (error) {
      if (error instanceof RoadResolveError) throw unprocessable(error.code, error.message, error.details);
      throw error;
    }

    const covered = await findSegmentsUnder(db, stretch.coordinates);
    const uniform = uniformLimit(covered, stretch.lengthM ?? 0);

    const assertion = input.deviceAssertion as SpeedLimitVoteEnvelope | undefined;
    const caller = await resolveCaller(db, req.auth!.sub, assertion);
    const signed = assertion
      ? verifyAssertion(assertion, { vote: "support", segmentKey: [stretch.ref, stretch.segmentKey], value: input.value, unit: input.unit, reason: input.reason ?? null })
      : null;

    const result = await castLocalVote(db, env, {
      target: { segmentKey: stretch.segmentKey, unit: null, importedValue: uniform && uniform.unit === input.unit ? uniform.value : null, segment: null, gap: stretch },
      kind: "support",
      value: input.value,
      unit: input.unit,
      reason: input.reason ?? null,
      caller,
      signed,
    });
    for (const event of result.events) publishEvent(app.realtime, event);
    if (assertion && result.recorded) broadcastSpeedLimitVotes(app, [assertion], null);
    reply.status(result.recorded && !result.merged ? 201 : 200);
    return {
      correction: result.correction,
      recorded: result.recorded,
      merged: result.merged,
      segment: result.segment ? segmentSummary(result.segment) : null,
      interval: {
        segmentKey: stretch.segmentKey,
        ref: stretch.ref,
        geometry: stretchGeoJson(stretch),
        lengthM: stretch.lengthM,
        road: { name: stretch.roadName, ref: stretch.roadRef, class: stretch.roadClass },
        replaces: covered,
      },
    };
  });

  // Discovery of open proposals and applied corrections. One of tiles / segmentId
  // is required so this can never be turned into an unbounded dump.
  app.get("/v1/speed-limit-corrections", async (req) => {
    const query = req.query as Record<string, unknown>;
    const statuses = parseStatuses(query.status);
    const limit = parseLimit(query.limit);
    const tiles = parseCsv(query.tiles);
    if (tiles && tiles.length > 0) {
      return { corrections: await listCorrections(db, { statuses, area: tilesToArea(tiles), limit }) };
    }
    if (typeof query.segmentId === "string") {
      const parsed = z.string().uuid().safeParse(query.segmentId);
      if (!parsed.success) throw badRequest("segmentId must be a UUID");
      const segment = await findSpeedLimitSegmentById(db, parsed.data, true);
      if (!segment) throw notFound(`No speed-limit segment with id ${parsed.data}`);
      return { corrections: await listCorrections(db, { statuses, segmentKey: segment.segmentKey, limit }) };
    }
    throw badRequest("Provide tiles (comma-separated H3 cell ids) or segmentId");
  });

  app.get("/v1/speed-limit-segments/:id/corrections", async (req) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) throw badRequest("Segment id must be a UUID");
    const query = req.query as Record<string, unknown>;
    const segment = await findSpeedLimitSegmentById(db, params.data.id, true);
    if (!segment) throw notFound(`No speed-limit segment with id ${params.data.id}`);
    const corrections = await listCorrections(db, {
      statuses: parseStatuses(query.status),
      segmentKey: segment.segmentKey,
      limit: LIST_MAX_LIMIT,
    });
    return { segment: segmentSummary(segment), corrections };
  });
}
