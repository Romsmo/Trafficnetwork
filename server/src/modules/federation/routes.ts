import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isFreshTimestamp, verifySignedEnvelope, type SignedEnvelope } from "../crypto/envelope.js";
import { keyId } from "../crypto/keys.js";
import { findPeerByNodeId, listPeers, recordInvalidSignature, recordPeerVersion, upsertPeer } from "../../db/queries/network-peers.js";
import { getFederationEventPage } from "./egress.js";
import { eventMayLeaveNode } from "../cameras/policy/events.js";
import { publishEvent } from "../realtime/publisher.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { joinRequestPayloadSchema, heartbeatPayloadSchema, type JoinRequestPayload, type HeartbeatPayload } from "./protocol.js";
import { ingestDeviceCreateEvent } from "./ingest.js";
import { currentReportExpiry } from "../expiry/rules.js";
import { computeFederationEventId, type DeviceCreateEventPayload } from "./device-event.js";
import { broadcastFederationEvents } from "./broadcast.js";
import { beginPush, endPush, getConcurrentPushes } from "./load.js";
import { isAcceptableFederationAddress } from "./address.js";
import { HAZARD_TYPES } from "../../config/constants.js";
import { getSignedVotesSince } from "../../db/queries/speed-limit-corrections.js";
import { ingestSpeedLimitVote } from "../speed-limit-corrections/ingest.js";
import { speedLimitVoteEnvelopeSchema, type SpeedLimitVoteEnvelope } from "../speed-limit-corrections/vote.js";
import { broadcastSpeedLimitVotes } from "./broadcast.js";

const JOIN_REQUEST_FRESHNESS_SECONDS = 300;
const HEARTBEAT_FRESHNESS_SECONDS = 300;
const PUSH_BATCH_MAX_EVENTS = 100;
const PULL_DEFAULT_LIMIT = 200;
const PULL_MAX_LIMIT = 500;

const envelopeSchema = <PayloadSchema extends z.ZodTypeAny>(payload: PayloadSchema) =>
  z.object({ payload, keyId: z.string(), signature: z.string() });

const joinEnvelopeSchema = envelopeSchema(joinRequestPayloadSchema);
const heartbeatEnvelopeSchema = envelopeSchema(heartbeatPayloadSchema);

// .passthrough(): same rationale as every other signed-payload schema since
// F-S2 (see modules/auth/routes.ts's deviceTokenBodySchema comment) — the
// payload must reach verification exactly as its signer canonicalized it.
const deviceCreateEventPayloadSchema = z
  .object({
    kind: z.literal("create"),
    type: z.enum(HAZARD_TYPES),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    speedKmh: z.number().optional(),
    devicePublicKey: z.string().min(1),
    timestamp: z.string(),
  })
  .passthrough();

const pushBodySchema = z.object({
  senderNodeId: z.string().min(1),
  events: z.array(envelopeSchema(deviceCreateEventPayloadSchema)).max(PUSH_BATCH_MAX_EVENTS).default([]),
  // Device-signed speed-limit votes (add-on K-A) — a separate field so a push
  // carrying them stays valid for a peer that predates the feature.
  speedLimitVotes: z.array(speedLimitVoteEnvelopeSchema).max(PUSH_BATCH_MAX_EVENTS).default([]),
});

function isExcluded(app: FastifyInstance, nodeId: string): boolean {
  return app.networkConfig?.payload.excludedNodeIds.includes(nodeId) ?? false;
}

