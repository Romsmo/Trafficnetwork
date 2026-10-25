import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { isValidCell, getResolution } from "h3-js";
import { z } from "zod";
import type { Env } from "../../config/env.js";
import type { Queryable } from "../../db/client.js";
import { findClientByClientId } from "../../db/queries/clients.js";
import {
  countryNear,
  findEntry,
  findSimilarEntries,
  getVersion,
  listEntriesInBox,
  listEntriesNear,
  listEntriesOfTile,
  type EntryRow,
} from "../../db/queries/context-signs.js";
import { ApiError, badRequest, notFound, unprocessable } from "../../lib/errors.js";
import { parseCsv } from "../../lib/query-params.js";
import { isFreshTimestamp } from "../crypto/envelope.js";
import { broadcastContextSignVotes } from "../federation/broadcast.js";
import { computeFederationEventId } from "../federation/device-event.js";
import { RoadResolveError } from "../roads/resolve.js";
import { signInfo, SIGN_COUNT } from "./catalog.js";
import {
  DescriptorError,
  describeDescriptor,
  entryKeyOf,
  type ContextSignDescriptor,
  type ValidatedDescriptor,
  type Validity,
} from "./descriptor.js";
import { applyVote, type ApplyVoteResult } from "./service.js";
import { resolveOnePoint, resolveTwoPoints, shapeLiesOnRoad } from "./stretch.js";
import { proposeTimezone } from "./timezone.js";
import { WEB_REPORTER_PREFIX } from "./tally.js";
import { contextSignVoteEnvelopeSchema, deviceReporterId, verifyContextSignVoteEnvelope, type ContextSignVoteEnvelope } from "./vote.js";

const ASSERTION_FRESHNESS_SECONDS = 60;
const TILES_MAX = 50;
const LIST_DEFAULT = 200;

const pointSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const idParamSchema = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) });

const validityInputSchema = z
  .object({
    tz: z.string().min(3).max(64).optional(),
    windows: z.array(z.object({ days: z.array(z.number().int().min(1).max(7)).min(1), from: z.string(), to: z.string() })).max(8).optional(),
    period: z.object({ from: z.string(), to: z.string().nullable() }).optional(),
  })
  .optional();

const resolveBodySchema = z.object({
  signType: z.string().min(4).max(16),
  from: pointSchema,
  to: pointSchema.optional(),
  direction: z.enum(["along", "both"]).default("both"),
  /** Compass heading (degrees) of the direction of travel - for a sign at one place that applies one way. */
  heading: z.number().min(0).max(360).optional(),
  validity: validityInputSchema,
  value: z.number().finite().nullable().optional(),
  unit: z.enum(["t", "m"]).nullable().optional(),
});

const proposeBodySchema = z.object({
  descriptor: z.object({}).passthrough(),
  deviceAssertion: contextSignVoteEnvelopeSchema.optional(),
});

const voteBodySchema = z.object({
  kind: z.enum(["confirm", "deny"]),
  deviceAssertion: contextSignVoteEnvelopeSchema.optional(),
});

/** An entry as clients receive it. `id` is the key votes and signatures refer to. */
export function entryApi(e: EntryRow) {
  const d = e.descriptor;
  return {
    id: e.entryKey,
    signType: d.signType,
    geometry: d.geometry,
    direction: d.direction,
    validity: d.validity,
    value: d.value,
    unit: d.unit,
    lengthM: e.lengthM,
    status: e.status,
    confirmed: e.status === "confirmed",
    confirmations: e.supportCount,
    denials: e.denyCount,
    firstProposedAt: e.firstProposedAt,
    lastConfirmedAt: e.lastConfirmedAt,
    expiresAt: e.expiresAt,
  };
}

function toApiError(error: unknown): never {
  if (error instanceof DescriptorError) throw unprocessable(error.code, error.message);
  if (error instanceof RoadResolveError) throw unprocessable(error.code, error.message, error.details);
  throw error;
}

interface Caller {
  sub: string;
  reporterId: string;
}

/**
 * Who a vote counts as (docs D6). A client with a bound device key is that device, signed or not, so one physical device never
 * counts twice. A web visitor is `web:<session>` (the tally counts all visitors together as one voice). Anyone else is
 * `local:<client>`. A signed vote must use exactly the key bound to the calling client.
 */
