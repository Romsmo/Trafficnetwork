import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";

export interface NodeIdentityRow {
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

const SELF_ID = "self";

export async function getNodeIdentity(db: Queryable): Promise<NodeIdentityRow | null> {
  const rows = await db.execute<{ public_key: string; private_key: string; created_at: string } & Record<string, unknown>>(sql`
    select public_key, private_key, created_at from node_identity where id = ${SELF_ID}
  `);
  const row = rows[0];
  return row ? { publicKey: row.public_key, privateKey: row.private_key, createdAt: row.created_at } : null;
}

/**
 * Inserts only if no row exists yet (ON CONFLICT DO NOTHING) — cheap
 * insurance against two processes racing to create the identity on
 * simultaneous first boot; the caller always re-reads via getNodeIdentity()
 * afterward to find out which keypair actually won, rather than assuming its
 * own.
 */
export async function insertNodeIdentityIfAbsent(db: Queryable, publicKey: string, privateKey: string): Promise<void> {
  await db.execute(sql`
    insert into node_identity (id, public_key, private_key)
    values (${SELF_ID}, ${publicKey}, ${privateKey})
    on conflict (id) do nothing
  `);
}
