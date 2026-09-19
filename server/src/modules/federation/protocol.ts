import { z } from "zod";

/** Bumped only on a genuine wire-format break — separate from package.json's own version, which tracks the whole codebase, not just this protocol. */
export const FEDERATION_PROTOCOL_VERSION = "1";

/**
 * Self-signed with the joining server's own fresh/existing node key — per the
 * F-S0 plan's protocol sketch, "das Netz bürgt nicht für die Identität, nur
 * die spätere Reputation für das Verhalten" (F-S4). Verified by checking
 * nodeId === keyId(publicKey) and the signature against that same publicKey
 * — see modules/federation/routes.ts's join handler.
 */
export interface JoinRequestPayload {
  nodeId: string;
  publicKey: string;
  address: string;
  requestedAt: string;
}

export const joinRequestPayloadSchema = z
  .object({
    nodeId: z.string().min(1),
    publicKey: z.string().min(1),
    address: z.string().url(),
    requestedAt: z.string(),
  })
  .passthrough();

/**
 * Signed with the sender's node key, verified against the *stored* public
 * key for that nodeId (not a self-claimed one in the payload, unlike join) —
 * a heartbeat only ever updates liveness for an already-known peer.
 */
export interface HeartbeatPayload {
  nodeId: string;
  address: string;
  version: string;
  capacityHint?: number;
  timestamp: string;
}

export const heartbeatPayloadSchema = z
  .object({
    nodeId: z.string().min(1),
    address: z.string().url(),
    version: z.string().min(1),
    capacityHint: z.number().optional(),
    timestamp: z.string(),
  })
  .passthrough();
