import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";

/**
 * Queries behind the join codes (docs/join-code.md). A join code is an ordinary `clients` row with kind 'join-public' or
 * 'join-invite' and the single scope `device-registration`; the devices registered with it point back at it through
 * registered_by_client_id, which is also what `useCount` counts - so the count is always the truth, never a stored counter.
 */

export type JoinKind = "join-public" | "join-invite";

export interface JoinCodeRow {
  /** Internal uuid (the FK the registered devices carry). */
  id: string;
  clientId: string;
  kind: JoinKind;
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  maxUses: number | null;
  useCount: number;
}

interface Row extends Record<string, unknown> {
  id: string;
  client_id: string;
  kind: JoinKind;
  label: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  max_uses: number | null;
  use_count: number;
}

const toApi = (row: Row): JoinCodeRow => ({
  id: row.id,
  clientId: row.client_id,
  kind: row.kind,
  label: row.label,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  maxUses: row.max_uses,
  useCount: row.use_count,
});

const SELECT = sql`
  select c.id, c.client_id, c.kind, c.label, c.created_at, c.expires_at, c.revoked_at, c.max_uses,
         (select count(*)::int from clients d where d.registered_by_client_id = c.id) as use_count
  from clients c
`;

/** Serialises everything that creates or replaces the public code (two nodes starting at once must not make two). */
export async function lockPublicJoinCode(tx: Queryable): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('joinCode:public', 0))`);
}

export async function insertJoinClient(
  db: Queryable,
  input: {
    clientId: string;
    clientSecretHash: string;
    kind: JoinKind;
    label: string | null;
    expiresAt: Date | null;
    maxUses: number | null;
  },
): Promise<void> {
  await db.execute(sql`
    insert into clients (client_id, client_secret_hash, scopes, name, kind, label, expires_at, max_uses)
    values (
      ${input.clientId}, ${input.clientSecretHash}, array['device-registration']::client_scope[],
      ${input.kind === "join-public" ? "join:public" : `join:${input.clientId}`},
      ${input.kind}, ${input.label}, ${input.expiresAt?.toISOString() ?? null}, ${input.maxUses}
    )
  `);
}

/** The public code in force: not revoked and not replaced (a replaced one has an expiry). Newest first if there is ever more than one. */
export async function findCurrentPublicJoinCode(db: Queryable): Promise<JoinCodeRow | null> {
  const rows = await db.execute<Row>(sql`
    ${SELECT} where c.kind = 'join-public' and c.revoked_at is null and c.expires_at is null
    order by c.created_at desc limit 1
  `);
  return rows[0] ? toApi(rows[0]) : null;
}

export async function findJoinCode(db: Queryable, clientId: string): Promise<JoinCodeRow | null> {
  const rows = await db.execute<Row>(sql`${SELECT} where c.client_id = ${clientId} and c.kind is not null`);
  return rows[0] ? toApi(rows[0]) : null;
}

export async function listJoinCodes(db: Queryable): Promise<JoinCodeRow[]> {
  const rows = await db.execute<Row>(sql`${SELECT} where c.kind is not null order by c.created_at desc`);
  return rows.map(toApi);
}

/** Ends a code now. Returns false when there is no such join code or it was revoked already. Devices registered with it stay valid. */
export async function revokeJoinCode(db: Queryable, clientId: string): Promise<boolean> {
  const rows = await db.execute<{ id: string } & Record<string, unknown>>(sql`
    update clients set revoked_at = now()
    where client_id = ${clientId} and kind is not null and revoked_at is null
    returning id
  `);
  return rows.length > 0;
}

/** Lets a replaced public code live until `until` (the end of its grace period). */
export async function setJoinCodeExpiry(db: Queryable, clientId: string, until: Date): Promise<void> {
  await db.execute(sql`update clients set expires_at = ${until.toISOString()} where client_id = ${clientId} and kind is not null`);
}

/** Registrations made with one code in the last 24 hours (the optional JOIN_CODE_MAX_REGISTRATIONS_PER_DAY). */
export async function countJoinRegistrationsInLastDay(db: Queryable, id: string): Promise<number> {
  const rows = await db.execute<{ total: number } & Record<string, unknown>>(sql`
    select count(*)::int as total from clients where registered_by_client_id = ${id} and created_at > now() - interval '1 day'
  `);
  return rows[0]?.total ?? 0;
}

/** Locks the code's row for the length of the transaction, so a limit check and the insert after it cannot interleave. */
export async function lockJoinCodeRow(tx: Queryable, id: string): Promise<void> {
  await tx.execute(sql`select 1 from clients where id = ${id} for update`);
}

export async function countJoinRegistrations(db: Queryable, id: string): Promise<number> {
  const rows = await db.execute<{ total: number } & Record<string, unknown>>(sql`
    select count(*)::int as total from clients where registered_by_client_id = ${id}
  `);
  return rows[0]?.total ?? 0;
}
