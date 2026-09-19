import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadEnv } from "../config/env.js";
import { createDb } from "./client.js";

// Resolved relative to this file's own location, not process.cwd() — so this
// works identically whether run via `tsx src/db/migrate.ts` in dev (resolves
// to src/db/migrations) or `node dist/db/migrate.js` in the production image
// (resolves to dist/db/migrations, populated by scripts/copy-build-assets.mjs
// during `npm run build`), regardless of the working directory it's launched
// from (e.g. a Docker entrypoint).
const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

async function main() {
  const env = loadEnv();
  const { db, client } = createDb(env);
  console.log("Running migrations...");
  await migrate(db, { migrationsFolder });
  console.log("Migrations complete.");
  await client.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