async function resolveCaller(db: Queryable, sub: string, assertion: ContextSignVoteEnvelope | undefined): Promise<Caller> {
  const client = await findClientByClientId(db, sub);
  const boundKey = client && !client.revokedAt ? client.devicePublicKey : null;
  if (assertion && (!boundKey || boundKey !== assertion.payload.devicePublicKey)) {
    throw new ApiError(403, "DEVICE_KEY_NOT_BOUND", "deviceAssertion must be signed with the device key bound to this client (POST /v1/devices/bind-key)");
  }
  if (boundKey) return { sub, reporterId: deviceReporterId(boundKey) };
  if (sub.startsWith(WEB_REPORTER_PREFIX)) return { sub, reporterId: sub };
  return { sub, reporterId: `local:${sub}` };
}

function verifyAssertion(envelope: ContextSignVoteEnvelope, expected: { vote: "support" | "deny"; entryKey: string; descriptor: ContextSignDescriptor | null }) {
  const p = envelope.payload;
  if (p.vote !== expected.vote || p.entryKey !== expected.entryKey) throw badRequest("deviceAssertion.payload does not match the submitted vote");
  if (expected.vote === "support") {
    if (!p.entry || !expected.descriptor || entryKeyOf(p.entry as ContextSignDescriptor) !== expected.entryKey) {
      throw badRequest("deviceAssertion.payload.entry does not match the submitted sign");
    }
  }
  if (!verifyContextSignVoteEnvelope(envelope)) throw badRequest("deviceAssertion signature does not verify against its own claimed devicePublicKey");
  if (!isFreshTimestamp(p.timestamp, ASSERTION_FRESHNESS_SECONDS)) throw badRequest("deviceAssertion timestamp is stale or invalid");
  return { id: computeFederationEventId(envelope), timestamp: new Date(p.timestamp) };
}

export function describeContextSigns(env: Env, version: number) {
  return {
    enabled: env.CONTEXT_SIGNS_ENABLED,
    version,
    catalog: { countries: ["DE"], signCount: SIGN_COUNT },
    timezonePrefixes: env.CONTEXT_SIGNS_TIMEZONE_PREFIXES,
    confirmationsRequired: { prohibition: env.CONTEXT_SIGNS_CONFIRMATIONS_PROHIBITION, hazard: env.CONTEXT_SIGNS_CONFIRMATIONS_HAZARD },
    rateLimit: { proposalsPerDay: env.CONTEXT_SIGNS_PROPOSALS_PER_DAY, votesPerDay: env.CONTEXT_SIGNS_VOTES_PER_DAY },
  };
}

