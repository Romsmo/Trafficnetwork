import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Env } from "../config/env.js";
import * as schema from "./schema/index.js";

export type Database = ReturnType<typeof createDb>;

export function createDb(env: Pick<Env, "DATABASE_URL">) {
  const client = postgres(env.DATABASE_URL, {
    // Neon's pooled connection string (pgbouncer) doesn't support prepared
    // statements; disabling them here also works fine against a direct
    // connection or a local/self-hosted Postgres, so this is safe as a default
    // rather than something that needs to vary by target.
    prepare: false,
  });
  const db = drizzle(client, { schema });
  return { db, client };
}
