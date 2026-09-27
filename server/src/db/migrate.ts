import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadEnv } from "../config/env.js";
import { createDb } from "./client.js";
import { heavyLockAnnotations, heavyMigrationNotice, type PendingMigration } from "./migration-locks.js";

// Resolved relative to this file's own location, not process.cwd() — so this
// works identically whether run via `tsx src/db/migrate.ts` in dev (resolves
// to src/db/migrations) or `node dist/db/migrate.js` in the production image
// (resolves to dist/db/migrations, populated by scripts/copy-build-assets.mjs
// during `npm run build`), regardless of the working directory it's launched
// from (e.g. a Docker entrypoint).
const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Prints a warning when a pending migration is annotated as lock-heavy (see migration-locks.ts),
 * with the current size of the table it locks. Purely informational: it never stops or fails the
 * migration.
 */
async function warnAboutHeavyMigrations(client: ReturnType<typeof createDb>["client"]): Promise<void> {
  try {
    const journal = JSON.parse(await readFile(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
      entries: { when: number; tag: string }[];
    };
    let lastApplied = -1;
    try {
      const rows = await client<{ created_at: string }[]>`
        select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
      if (rows[0]) lastApplied = Number(rows[0].created_at);
    } catch {
      // No migrations table yet: a fresh database, every migration is pending (and its tables are empty).
    }
    const pending: PendingMigration[] = [];
    for (const entry of journal.entries) {
      if (entry.when > lastApplied) {
        pending.push({ tag: entry.tag, sql: await readFile(path.join(migrationsFolder, `${entry.tag}.sql`), "utf8") });
      }
    }
    const rowsByTable = new Map<string, number | null>();
    for (const migration of pending) {
      for (const { table } of heavyLockAnnotations(migration.sql)) {
        if (rowsByTable.has(table)) continue;
        const found = await client<{ n: string }[]>`
          select reltuples::bigint::text as n from pg_class where oid = to_regclass(${`public.${table}`})`;
        const n = found[0] ? Number(found[0].n) : NaN;
        // reltuples is -1 until the table has been vacuumed or analyzed once.
        rowsByTable.set(table, Number.isFinite(n) && n >= 0 ? n : null);
      }
    }
    const notice = heavyMigrationNotice(pending, (table) => rowsByTable.get(table) ?? null);
    if (notice) console.warn(notice);
  } catch (err) {
    console.warn("Could not check the pending migrations for heavy locks (continuing):", err);
  }
}

async function main() {
  const env = loadEnv();
  const { db, client } = createDb(env);
  await warnAboutHeavyMigrations(client);
  console.log("Running migrations...");
  await migrate(db, { migrationsFolder });
  console.log("Migrations complete.");
  await client.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
