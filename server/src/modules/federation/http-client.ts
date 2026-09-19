import type { SignedEnvelope } from "../crypto/envelope.js";
import type { NetworkPeerApi } from "../../db/queries/network-peers.js";
import type { DeviceCreateEventPayload } from "./device-event.js";
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
): Promise<PushEventsResponse> {
  return postJson<PushEventsResponse>(`${baseUrl}/v1/federation/events`, { senderNodeId, events }, timeoutMs);
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
