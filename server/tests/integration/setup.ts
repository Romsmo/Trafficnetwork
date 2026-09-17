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
 *
 * Migrations run on a throwaway connection that's closed immediately after,
 * mirroring the real `db:migrate` step running in its own process before the
 * server ever connects (see db/migrate.ts). postgres.js discovers array-typed
 * OIDs (needed to parse e.g. the enum-array `scopes` column) only once per
 * connection, at first use — running migrations and test queries on the same
 * long-lived connection would have it cache that discovery from before the
 * migrations created those enum types, leaving array columns unparsed.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("postgis/postgis:16-3.4").start();
  const connectionUri = container.getConnectionUri();

  const migrationConnection = createDb({ DATABASE_URL: connectionUri });
  await migrate(migrationConnection.db, { migrationsFolder: "./src/db/migrations" });
  await migrationConnection.client.end();

  const { db, client } = createDb({ DATABASE_URL: connectionUri });

  return {
    db,
    container,
    teardown: async () => {
      await client.end();
      await container.stop();
    },
  };
}
