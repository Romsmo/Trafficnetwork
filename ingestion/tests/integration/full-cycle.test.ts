import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";
import { startTestServer, type TestServer } from "./setup.js";

const INGESTION_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function writeRegionsConfig(dir: string, fixtureBaseUrl: string): string {
  const regionsPath = path.join(dir, "regions.json");
  writeFileSync(
    regionsPath,
    JSON.stringify({
      regions: {
        "mini-region": {
          name: "Mini Region (fixture)",
          geofabrikExtractUrl: `${fixtureBaseUrl}/mini-region.osm.pbf`,
          geofabrikChecksumUrl: `${fixtureBaseUrl}/mini-region.osm.pbf.md5`,
          bbox: [11.4, 48.0, 12.1, 48.7],
        },
        "mini-region-2": {
          name: "Mini Region 2 (fixture)",
          geofabrikExtractUrl: `${fixtureBaseUrl}/mini-region-2.osm.pbf`,
          geofabrikChecksumUrl: `${fixtureBaseUrl}/mini-region-2.osm.pbf.md5`,
          bbox: [12.4, 49.0, 13.1, 49.7],
        },
        // Same fixture file as "mini-region", but cut into 0.25° sections (Europe's mechanism at test scale).
        "mini-region-tiles": {
          name: "Mini Region, sectioned (fixture)",
          geofabrikExtractUrl: `${fixtureBaseUrl}/mini-region.osm.pbf`,
          geofabrikChecksumUrl: `${fixtureBaseUrl}/mini-region.osm.pbf.md5`,
          bbox: [11.4, 48.0, 12.1, 48.7],
          sections: { tileDegrees: 0.25 },
          skipManifestCrossCheck: true,
        },
      },
    }),
  );
  return regionsPath;
}

