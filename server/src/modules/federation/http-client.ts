import type { SignedEnvelope } from "../crypto/envelope.js";
import type { NetworkPeerApi } from "../../db/queries/network-peers.js";
import type { DeviceCreateEventPayload } from "./device-event.js";
import type { SpeedLimitVoteEnvelope } from "../speed-limit-corrections/vote.js";
import type { JoinRequestPayload, HeartbeatPayload } from "./protocol.js";

/**
 * Thin fetch wrapper for outbound peer-to-peer calls (join, heartbeat,
 * push, pull) — used by modules/federation/workers.ts and the push
 * handler's gossip fan-out in modules/federation/routes.ts. Every call is
 * best-effort: a peer being unreachable is an expected, routine condition in
 * an open federation (docs/federation.md), never a reason to crash the
 * caller — every function here throws on failure and every caller is
 * responsible for catching and logging, not propagating.
 */

async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface JoinResponse {
  self: { nodeId: string; publicKey: string; federationEnabled: boolean };
  peers: NetworkPeerApi[];
}

export async function requestJoin(baseUrl: string, envelope: SignedEnvelope<JoinRequestPayload>, timeoutMs: number): Promise<JoinResponse> {
  return postJson<JoinResponse>(`${baseUrl}/v1/federation/join`, envelope, timeoutMs);
}

export async function sendHeartbeat(baseUrl: string, envelope: SignedEnvelope<HeartbeatPayload>, timeoutMs: number): Promise<void> {
  await postJson(`${baseUrl}/v1/federation/heartbeat`, envelope, timeoutMs);
}

export interface PushEventsResponse {
  results: { federationEventId: string; status: string }[];
}

export async function pushEvents(
  baseUrl: string,
  senderNodeId: string,
  events: SignedEnvelope<DeviceCreateEventPayload>[],
  timeoutMs: number,
  /**
   * Device-signed speed-limit votes (add-on K-A). A separate field, and only
   * sent when there is something in it, so an older peer — whose schema simply
   * doesn't know the key — is never handed a body it would reject.
   */
  speedLimitVotes: SpeedLimitVoteEnvelope[] = [],
): Promise<PushEventsResponse> {
  const body = speedLimitVotes.length > 0 ? { senderNodeId, events, speedLimitVotes } : { senderNodeId, events };
  return postJson<PushEventsResponse>(`${baseUrl}/v1/federation/events`, body, timeoutMs);
}

export interface PullSpeedLimitVotesResponse {
  votes: { sequence: number; voteId: string; envelope: SpeedLimitVoteEnvelope; receivedAt: string }[];
  nextAfter: number | null;
}

/** Returns null when the peer doesn't offer the stream (older server, or corrections switched off there) — not an error, not a failed health check. */
export async function pullSpeedLimitVotes(
  baseUrl: string,
  after: number,
  limit: number,
  timeoutMs: number,
): Promise<PullSpeedLimitVotesResponse | null> {
  const url = `${baseUrl}/v1/federation/speed-limit-votes?after=${after}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }
  return (await res.json()) as PullSpeedLimitVotesResponse;
}

export interface PullEventsResponse {
  events: { sequence: number; federationEventId: string; envelope: SignedEnvelope<DeviceCreateEventPayload>; occurredAt: string }[];
  nextAfter: number | null;
}

export async function pullEvents(baseUrl: string, after: number, limit: number, timeoutMs: number): Promise<PullEventsResponse> {
  const url = `${baseUrl}/v1/federation/events?after=${after}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }
  return (await res.json()) as PullEventsResponse;
}
