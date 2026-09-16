import "dotenv/config";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadEnv } from "../config/env.js";
import { createDb } from "./client.js";

async function main() {
  const env = loadEnv();
  const { db, client } = createDb(env);
  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("Migrations complete.");
  await client.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
