import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import type { ClientScope } from "../../config/constants.js";
import { pgArray } from "../pg-array.js";

export interface ClientRow {
  id: string;
  clientId: string;
  clientSecretHash: string;
  scopes: ClientScope[];
  name: string;
  revokedAt: string | null;
  /** Set only for device credentials minted via POST /v1/devices/register — see schema/auth.ts. */
  registeredByClientId: string | null;
}

interface Row extends Record<string, unknown> {
  id: string;
  client_id: string;
  client_secret_hash: string;
  scopes: ClientScope[];
  name: string;
  revoked_at: string | null;
  registered_by_client_id: string | null;
}

function toApi(row: Row): ClientRow {
  return {
    id: row.id,
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    scopes: row.scopes,
    name: row.name,
    revokedAt: row.revoked_at,
    registeredByClientId: row.registered_by_client_id,
  };
}

export async function findClientByClientId(db: Queryable, clientId: string): Promise<ClientRow | null> {
  const rows = await db.execute<Row>(sql`
    select id, client_id, client_secret_hash, scopes, name, revoked_at, registered_by_client_id
    from clients where client_id = ${clientId}
  `);
  const row = rows[0];
  return row ? toApi(row) : null;
}

export async function insertClient(
  db: Queryable,
  input: {
    clientId: string;
    clientSecretHash: string;
    scopes: ClientScope[];
    name: string;
    registeredByClientId?: string;
  },
): Promise<ClientRow> {
  const rows = await db.execute<Row>(sql`
    insert into clients (client_id, client_secret_hash, scopes, name, registered_by_client_id)
    values (
      ${input.clientId}, ${input.clientSecretHash}, ${pgArray(input.scopes)}::client_scope[], ${input.name},
      ${input.registeredByClientId ?? null}
    )
    returning id, client_id, client_secret_hash, scopes, name, revoked_at, registered_by_client_id
  `);
  const row = rows[0];
  if (!row) throw new Error("insertClient: insert returned no row");
  return toApi(row);
}

/**
 * Rolling 24h count, for the per-app-key daily device-registration cap
 * (DEVICE_REGISTRATION_RATE_LIMIT_MAX_PER_DAY). `appId` is the app key's
 * internal `clients.id` (uuid) — the FK registered_by_client_id points at —
 * not its public `clientId` string.
 */
export async function countDevicesRegisteredInLastDay(db: Queryable, appId: string): Promise<number> {
  const rows = await db.execute<{ total: number } & Record<string, unknown>>(sql`
    select count(*)::int as total from clients
    where registered_by_client_id = ${appId}
      and created_at > now() - interval '1 day'
  `);
  return rows[0]?.total ?? 0;
}