function baseEnv(server: TestServer, regionsPath: string, stateDir: string, downloadDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SERVER_URL: server.serverUrl,
    CLIENT_ID: server.clientId,
    CLIENT_SECRET: server.clientSecret,
    REGIONS_CONFIG_PATH: regionsPath,
    STATE_DIR: stateDir,
    DOWNLOAD_DIR: downloadDir,
    OSM_ENABLED: "true",
    LOG_LEVEL: "info",
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", "src/cli.ts", ...args], { cwd: INGESTION_ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fetchToken(serverUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(new URL("/v1/auth/token", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!res.ok) throw new Error(`token fetch failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function fetchSnapshotCounts(serverUrl: string, token: string): Promise<{ segments: number; signs: number; cameras: number }> {
  const res = await fetch(new URL("/v1/snapshot", serverUrl), { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
  const body = (await res.json()) as { speedLimitSegments: unknown[]; staticSigns: unknown[]; fixedSpeedCameras: unknown[] };
  return { segments: body.speedLimitSegments.length, signs: body.staticSigns.length, cameras: body.fixedSpeedCameras.length };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor: condition not met within timeout");
}

function progressLineCount(stateDir: string, regionId: string): number {
  try {
    const content = readFileSync(path.join(stateDir, regionId, "osm", "progress.ndjson"), "utf8");
    return content.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

describe("ingestion full cycle (real server, real osmium-tool, real fixtures)", () => {
  let fixtureServer: FixtureServer;
  let testServer: TestServer;
  let tmpRoot: string;
  let regionsPath: string;
  let token: string;

  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    testServer = await startTestServer();
    tmpRoot = mkdtempSync(path.join(tmpdir(), "ingestion-full-cycle-"));
    regionsPath = writeRegionsConfig(tmpRoot, fixtureServer.baseUrl);
    token = await fetchToken(testServer.serverUrl, testServer.clientId, testServer.clientSecret);
  }, 120_000);

  afterAll(async () => {
    // Defensive: if beforeAll threw partway through, don't let a secondary
    // "Cannot read properties of undefined" mask the real failure.
    await fixtureServer?.close();
    await testServer?.teardown();
    rmSync(tmpRoot, { recursive: true, force: true });
  }, 60_000);

  it("empty DB -> import -> API confirms the expected rows landed", async () => {
    const stateDir = path.join(tmpRoot, "state-1");
    const downloadDir = path.join(tmpRoot, "downloads-1");
    const env = baseEnv(testServer, regionsPath, stateDir, downloadDir);

    const before = await fetchSnapshotCounts(testServer.serverUrl, token);

    const result = await runCli(["--region", "mini-region"], env);
    expect(result.code, `cli failed: ${result.stderr}`).toBe(0);

    const after = await fetchSnapshotCounts(testServer.serverUrl, token);
    // mini-region.osm.pbf: 2 speed-limit-segments (way/101 explicit 50kmh, way/102 implicit DE:rural 100kmh),
    // 3 static-signs (node/7 DE:274-30, node/8 split into DE:260 + DE:274-50), 1 fixed-speed-camera (node/9).
    // way/103 (DE:motorway) correctly contributes nothing. Counts confirmed by running the real osmium+normalize
    // pipeline against this exact fixture during fixture construction.
    expect(after.segments - before.segments).toBe(2);
    expect(after.signs - before.signs).toBe(3);
    expect(after.cameras - before.cameras).toBe(1);
  }, 60_000);

  it("second run is a fast no-op via complete.marker, and forcing a re-stream still dedupes to zero new inserts", async () => {
    const stateDir = path.join(tmpRoot, "state-2");
    const downloadDir = path.join(tmpRoot, "downloads-2");
    const env = baseEnv(testServer, regionsPath, stateDir, downloadDir);

    // The DB already holds test 1's rows, and this run has fresh local state — the empty-target guard would
    // (rightly) refuse, so this test opts in on purpose.
    const first = await runCli(["--region", "mini-region", "--allow-non-empty"], env);
    expect(first.code, `first run failed: ${first.stderr}`).toBe(0);
    const afterFirst = await fetchSnapshotCounts(testServer.serverUrl, token);

    const second = await runCli(["--region", "mini-region"], env);
    expect(second.code, `second run failed: ${second.stderr}`).toBe(0);
    const afterSecond = await fetchSnapshotCounts(testServer.serverUrl, token);
    expect(afterSecond).toEqual(afterFirst);

    // Delete only complete.marker and the section marker (keep progress.ndjson) — forces a full re-stream of the
    // fixture, but every row's dedup key is already recorded, so nothing new gets posted.
    rmSync(path.join(stateDir, "mini-region", "osm", "complete.marker"));
    rmSync(path.join(stateDir, "mini-region", "osm", "sections"), { recursive: true, force: true });
    const third = await runCli(["--region", "mini-region"], env);
    expect(third.code, `third run failed: ${third.stderr}`).toBe(0);
    const afterThird = await fetchSnapshotCounts(testServer.serverUrl, token);
    expect(afterThird).toEqual(afterFirst);
  }, 90_000);

  it("a hard kill mid-run followed by an unmodified resume completes with exactly the expected count, no duplicates", async () => {
    const stateDir = path.join(tmpRoot, "state-3");
    const downloadDir = path.join(tmpRoot, "downloads-3");
    // BATCH_SIZE=2 over 6 rows = 3 batches, but on localhost all 3 can complete in
    // under a millisecond combined — no external poll loop could ever observe an
    // intermediate state without this. INGESTION_TEST_BATCH_DELAY_MS is a
    // test-only hook (see run-worker.ts) never used outside this file.
    const env = { ...baseEnv(testServer, regionsPath, stateDir, downloadDir), BATCH_SIZE: "2", INGESTION_TEST_BATCH_DELAY_MS: "300" };

    const before = await fetchSnapshotCounts(testServer.serverUrl, token);

    // mini-region-2.osm.pbf has 6 speed-limit-segments; BATCH_SIZE=2 means 3 batches.
    const child = spawn("node", ["--import", "tsx", "src/cli.ts", "--region", "mini-region-2", "--allow-non-empty"], { cwd: INGESTION_ROOT, env });
    let childOutput = "";
    child.stdout.on("data", (c: Buffer) => (childOutput += c.toString()));
    child.stderr.on("data", (c: Buffer) => (childOutput += c.toString()));
    try {
      await waitFor(() => progressLineCount(stateDir, "mini-region-2") >= 1 && progressLineCount(stateDir, "mini-region-2") < 3, 30_000);
    } catch (err) {
      throw new Error(`${(err as Error).message}\nchild output so far:\n${childOutput}`);
    }
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const afterKill = await fetchSnapshotCounts(testServer.serverUrl, token);
    const partialInserted = afterKill.segments - before.segments;
    expect(partialInserted).toBeGreaterThan(0);
    expect(partialInserted).toBeLessThan(6);

    const resumeResult = await runCli(["--region", "mini-region-2"], env);
    expect(resumeResult.code, `resume failed: ${resumeResult.stderr}`).toBe(0);

    const after = await fetchSnapshotCounts(testServer.serverUrl, token);
    expect(after.segments - before.segments).toBe(6);
  }, 60_000);

  it("refuses a fresh start against a server that already holds data — the server has no dedup", async () => {
    const env = baseEnv(testServer, regionsPath, path.join(tmpRoot, "state-4"), path.join(tmpRoot, "downloads-4"));
    const before = await fetchSnapshotCounts(testServer.serverUrl, token);

    const result = await runCli(["--region", "mini-region"], env);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Refusing to start.*--allow-non-empty/s);
    expect(await fetchSnapshotCounts(testServer.serverUrl, token)).toEqual(before);
  }, 60_000);

  it("a sectioned region (osmium streamed into tiles) imports the same rows, and a re-run skips every finished section", async () => {
    const stateDir = path.join(tmpRoot, "state-5");
    const downloadDir = path.join(tmpRoot, "downloads-5");
    const env = baseEnv(testServer, regionsPath, stateDir, downloadDir);
    const before = await fetchSnapshotCounts(testServer.serverUrl, token);

    const first = await runCli(["--region", "mini-region-tiles", "--allow-non-empty"], env);
    expect(first.code, `sectioned run failed: ${first.stderr}\n${first.stdout}`).toBe(0);
    const after = await fetchSnapshotCounts(testServer.serverUrl, token);
    expect(after.segments - before.segments).toBe(2);
    expect(after.signs - before.signs).toBe(3);
    expect(after.cameras - before.cameras).toBe(1);

    const sectionStatsDir = path.join(stateDir, "mini-region-tiles", "osm", "sections");
    const sectionFiles = readdirSync(sectionStatsDir).filter((f) => f.endsWith(".json"));
    expect(sectionFiles.length).toBeGreaterThanOrEqual(2); // 0.25° tiles split the fixture's features
    const extractMeta = JSON.parse(readFileSync(path.join(stateDir, "mini-region-tiles", "osm", "extract-meta.json"), "utf8")) as { md5: string; tagFilter: string[]; license: string };
    expect(extractMeta.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(extractMeta.tagFilter).toContain("nw/traffic_sign");
    expect(extractMeta.license).toMatch(/ODbL/);

    // Remove only the run-level marker: every section is already done, so the re-run reads none of them.
    rmSync(path.join(stateDir, "mini-region-tiles", "osm", "complete.marker"));
    const again = await runCli(["--region", "mini-region-tiles"], env);
    expect(again.code, `re-run failed: ${again.stderr}`).toBe(0);
    expect(again.stdout).toMatch(/section already complete/);
    expect(await fetchSnapshotCounts(testServer.serverUrl, token)).toEqual(after);
  }, 90_000);
});
