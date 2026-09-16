import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import type { ClientScope } from "../../config/constants.js";

export interface ClientRow {
  id: string;
  clientId: string;
  clientSecretHash: string;
  scopes: ClientScope[];
  name: string;
  revokedAt: string | null;
}

interface Row extends Record<string, unknown> {
  id: string;
  client_id: string;
  client_secret_hash: string;
  scopes: ClientScope[];
  name: string;
  revoked_at: string | null;
}

function toApi(row: Row): ClientRow {
  return {
    id: row.id,
    clientId: row.client_id,
    clientSecretHash: row.client_secret_hash,
    scopes: row.scopes,
    name: row.name,
    revokedAt: row.revoked_at,
  };
}

export async function findClientByClientId(db: Queryable, clientId: string): Promise<ClientRow | null> {
  const rows = await db.execute<Row>(sql`
    select id, client_id, client_secret_hash, scopes, name, revoked_at
    from clients where client_id = ${clientId}
  `);
  const row = rows[0];
  return row ? toApi(row) : null;
}

export async function insertClient(
  db: Queryable,
  input: { clientId: string; clientSecretHash: string; scopes: ClientScope[]; name: string },
): Promise<ClientRow> {
  const rows = await db.execute<Row>(sql`
    insert into clients (client_id, client_secret_hash, scopes, name)
    values (${input.clientId}, ${input.clientSecretHash}, ${input.scopes}::client_scope[], ${input.name})
    returning id, client_id, client_secret_hash, scopes, name, revoked_at
  `);
  const row = rows[0];
  if (!row) throw new Error("insertClient: insert returned no row");
  return toApi(row);
}
