import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";

export async function getStaticDataVersion(db: Queryable): Promise<number> {
  const rows = await db.execute<{ version: number } & Record<string, unknown>>(sql`
    select version from static_data_state where id = 1
  `);
  return rows[0]?.version ?? 1;
}

/**
 * Called from the same transaction as the write that changes static data —
 * see db/append-event.ts (StaticDataUpdated/StaticDataRemoved) and
 * db/queries/bulk-import.ts — so a rolled-back write never leaves the version
 * bumped with nothing to show for it.
 */
export async function bumpStaticDataVersion(db: Queryable): Promise<number> {
  const rows = await db.execute<{ version: number } & Record<string, unknown>>(sql`
    update static_data_state set version = version + 1 where id = 1
    returning version
  `);
  const version = rows[0]?.version;
  if (version === undefined) throw new Error("bumpStaticDataVersion: static_data_state row missing (id=1)");
  return version;
}
