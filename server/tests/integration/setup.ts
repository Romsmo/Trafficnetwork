import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, type Database } from "../../src/db/client.js";

export interface TestDatabase {
  db: Database["db"];
  container: StartedPostgreSqlContainer;
  teardown: () => Promise<void>;
}

/**
 * Starts a fresh postgis/postgis container and runs every migration against it,
 * so integration tests exercise the same schema path a real deploy does rather
 * than a hand-assembled test schema. One container per test file (see
 * vitest.config.ts's generous hookTimeout — image pull + boot can be slow on a
 * cold Docker cache).
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("postgis/postgis:16-3.4").start();
  const { db, client } = createDb({ DATABASE_URL: container.getConnectionUri() });

  await migrate(db, { migrationsFolder: "./src/db/migrations" });

  return {
    db,
    container,
    teardown: async () => {
      await client.end();
      await container.stop();
    },
  };
}
