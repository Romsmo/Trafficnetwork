import type { Queryable } from "../../db/client.js";
import { getNodeIdentity, insertNodeIdentityIfAbsent } from "../../db/queries/node-identity.js";
import { generateEd25519KeyPair, keyId, type Ed25519KeyPair } from "../crypto/keys.js";

export interface NodeIdentity extends Ed25519KeyPair {
  /** = keyId(publicKeyRaw) — a short, stable identifier other servers reference this node by (F-S3+). */
  nodeId: string;
}

/**
 * Generates this server's own Ed25519 identity on first call and persists it,
 * or returns the existing one on every call after. Called once at server
 * startup (see src/server.ts) — every module that needs to sign something as
 * "this server" (heartbeats, join requests in F-S3) gets the identity handed
 * to it rather than re-deriving it, so there's exactly one load-or-create
 * race window per process lifetime, not one per call site.
 */
export async function loadOrCreateNodeIdentity(db: Queryable): Promise<NodeIdentity> {
  const existing = await getNodeIdentity(db);
  if (existing) {
    return { publicKeyRaw: existing.publicKey, privateKeyRaw: existing.privateKey, nodeId: keyId(existing.publicKey) };
  }

  const generated = generateEd25519KeyPair();
  await insertNodeIdentityIfAbsent(db, generated.publicKeyRaw, generated.privateKeyRaw);

  // Re-read rather than trusting `generated` directly — if another process
  // raced us, the insert was a no-op and the row already there is the real
  // identity this process must use too.
  const row = await getNodeIdentity(db);
  if (!row) throw new Error("loadOrCreateNodeIdentity: node_identity row missing immediately after insert");
  return { publicKeyRaw: row.publicKey, privateKeyRaw: row.privateKey, nodeId: keyId(row.publicKey) };
}
