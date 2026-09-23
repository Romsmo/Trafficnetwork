import { defineConfig, devices } from "@playwright/test";
import { instanceUrl } from "./e2e/instances.js";

/**
 * End-to-end tests of the node's web UI in a real browser against real server processes and a real PostGIS database
 * (started by e2e/global-setup.ts). `npm run e2e` runs the suite; `npm run e2e:screenshots` regenerates the images
 * used by docs/web-ui.md (needs internet: the screenshots show real map tiles).
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One shared database and a handful of server processes: run serially so the tests stay deterministic.
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: instanceUrl("main"),
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "e2e", testIgnore: /screenshots\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "screenshots", testMatch: /screenshots\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
  ],
});