/** Context signs (docs/context-signs.md): resolve, propose, confirm/deny, list, tiles. Not registered when CONTEXT_SIGNS_ENABLED is false. */
export async function registerContextSignRoutes(app: FastifyInstance): Promise<void> {
  const db = app.deps.db;
  const env = app.deps.env;
  const limits = { timezonePrefixes: env.CONTEXT_SIGNS_TIMEZONE_PREFIXES };
  const roadDeps = () => ({ db, env, warn: (m: string, d?: unknown) => app.log.warn({ detail: d }, m) });

  // What the node makes of "this sign, here, like this": the stretch on the road, the normal form of the descriptor (what the
  // device will sign), and the entries it would be the same as or similar to (docs D5).
  app.post("/v1/context-signs/resolve", async (req) => {
    const body = resolveBodySchema.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid request body", body.error.issues);
    const input = body.data;
    const sign = signInfo(input.signType);
    if (!sign) throw unprocessable("UNKNOWN_SIGN", "This sign is not in the catalogue of this node");
    if (input.from.lat === 0 && input.from.lng === 0) throw badRequest('Position (0, 0) is rejected as implausible ("null island")');

    let stretch;
    try {
      if (input.to) stretch = await resolveTwoPoints(roadDeps(), input.from, input.to);
      else {
        if (!sign.pointLike) throw unprocessable("SIGN_NEEDS_TWO_POINTS", "This sign covers a stretch: pick where it starts and where it ends");
        if (input.direction === "along" && input.heading === undefined) {
          throw unprocessable("HEADING_REQUIRED", "A sign at one place that applies one way needs the direction of travel (heading)");
        }
        stretch = await resolveOnePoint(roadDeps(), input.from, input.direction, input.heading ?? null);
      }
    } catch (error) {
      toApiError(error);
    }

    const iso = await countryNear(db, stretch.coordinates[0]![0], stretch.coordinates[0]![1]);
    const tz = input.validity?.tz ?? proposeTimezone(iso, env.CONTEXT_SIGNS_TIMEZONE_PREFIXES, env.CONTEXT_SIGNS_DEFAULT_TIMEZONE);
    const validity: Validity = {
      v: 1,
      tz,
      ...(input.validity?.windows?.length ? { windows: input.validity.windows } : {}),
      ...(input.validity?.period ? { period: input.validity.period } : {}),
    };
    let described: ValidatedDescriptor;
    try {
      described = describeDescriptor(
        { v: 1, signType: input.signType, geometry: stretch.coordinates, direction: input.direction, validity, value: input.value ?? null, unit: input.value == null ? null : (input.unit ?? null) },
        limits,
      );
    } catch (error) {
      toApiError(error);
    }

    const similar = await findSimilarEntries(db, input.signType, described.descriptor.geometry);
    const existing = await findEntry(db, described.entryKey);
    return {
      descriptor: described.descriptor,
      entryKey: described.entryKey,
      lengthM: described.lengthM,
      road: stretch.road,
      timezone: tz,
      existing: existing && existing.status !== "removed" ? entryApi(existing) : null,
      similar: similar
        .filter((s) => s.entry.entryKey !== described.entryKey)
        .map((s) => ({
          entry: entryApi(s.entry),
          overlapOfNew: Math.round(s.overlapOfNew * 100) / 100,
          overlapOfEntry: Math.round(s.overlapOfEntry * 100) / 100,
          sameDirection: s.entry.descriptor.direction === described.descriptor.direction,
        })),
    };
  });

  // Proposing is voting "this applies" on the entry the descriptor names - several devices proposing the same thing are one entry.
  app.post("/v1/context-signs", async (req, reply) => {
    const body = proposeBodySchema.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid request body", body.error.issues);
    let described: ValidatedDescriptor;
    try {
      described = describeDescriptor(body.data.descriptor, limits);
    } catch (error) {
      toApiError(error);
    }
    // Never a sign that is not on a road this node knows (docs D8); an unknown area is refused, not guessed at.
    const onRoad = await shapeLiesOnRoad(roadDeps(), described.descriptor.geometry);
    if (onRoad === "no_road_data") throw unprocessable("NO_ROAD_DATA", "This node has no road data for that area");
    if (onRoad === "off_road") throw unprocessable("SHAPE_OFF_ROAD", "The stretch does not lie on a road this node knows");

    const assertion = body.data.deviceAssertion as ContextSignVoteEnvelope | undefined;
    const caller = await resolveCaller(db, req.auth!.sub, assertion);
    const signed = assertion ? verifyAssertion(assertion, { vote: "support", entryKey: described.entryKey, descriptor: described.descriptor }) : null;

    const result = await applyVote(
      db,
      env,
      {
        id: signed?.id ?? `local:${randomUUID()}`,
        kind: "support",
        validated: described,
        entryKey: described.entryKey,
        reporterId: caller.reporterId,
        submittedBy: caller.sub,
        voteTimestamp: signed?.timestamp ?? new Date(),
        envelope: assertion ?? null,
        originNodeId: null,
      },
      { local: true },
    );
    return respond(app, reply, result, assertion);
  });

  app.post("/v1/context-signs/:id/confirmations", async (req, reply) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) throw badRequest("Context sign id must be 32 hexadecimal characters");
    const body = voteBodySchema.safeParse(req.body);
    if (!body.success) throw badRequest("Invalid request body", body.error.issues);
    const entry = await findEntry(db, params.data.id);
    if (!entry || entry.status === "removed") throw notFound(`No context sign ${params.data.id}`);

    const kind = body.data.kind === "confirm" ? "support" : "deny";
    const assertion = body.data.deviceAssertion as ContextSignVoteEnvelope | undefined;
    const caller = await resolveCaller(db, req.auth!.sub, assertion);
    const signed = assertion ? verifyAssertion(assertion, { vote: kind, entryKey: entry.entryKey, descriptor: entry.descriptor }) : null;

    const result = await applyVote(
      db,
      env,
      {
        id: signed?.id ?? `local:${randomUUID()}`,
        kind,
        validated: kind === "support" ? describeDescriptor(entry.descriptor, limits) : null,
        entryKey: entry.entryKey,
        reporterId: caller.reporterId,
        submittedBy: caller.sub,
        voteTimestamp: signed?.timestamp ?? new Date(),
        envelope: assertion ?? null,
        originNodeId: null,
      },
      { local: true },
    );
    return respond(app, reply, result, assertion);
  });

  // Entries around a place or inside a box (the website's map layer, a client that is online).
  app.get("/v1/context-signs", async (req) => {
    const q = req.query as Record<string, unknown>;
    const limit = z.coerce.number().int().min(1).max(1000).default(LIST_DEFAULT).safeParse(q["limit"]);
    if (!limit.success) throw badRequest("limit must be an integer between 1 and 1000");
    const confirmedOnly = q["confirmed"] === "true";
    const keep = (e: EntryRow) => !confirmedOnly || e.status === "confirmed";
    const version = await getVersion(db);

    if (typeof q["bbox"] === "string") {
      const parts = q["bbox"].split(",").map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw badRequest("bbox must be west,south,east,north");
      const [west, south, east, north] = parts as [number, number, number, number];
      if (north - south > 2 || east - west > 3) throw badRequest("bbox is too large (at most 2 x 3 degrees)");
      return { version, entries: (await listEntriesInBox(db, { west, south, east, north }, limit.data)).filter(keep).map(entryApi) };
    }
    const lat = z.coerce.number().min(-90).max(90).safeParse(q["lat"]);
    const lng = z.coerce.number().min(-180).max(180).safeParse(q["lng"]);
    const radius = z.coerce.number().positive().max(50_000).default(5000).safeParse(q["radiusM"]);
    if (!lat.success || !lng.success || !radius.success) throw badRequest("Provide bbox, or lat, lng and radiusM (at most 50000)");
    return { version, entries: (await listEntriesNear(db, lat.data, lng.data, radius.data, limit.data)).filter(keep).map(entryApi) };
  });

  // The offline data: entries by H3 tile (the resolution of the static-data packages). `since` is the version the client holds;
  // while it is unchanged the answer is a few bytes.
  app.get("/v1/context-signs/tiles", async (req) => {
    const q = req.query as Record<string, unknown>;
    const tiles = parseCsv(q["tiles"]) ?? [];
    if (tiles.length === 0 || tiles.length > TILES_MAX) throw badRequest(`tiles must list 1 to ${TILES_MAX} H3 cell ids`);
    for (const tile of tiles) {
      if (!isValidCell(tile) || getResolution(tile) !== env.STATIC_DATA_PARTITION_H3_RESOLUTION) {
        throw badRequest(`${tile} is not an H3 cell of resolution ${env.STATIC_DATA_PARTITION_H3_RESOLUTION}`);
      }
    }
    const version = await getVersion(db);
    const since = z.coerce.number().int().optional().safeParse(q["since"]);
    if (since.success && since.data === version) return { version, unchanged: true, tiles: [] };
    const includeUnconfirmed = q["confirmed"] !== "true";
    const out = [];
    for (const tile of tiles) out.push({ tile, entries: (await listEntriesOfTile(db, tile, includeUnconfirmed)).map(entryApi) });
    return { version, unchanged: false, tiles: out };
  });

  app.get("/v1/context-signs/:id", async (req) => {
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) throw badRequest("Context sign id must be 32 hexadecimal characters");
    const entry = await findEntry(db, params.data.id);
    if (!entry || entry.status === "removed") throw notFound(`No context sign ${params.data.id}`);
    return { entry: entryApi(entry) };
  });
}

function respond(app: FastifyInstance, reply: { status: (code: number) => unknown }, result: ApplyVoteResult, assertion: ContextSignVoteEnvelope | undefined) {
  if (assertion && result.recorded) broadcastContextSignVotes(app, [assertion], null);
  reply.status(result.recorded ? (result.created ? 201 : 200) : 200);
  return {
    recorded: result.recorded,
    ...(result.noop ? { noop: result.noop } : {}),
    created: result.created,
    entry: result.entry ? entryApi(result.entry) : null,
  };
}
