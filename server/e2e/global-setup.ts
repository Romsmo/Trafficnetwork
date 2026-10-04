import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { INSTANCES, instanceUrl, type Instance, type InstanceName } from "./instances.js";
import { SEGMENTS } from "./seed.js";
import { generateEd25519KeyPair } from "../src/modules/crypto/keys.js";
import { signEnvelope } from "../src/modules/crypto/envelope.js";
import type { NetworkConfigPayload } from "../src/modules/network/config.js";

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
  // Online counter (a separate add-on; nodes without it ignore these): count open sockets only, answer fresh every time.
  ONLINE_WINDOW_SECONDS: "0",
  ONLINE_CACHE_SECONDS: "0",
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

  const configDir = mkdtempSync(path.join(tmpdir(), "tn-e2e-config-"));

  const teardown = async () => {
    for (const child of children) child.kill();
    await container.stop();
    rmSync(configDir, { recursive: true, force: true });
  };

  /** The signed network config of an instance with a camera policy; one throw-away root key for the whole run. */
  const root = generateEd25519KeyPair();
  const policyEnv = (name: InstanceName): Record<string, string> => {
    const instance: Instance = INSTANCES[name];
    if (!instance.policy) return {};
    const file = path.join(configDir, `${name}.json`);
    const payload: NetworkConfigPayload = {
      version: 1,
      blitzerEnabled: true,
      cameraPolicyByCountry: instance.policy,
      eventLogRetentionDaysDynamic: 3,
      eventLogRetentionDaysStatic: 30,
      minVersion: "0.1.0",
      excludedNodeIds: [],
      issuedAt: new Date().toISOString(),
    };
    writeFileSync(file, JSON.stringify(signEnvelope(payload, root)));
    return { NETWORK_CONFIG_PATH: file, NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw };
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
      // The country the test town lies in. The server ships no geodata; the camera policy needs *some* country to apply to.
      await sql`delete from country_boundary_parts`;
      await sql`insert into country_boundary_parts (iso2, geom) values ('DE', ST_MakeEnvelope(11.0, 47.7, 12.2, 48.6, 4326))`;
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
          env: nodeEnv(databaseUrl, { ...INSTANCES[name].env, ...policyEnv(name), PORT: String(INSTANCES[name].port) }),
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
