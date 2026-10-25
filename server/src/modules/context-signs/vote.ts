import { z } from "zod";
import { verifySignedEnvelope, type SignedEnvelope } from "../crypto/envelope.js";
import { keyId } from "../crypto/keys.js";
import { ENTRY_KEY_PATTERN, type ContextSignDescriptor } from "./descriptor.js";

/**
 * The device-signed vote on a context sign (docs/context-signs.md D9) - the federation counterpart of a speed-limit vote. A
 * `support` vote carries the whole descriptor (it is how an entry is proposed and how a node that has never seen it learns what
 * it is); a `deny` vote may name just the key. The signature covers the payload, so a relay cannot change what a device meant.
 */
export interface ContextSignVotePayload {
  kind: "contextSignVote";
  vote: "support" | "deny";
  entryKey: string;
  /** Required for `support`; its hash must equal `entryKey`. */
  entry?: ContextSignDescriptor;
  /** The signing device's own Ed25519 public key - self-certifying. */
  devicePublicKey: string;
  timestamp: string;
}

// .passthrough(): the payload must reach verification exactly as its signer canonicalised it (see the other signed-payload schemas).
export const contextSignVotePayloadSchema = z
  .object({
    kind: z.literal("contextSignVote"),
    vote: z.enum(["support", "deny"]),
    entryKey: z.string().regex(ENTRY_KEY_PATTERN),
    entry: z.object({}).passthrough().optional(),
    devicePublicKey: z.string().min(1),
    timestamp: z.string(),
  })
  .passthrough();

export const contextSignVoteEnvelopeSchema = z.object({
  payload: contextSignVotePayloadSchema,
  keyId: z.string(),
  signature: z.string(),
});

export type ContextSignVoteEnvelope = SignedEnvelope<ContextSignVotePayload>;

/** The signature verifies against the key the payload itself names. */
export function verifyContextSignVoteEnvelope(envelope: ContextSignVoteEnvelope): boolean {
  if (envelope.payload.kind !== "contextSignVote") return false;
  return verifySignedEnvelope(envelope, envelope.payload.devicePublicKey);
}

/** Reporter identity of a device on every server: derived from the key alone, so all servers agree who "the same device" is. */
export function deviceReporterId(devicePublicKey: string): string {
  return `device:${keyId(devicePublicKey)}`;
}
