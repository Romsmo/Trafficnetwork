import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests spin up a Testcontainers Postgres/PostGIS container per
    // file, which can take longer than vitest's default timeouts on a cold pull.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
