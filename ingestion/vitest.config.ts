import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests (added in P3.4) spin up a real server process against
    // a real Postgres/PostGIS and run the actual OSM pipeline end to end —
    // generous timeouts for the same reason server/vitest.config.ts has them.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
