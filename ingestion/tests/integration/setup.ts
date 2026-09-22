import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

export interface TestServer {
  serverUrl: string;
  clientId: string;
  clientSecret: string;
  teardown: () => Promise<void>;
}

const SERVER_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../../server");
const LOCAL_TEST_PORT = 34127;

/**
 * Two ways to get a real, running server for these tests to hit over real HTTP:
 *
 * - CI (INGESTION_TEST_SERVER_URL set): .github/workflows/ingestion-ci.yml has
 *   already built server/, run its migrations, started it, and minted a
 *   bulk-import client against it as separate, independently-debuggable
 *   workflow steps — this just reads the result.
 * - Local dev (no env vars): Testcontainers spins up a throwaway Postgres/
 *   PostGIS, and the already-built server/dist/server.js (prerequisite:
 *   `npm run build` once in server/, per ingestion/README.md) is spawned
 *   against it, then server/scripts/create-client.mts mints a client the same
 *   way an operator would. Both paths exercise the exact same server code,
 *   unmodified — this file's job is only to make one available.
 */
export async function startTestServer(): Promise<TestServer> {
  if (process.env.INGESTION_TEST_SERVER_URL) {
    return {
      serverUrl: process.env.INGESTION_TEST_SERVER_URL,
      clientId: requireEnv("INGESTION_TEST_CLIENT_ID"),
      clientSecret: requireEnv("INGESTION_TEST_CLIENT_SECRET"),
      teardown: async () => {},
    };
  }

  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgis/postgis:16-3.4").start();
  const databaseUrl = container.getConnectionUri();
  const jwtSecret = "test-jwt-secret-at-least-16-characters-long";
  const serverUrl = `http://127.0.0.1:${LOCAL_TEST_PORT}`;

  await runOnce("node", ["dist/db/migrate.js"], { DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret });

  const serverProcess = spawn("node", ["dist/server.js"], {
    cwd: SERVER_DIR,
    // SPEED_CAMERA_NAMESPACE_ENABLED=true only on this throwaway test server, so
    // full-cycle.test.ts can verify a fixed-speed-camera bulk-import via reads —
    // writes are never gated by this flag (only reads are), so the flag being off
    // by default in production doesn't affect what ingestion actually writes; it
    // only affects whether *this test* can see it afterwards.
    env: { ...process.env, DATABASE_URL: databaseUrl, JWT_SECRET: jwtSecret, PORT: String(LOCAL_TEST_PORT), SPEED_CAMERA_NAMESPACE_ENABLED: "true" },
    stdio: "pipe",
  });
  let serverLog = "";
  serverProcess.stdout?.on("data", (c: Buffer) => (serverLog += c.toString()));
  serverProcess.stderr?.on("data", (c: Buffer) => (serverLog += c.toString()));

  await waitForHealth(serverUrl, () => serverLog);

  const createClientOutput = await runOnce("node", ["--import", "tsx", "scripts/create-client.mts", "--name", "ingestion-integration-test", "--scope", "bulk-import"], {
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret, // create-client.mts calls the shared loadEnv(), which requires this even though the script itself never signs anything
  });
  const clientId = extractField(createClientOutput, "clientId");
  const clientSecret = extractField(createClientOutput, "clientSecret");

  return {
    serverUrl,
    clientId,
    clientSecret,
    teardown: async () => {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.once("exit", resolve));
      await container.stop();
    },
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when INGESTION_TEST_SERVER_URL is set`);
  return value;
}

function runOnce(command: string, args: string[], extraEnv: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: SERVER_DIR, env: { ...process.env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${command} ${args.join(" ")} failed (exit ${code}): ${stderr}`))));
  });
}

async function waitForHealth(serverUrl: string, getLog: () => string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL("/v1/health", serverUrl));
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Server at ${serverUrl} did not become healthy within ${timeoutMs}ms. Log:\n${getLog()}`);
}

function extractField(output: string, field: "clientId" | "clientSecret"): string {
  const match = output.match(new RegExp(`${field}:\\s*(\\S+)`));
  if (!match) throw new Error(`Could not find ${field} in create-client output:\n${output}`);
  return match[1]!;
}
