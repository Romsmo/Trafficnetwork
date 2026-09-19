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
  /** Set once this client has bound a device key via POST /v1/devices/bind-key — see schema/auth.ts. */
  devicePublicKey: string | null;
}

interface Row extends Record<string, unknown> {
  id: string;
  client_id: string;
  client_secret_hash: string;
  scopes: ClientScope[];
  name: string;
  revoked_at: string | null;
  registered_by_client_id: string | null;
  device_public_key: string | null;
}

const SELECT_COLUMNS = sql`id, client_id, client_secret_hash, scopes, name, revoked_at, registered_by_client_id, device_public_key`;

function toApi(row: Row): ClientRow {
  return {
    id: row.id,
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    scopes: row.scopes,
    name: row.name,
    revokedAt: row.revoked_at,
    registeredByClientId: row.registered_by_client_id,
    devicePublicKey: row.device_public_key,
  };
}

export async function findClientByClientId(db: Queryable, clientId: string): Promise<ClientRow | null> {
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS} from clients where client_id = ${clientId}
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
    returning ${SELECT_COLUMNS}
  `);
  const row = rows[0];
  if (!row) throw new Error("insertClient: insert returned no row");
  return toApi(row);
}

/**
 * One-shot: only sets the key if the client doesn't already have one bound
 * (WHERE device_public_key IS NULL) — key rotation is a deliberately
 * separate, not-yet-built flow (F-S2 scope is "bind once", per the F-S0
 * plan's migration path), not silent overwrite. Returns false if the client
 * didn't exist, was revoked, or already had a key bound.
 */
export async function bindDevicePublicKey(db: Queryable, clientId: string, publicKey: string): Promise<boolean> {
  const rows = await db.execute<{ id: string } & Record<string, unknown>>(sql`
    update clients set device_public_key = ${publicKey}
    where client_id = ${clientId} and revoked_at is null and device_public_key is null
    returning id
  `);
  return rows.length > 0;
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
