import postgres from "postgres";
import { drizzle, type PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";
import type { Env } from "../config/env.js";
import * as schema from "./schema/index.js";
import { installRawSqlTypeParsers } from "./raw-sql-types.js";

export type Database = ReturnType<typeof createDb>;

/**
 * Common base of both `db` and the `tx` handle inside `db.transaction(async (tx) => ...)`
 * — query helpers in db/queries/* accept this instead of the concrete `Database["db"]`
 * type so the same function works whether called at the top level or from inside
 * appendEvent's transaction (see db/append-event.ts and modules/sync/snapshot.service.ts).
 * Pinned to PostgresJsQueryResultHKT (not the abstract PgQueryResultHKT base) —
 * otherwise db.execute()'s return type loses its row-array shape and widens to
 * `unknown` at every call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Queryable = PgDatabase<PostgresJsQueryResultHKT, any, any>;

/** The `tx` handle inside `db.transaction(async (tx) => ...)` — what appendEvent() requires. Also a Queryable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Transaction = PgTransaction<PostgresJsQueryResultHKT, any, any>;

export function createDb(env: Pick<Env, "DATABASE_URL">) {
  const client = postgres(env.DATABASE_URL, {
    // Neon's pooled connection string (pgbouncer) doesn't support prepared
    // statements; disabling them here also works fine against a direct
    // connection or a local/self-hosted Postgres, so this is safe as a default
    // rather than something that needs to vary by target.
    prepare: false,
  });
  const db = drizzle(client, { schema });
  // Must come after drizzle(): see raw-sql-types.ts for why.
  installRawSqlTypeParsers(client);
  return { db, client };
}