export async function registerFederationRoutes(app: FastifyInstance) {
  app.post(
    "/v1/federation/join",
    // IP-based, same idea as POST /v1/auth/token's cap (a fresh Ed25519
    // keypair is free to generate, so nothing about the join request itself
    // is expensive to spam without this — docs/threat-model.md's Sybil-flood
    // mitigation; ASN-level limiting would need GeoIP/ASN infrastructure this
    // project doesn't have, so this is IP-only, a real but narrower cap). A
    // real join is rare even for a legitimate, actively-federating server
    // (seed bootstrap at startup, occasional re-join after a key/address
    // change) — 30/minute is already generous for that while still bounding
    // automated abuse, which would want orders of magnitude more than this.
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req) => {
      const parsed = joinEnvelopeSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest("Invalid join request", parsed.error.issues);
      const envelope = parsed.data as SignedEnvelope<JoinRequestPayload>;

      if (envelope.payload.nodeId !== keyId(envelope.payload.publicKey)) {
        throw badRequest("nodeId does not match keyId(publicKey)");
      }
      if (!verifySignedEnvelope(envelope, envelope.payload.publicKey)) {
        throw badRequest("Join request signature does not verify against its own claimed publicKey");
      }
      if (!isFreshTimestamp(envelope.payload.requestedAt, JOIN_REQUEST_FRESHNESS_SECONDS)) {
        throw badRequest("requestedAt is stale or invalid");
      }
      if (!isAcceptableFederationAddress(envelope.payload.address)) {
        throw badRequest("address must be an https:// URL (docs/threat-model.md: no self-hosted server identity over plain HTTP)");
      }
      if (envelope.payload.nodeId === app.nodeIdentity.nodeId) {
        throw badRequest("Cannot join to self");
      }
      if (isExcluded(app, envelope.payload.nodeId)) {
        throw forbidden("This node is excluded from the network by the signed network configuration");
      }

      await upsertPeer(app.deps.db, {
        nodeId: envelope.payload.nodeId,
        publicKey: envelope.payload.publicKey,
        address: envelope.payload.address,
        discoveredVia: "join",
      });

      const peers = await listPeers(app.deps.db);
      return {
        self: { nodeId: app.nodeIdentity.nodeId, publicKey: app.nodeIdentity.publicKeyRaw, federationEnabled: app.deps.env.FEDERATION_ENABLED },
        peers,
      };
    },
  );

  app.get("/v1/federation/peers", async () => {
    return { peers: await listPeers(app.deps.db) };
  });

  app.post("/v1/federation/heartbeat", async (req) => {
    const parsed = heartbeatEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid heartbeat", parsed.error.issues);
    const envelope = parsed.data as SignedEnvelope<HeartbeatPayload>;

    const peer = await findPeerByNodeId(app.deps.db, envelope.payload.nodeId);
    if (!peer) throw notFound("Unknown peer — join before sending heartbeats");
    if (isExcluded(app, envelope.payload.nodeId)) {
      throw forbidden("This node is excluded from the network by the signed network configuration");
    }
    // Verified against the *stored* key for this nodeId, not one the payload
    // claims — unlike join, a heartbeat doesn't get to assert its own identity.
    if (!verifySignedEnvelope(envelope, peer.publicKey)) {
      throw badRequest("Heartbeat signature does not verify against this peer's known publicKey");
    }
    if (!isFreshTimestamp(envelope.payload.timestamp, HEARTBEAT_FRESHNESS_SECONDS)) {
      throw badRequest("Heartbeat timestamp is stale or invalid");
    }

    // Single upsert covers both "peer moved address" and "no change" — always
    // touches lastSeenAt (see db/queries/network-peers.ts), which is the
    // actual point of a heartbeat either way.
    await upsertPeer(app.deps.db, {
      nodeId: peer.nodeId,
      publicKey: peer.publicKey,
      address: envelope.payload.address,
      discoveredVia: peer.discoveredVia,
    });
    // Self-reported metadata (version, and implicitly capacityHint — not
    // persisted, just available to an operator inspecting logs) — never fed
    // into reputation scoring on its own, see reputation.ts's header comment.
    await recordPeerVersion(app.deps.db, peer.nodeId, envelope.payload.version);
    // The peer's own head count (modules/online/) — a claim, kept in memory
    // only, used for the estimated network total and nothing else. Unusable
    // values are dropped silently; they never fail the heartbeat.
    if (envelope.payload.onlineCount !== undefined) app.online.recordPeerReport(peer.nodeId, envelope.payload.onlineCount);

    return { acknowledged: true };
  });

  app.post(
    "/v1/federation/events",
    // A joined peer's *events* are self-trusting (each carries its own
    // device signature — see the module-level comment), but nothing yet
    // bounds how often a joined peer can push (full reputation/overload
    // handling is F-S4). This IP-based cap is a coarse, proportionate stopgap
    // against a peer flooding fabricated-but-validly-self-signed events —
    // 60 requests/minute * 100 events/request (PUSH_BATCH_MAX_EVENTS) still
    // allows generous legitimate gossip/anti-entropy traffic.
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      // Overload signal (F-S4): a concurrency cap, not a rate limit — bounds
      // how much work this process is doing *right now* regardless of how
      // many distinct peers are pushing, so a legitimate flood from several
      // well-behaved peers at once degrades gracefully instead of piling up
      // unboundedly. Checked before doing any real work.
      if (getConcurrentPushes() >= app.deps.env.FEDERATION_OVERLOAD_MAX_CONCURRENT_PUSHES) {
        reply.header("Retry-After", "5");
        reply.status(503);
        return { error: { code: "OVERLOADED", message: "Too many concurrent federation event pushes — retry shortly" } };
      }

      const parsed = pushBodySchema.safeParse(req.body);
      if (!parsed.success) throw badRequest("Invalid federation event push", parsed.error.issues);
      const { senderNodeId, events, speedLimitVotes } = parsed.data;

      const sender = await findPeerByNodeId(app.deps.db, senderNodeId);
      if (!sender) throw forbidden("Unknown senderNodeId — join before pushing events");
      if (isExcluded(app, senderNodeId)) {
        throw forbidden("This node is excluded from the network by the signed network configuration");
      }

      beginPush();
      try {
        const results: { federationEventId: string; status: string; reason?: string; code?: string }[] = [];
        const toGossip: SignedEnvelope<DeviceCreateEventPayload>[] = [];

        for (const envelope of events as SignedEnvelope<DeviceCreateEventPayload>[]) {
          const outcome = await ingestDeviceCreateEvent(app.deps.db, app.deps.env, envelope, senderNodeId, currentReportExpiry(app));
          if (outcome.status === "rejected") {
            results.push({ federationEventId: outcome.federationEventId, status: outcome.status, reason: outcome.reason, code: outcome.code });
            if (outcome.code === "invalid_signature") {
              // See db/queries/network-peers.ts's recordInvalidSignature and
              // reputation.ts — the plan's "starkes Negativsignal" about
              // whoever pushed it, not about the report content itself.
              await recordInvalidSignature(app.deps.db, senderNodeId);
            }
            continue;
          }
          results.push({ federationEventId: outcome.federationEventId, status: outcome.status });
          if (outcome.status === "created" || outcome.status === "merged") {
            publishEvent(app.realtime, outcome.event);
            // A camera report is passed on only where this node delivers the individual camera (modules/cameras/policy/).
            if (eventMayLeaveNode(app.cameraPolicy.current(), outcome.event)) toGossip.push(envelope);
          }
        }

        broadcastFederationEvents(app, toGossip, senderNodeId);

        // Speed-limit votes (add-on K-A). With corrections switched off here they
        // are acknowledged as `ignored` — never stored, never gossiped on.
        const votesToGossip: SpeedLimitVoteEnvelope[] = [];
        for (const envelope of speedLimitVotes as SpeedLimitVoteEnvelope[]) {
          if (!app.deps.env.COMMUNITY_CORRECTIONS_ENABLED) {
            results.push({
              federationEventId: computeFederationEventId(envelope),
              status: "ignored",
              reason: "Community speed-limit corrections are switched off on this server",
            });
            continue;
          }
          const outcome = await ingestSpeedLimitVote(app.deps.db, app.deps.env, envelope, senderNodeId);
          if (outcome.status === "rejected") {
            results.push({ federationEventId: outcome.voteId, status: outcome.status, reason: outcome.reason, code: outcome.code });
            if (outcome.code === "invalid_signature") await recordInvalidSignature(app.deps.db, senderNodeId);
            continue;
          }
          results.push({ federationEventId: outcome.voteId, status: outcome.status });
          if (outcome.status === "recorded") {
            for (const event of outcome.events) publishEvent(app.realtime, event);
            votesToGossip.push(envelope);
          }
        }
        broadcastSpeedLimitVotes(app, votesToGossip, senderNodeId);

        return { results };
      } finally {
        endPush();
      }
    },
  );

  app.get("/v1/federation/events", async (req) => {
    const query = req.query as Record<string, unknown>;
    const afterResult = z.coerce.number().int().min(0).default(0).safeParse(query.after);
    const limitResult = z.coerce.number().int().min(1).max(PULL_MAX_LIMIT).default(PULL_DEFAULT_LIMIT).safeParse(query.limit);
    if (!afterResult.success || !limitResult.success) {
      throw badRequest("after/limit must be non-negative integers");
    }
    return getFederationEventPage(app.deps.db, app.cameraPolicy.current(), afterResult.data, limitResult.data);
  });

  // Pull stream of device-signed speed-limit votes (add-on K-A) — separate from
  // /events because votes are durable state that event-log retention never
  // purges, so a late-joining or long-partitioned peer catches up on all of
  // them. Not registered when corrections are off: the peer's pull worker
  // reads the resulting 404 as "not offered" and skips the stream quietly.
  if (app.deps.env.COMMUNITY_CORRECTIONS_ENABLED) {
    app.get("/v1/federation/speed-limit-votes", async (req) => {
      const query = req.query as Record<string, unknown>;
      const afterResult = z.coerce.number().int().min(0).default(0).safeParse(query.after);
      const limitResult = z.coerce.number().int().min(1).max(PULL_MAX_LIMIT).default(PULL_DEFAULT_LIMIT).safeParse(query.limit);
      if (!afterResult.success || !limitResult.success) {
        throw badRequest("after/limit must be non-negative integers");
      }
      return getSignedVotesSince(app.deps.db, afterResult.data, limitResult.data);
    });
  }
}
