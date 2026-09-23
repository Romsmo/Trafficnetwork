import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { INSTANCES, instanceUrl, type InstanceName } from "./instances.js";
import { SEGMENTS } from "./seed.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JWT_SECRET = "e2e-jwt-secret-e2e-jwt-secret-1234";

/** Limits generous enough that the suite's own traffic (one IP, many sessions) never trips them — except where a test wants it to. */
const RELAXED_LIMITS: Record<string, string> = {
  WEB_SESSION_MINT_LIMIT_PER_MINUTE: "100000",
  WEB_REPORT_LIMIT_PER_SESSION: "50",
  WEB_REPORT_LIMIT_PER_IP_PER_HOUR: "100000",
  WEB_REPORT_LIMIT_NODE_PER_HOUR: "100000",
  WEB_READ_LIMIT_PER_IP_PER_MINUTE: "100000",
  WEB_HEAVY_READ_LIMIT_PER_IP_PER_MINUTE: "100000",
  REPORT_RATE_LIMIT_MAX: "1000",
};

function nodeEnv(databaseUrl: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    JWT_SECRET,
    HOST: "127.0.0.1",
    LOG_LEVEL: "warn",
    FEDERATION_ENABLED: "false",
    SPEED_CAMERA_NAMESPACE_ENABLED: "false",
    WEB_UI_ENABLED: "true",
    MAP_TILE_URL: "",
    ...RELAXED_LIMITS,
    ...extra,
  };
}

async function waitForHealth(url: string, output: string[], timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/v1/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Node at ${url} did not become healthy within ${timeoutMs} ms. Output:\n${output.join("")}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer("postgis/postgis:16-3.4").start();
  const databaseUrl = container.getConnectionUri();
  const children: ChildProcess[] = [];

  const teardown = async () => {
    for (const child of children) child.kill();
    await container.stop();
  };

  try {
    // Same path a real deploy takes: the migration script in its own process, before any node connects.
    const migration = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate.ts"], { cwd: serverDir, env: nodeEnv(databaseUrl, {}), encoding: "utf8" });
    if (migration.status !== 0) throw new Error(`Migration failed:\n${migration.stdout}\n${migration.stderr}`);

    const sql = postgres(databaseUrl, { max: 1 });
    try {
      for (const segment of SEGMENTS) {
        const wkt = `LINESTRING(${segment.line.map(([lng, lat]) => `${lng} ${lat}`).join(", ")})`;
        await sql`insert into speed_limit_segments (geometry, speed_limit, speed_limit_unit, source) values (ST_SetSRID(ST_GeomFromText(${wkt}), 4326), ${segment.kmh}, 'kmh', 'e2e-seed')`;
      }
      // The node derives its "region hint" (where the map opens) from the planner's spatial extent statistics.
      await sql`analyze speed_limit_segments`;
    } finally {
      await sql.end();
    }

    await Promise.all(
      (Object.keys(INSTANCES) as InstanceName[]).map(async (name) => {
        const output: string[] = [];
        const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
          cwd: serverDir,
          env: nodeEnv(databaseUrl, { ...INSTANCES[name].env, PORT: String(INSTANCES[name].port) }),
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
        child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
        children.push(child);
        await waitForHealth(instanceUrl(name), output);
      }),
    );
  } catch (error) {
    await teardown();
    throw error;
  }

  return teardown;
}
