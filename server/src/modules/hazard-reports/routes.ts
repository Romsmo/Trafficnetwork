import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findHazardReportsByTiles, findHazardReportsNearby } from "../../db/queries/hazard-reports.js";
import { HAZARD_TYPES, NON_CAMERA_HAZARD_TYPES, type HazardType } from "../../config/constants.js";
import { expandTile } from "../../lib/h3.js";
import { parseHazardTypes, parseLatLng, parseRadiusM } from "../../lib/query-params.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { confirmReport, createOrMergeReport } from "./service.js";
import { createOrMergeFixedCamera } from "../cameras/service.js";
import { isCameraType } from "../cameras/filter.js";
import { mayShowCamera, respondToCameraCreate } from "../cameras/write-response.js";
import { eventMayLeaveNode } from "../cameras/policy/events.js";
import { publishEvent } from "../realtime/publisher.js";
import { isFreshTimestamp, type SignedEnvelope } from "../crypto/envelope.js";
import { computeFederationEventId, verifyDeviceCreateEnvelope, type DeviceCreateEventPayload } from "../federation/device-event.js";
import { broadcastFederationEvents } from "../federation/broadcast.js";
import { federationEventExists } from "../../db/queries/event-log.js";

const DEVICE_ASSERTION_FRESHNESS_SECONDS = 60;

// .passthrough(): same rationale as every signed-payload schema since F-S2
// (see modules/auth/routes.ts's deviceTokenBodySchema comment) — reaches
// verification exactly as the signing device canonicalized it.
const deviceAssertionSchema = z.object({
  payload: z
    .object({
      kind: z.literal("create"),
      type: z.enum(HAZARD_TYPES),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      speedKmh: z.number().optional(),
      devicePublicKey: z.string().min(1),
      timestamp: z.string(),
    })
    .passthrough(),
  keyId: z.string(),
  signature: z.string(),
});

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
    // Optional (F-S3): a client whose device has bound a key (POST
    // /v1/devices/bind-key) can additionally sign the report content itself,
    // not just the transport/auth. This is what makes the resulting event
    // eligible for federation replication (modules/federation/*) — see
    // docs/threat-model.md's "Vertraue Signaturen, nicht Servern". Reports
    // submitted without it are stored and served locally exactly as before,
    // just never propagated to other servers.
    deviceAssertion: deviceAssertionSchema.optional(),
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
    // Also out of scope for device-content-signing/federation this milestone
    // (see modules/federation/device-event.ts) — deviceAssertion is ignored here.
    if (input.type === "fixedSpeedCamera") {
      const cameraResult = await createOrMergeFixedCamera(app.deps.db, app.deps.env, {
        lat: input.lat,
        lng: input.lng,
        reporterId,
      });
      publishEvent(app.realtime, cameraResult.event);
      return respondToCameraCreate(app, reply, cameraResult.camera, cameraResult.merged, "camera");
    }

    let federation: { federationEventId: string; federationEnvelope: unknown; originNodeId: null } | undefined;
    let broadcastEnvelope: SignedEnvelope<DeviceCreateEventPayload> | undefined;
    if (input.deviceAssertion) {
      const envelope = input.deviceAssertion as SignedEnvelope<DeviceCreateEventPayload>;
      const p = envelope.payload;
      if (p.type !== input.type || p.lat !== input.lat || p.lng !== input.lng || (p.speedKmh ?? null) !== (input.speedKmh ?? null)) {
        throw badRequest("deviceAssertion.payload does not match the submitted report fields");
      }
      if (!verifyDeviceCreateEnvelope(envelope)) {
        throw badRequest("deviceAssertion signature does not verify against its own claimed devicePublicKey");
      }
      if (!isFreshTimestamp(p.timestamp, DEVICE_ASSERTION_FRESHNESS_SECONDS)) {
        throw badRequest("deviceAssertion timestamp is stale or invalid");
      }
      const federationEventId = computeFederationEventId(envelope);
      if (await federationEventExists(app.deps.db, federationEventId)) {
        // Same signed content resubmitted (e.g. a client retrying after a
        // dropped response) — the signature is deterministic, so it hashes
        // to the same federationEventId every time. Reject as a conflict
        // rather than letting the event_log UNIQUE constraint throw.
        throw conflict("DUPLICATE_FEDERATION_EVENT", "This exact signed report has already been recorded");
      }
      federation = { federationEventId, federationEnvelope: envelope, originNodeId: null };
      broadcastEnvelope = envelope;
    }

    const result = await createOrMergeReport(
      app.deps.db,
      app.deps.env,
      { type: input.type, lat: input.lat, lng: input.lng, speedKmh: input.speedKmh, reporterId },
      federation ? { federation } : undefined,
    );
    publishEvent(app.realtime, result.event);
    // Peers get the signed report with its exact coordinates: a camera report goes out only where the camera may be delivered individually.
    if (broadcastEnvelope && eventMayLeaveNode(app.cameraPolicy.current(), result.event)) {
      broadcastFederationEvents(app, [broadcastEnvelope], null);
    }
    if (isCameraType(input.type)) return respondToCameraCreate(app, reply, result.report, result.merged, "report");
    reply.status(result.merged ? 200 : 201);
    return { report: result.report.item, merged: result.merged };
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
    // A camera report is shown back only where cameras are delivered individually (modules/cameras/write-response.ts).
    if (isCameraType(result.report.item.type) && !mayShowCamera(app, result.report)) return { recorded: result.recorded };
    return { report: result.report.item, recorded: result.recorded };
  });
}
