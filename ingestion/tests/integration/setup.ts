import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

export interface RunningServer {
  serverUrl: string;
  stop: () => Promise<void>;
}

export interface TestServer {
  serverUrl: string;
  clientId: string;
  clientSecret: string;
  /** The database this server runs on — for starting a second server (other flags) against the same data. */
  databaseUrl: string;
  /** Starts one more server process on the SAME database, e.g. with another feature flag. Stopped by teardown() at the latest. */
  spawnServer: (extraEnv: Record<string, string>) => Promise<RunningServer>;
  teardown: () => Promise<void>;
}

export interface TestServerOptions {
  /** SPEED_CAMERA_NAMESPACE_ENABLED of the server. Default true: most tests verify a fixed-speed-camera import through the read API. */
  speedCameraNamespaceEnabled?: boolean;
}

const SERVER_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../../server");
const JWT_SECRET = "test-jwt-secret-at-least-16-characters-long";

/** A free port for this test file's own server: integration test files run in parallel workers, so a fixed port would clash. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (address && typeof address !== "string" ? resolve(address.port) : reject(new Error("could not find a free port"))));
    });
  });
}

/**
 * A real, running server with its OWN database for each test file, hit over real HTTP. Two ways to get the database:
 *
 * - CI (INGESTION_TEST_PG_ADMIN_URL set to a superuser URL of a running PostGIS, e.g. the workflow's services: container):
 *   a fresh database is created on it for this file and dropped afterwards. The importer refuses a fresh start on a server
 *   that already holds static data, and several test files import static data, so files must not share one database.
 * - Local dev: Testcontainers spins up a throwaway Postgres/PostGIS.
 *
 * In both cases the already-built server/dist (prerequisite: `npm run build` once in server/, per ingestion/README.md) is
 * migrated and spawned against it, and server/scripts/create-client.mts mints a client the same way an operator would.
 * Both paths exercise the exact same server code, unmodified — this file's job is only to make one available.
 */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const database = await createDatabase();
  const running: RunningServer[] = [];

  try {
    await runOnce("node", ["dist/db/migrate.js"], { DATABASE_URL: database.url, JWT_SECRET });

    const spawnServer = async (extraEnv: Record<string, string>): Promise<RunningServer> => {
      const port = await freePort();
      const serverUrl = `http://127.0.0.1:${port}`;
      const serverProcess = spawn("node", ["dist/server.js"], {
        cwd: SERVER_DIR,
        // Writes are never gated by SPEED_CAMERA_NAMESPACE_ENABLED (only reads are), so the flag being off by default in
        // production doesn't affect what ingestion writes; it only decides whether a test can see a camera afterwards.
        env: { ...process.env, DATABASE_URL: database.url, JWT_SECRET, PORT: String(port), SPEED_CAMERA_NAMESPACE_ENABLED: String(options.speedCameraNamespaceEnabled ?? true), ...extraEnv },
        stdio: "pipe",
      });
      let serverLog = "";
      serverProcess.stdout?.on("data", (c: Buffer) => (serverLog += c.toString()));
      serverProcess.stderr?.on("data", (c: Buffer) => (serverLog += c.toString()));
      const handle: RunningServer = {
        serverUrl,
        stop: async () => {
          if (serverProcess.exitCode !== null) return;
          serverProcess.kill();
          await new Promise((resolve) => serverProcess.once("exit", resolve));
        },
      };
      running.push(handle);
      await waitForHealth(serverUrl, () => serverLog);
      return handle;
    };

    const main = await spawnServer({});
    const createClientOutput = await runOnce("node", ["--import", "tsx", "scripts/create-client.mts", "--name", "ingestion-integration-test", "--scope", "bulk-import"], {
      DATABASE_URL: database.url,
      JWT_SECRET, // create-client.mts calls the shared loadEnv(), which requires this even though the script itself never signs anything
    });

    return {
      serverUrl: main.serverUrl,
      clientId: extractField(createClientOutput, "clientId"),
      clientSecret: extractField(createClientOutput, "clientSecret"),
      databaseUrl: database.url,
      spawnServer,
      teardown: async () => {
        for (const server of running) await server.stop();
        await database.drop();
      },
    };
  } catch (err) {
    for (const server of running) await server.stop();
    await database.drop();
    throw err;
  }
}

async function createDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const adminUrl = process.env.INGESTION_TEST_PG_ADMIN_URL;
  if (adminUrl) {
    const name = `tn_it_${randomBytes(5).toString("hex")}`;
    // The server's own `postgres` client (already a dependency there) issues the CREATE/DROP, so ingestion needs no Postgres driver.
    // CREATE DATABASE copies template1 and fails with "template1 is being accessed by other users" when several test files
    // create theirs at the same moment, so the statement runs under an advisory lock shared by all of them (one connection, so the lock holds).
    const script =
      'import postgres from "postgres"; const sql = postgres(process.env.ADMIN_URL, { max: 1 });' +
      ' await sql.unsafe("select pg_advisory_lock(918273)");' +
      ' try { await sql.unsafe(process.env.STATEMENT); } finally { await sql.unsafe("select pg_advisory_unlock(918273)"); await sql.end(); }';
    const admin = (statement: string): Promise<string> => runOnce("node", ["--input-type=module", "-e", script], { ADMIN_URL: adminUrl, STATEMENT: statement });
    await admin(`create database ${name}`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    return { url: url.toString(), drop: async () => void (await admin(`drop database if exists ${name} with (force)`).catch(() => "")) };
  }

  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgis/postgis:16-3.4").start();
  return { url: container.getConnectionUri(), drop: async () => void (await container.stop()) };
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
