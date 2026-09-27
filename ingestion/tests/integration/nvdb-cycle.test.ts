import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeNvdb, type FakeNvdb } from "../helpers/nvdb-fake-server.js";
import { startTestServer, type TestServer } from "./setup.js";

/**
 * Official sign plates from NVDB Norway, imported into a REAL server by the real CLI (`--region norway`). The NVDB side is a
 * local stand-in that serves real API responses (tests/fixtures/nvdb-no: the whole municipality Utsira, two pages of Oslo).
 *
 * The scenario an operator lives through: a run that dies half-way (the API is down for one municipality), the rerun that
 * completes it without duplicating what already arrived, and a further run that finds nothing left to do.
 */

const INGESTION_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
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

async function accessToken(serverUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(new URL("/v1/auth/token", serverUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, clientSecret }) });
  if (!res.ok) throw new Error(`token fetch failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

interface NearbySign {
  signType: string;
  source: string;
  sourceLicense: string | null;
  position: { coordinates: [number, number] };
}

describe("NVDB Norway sign import (real server, real CLI, real API responses behind a local stand-in)", () => {
  let testServer: TestServer;
  let nvdb: FakeNvdb;
  let tmpRoot: string;
  let regionsPath: string;
  let stateDir: string;
  let token: string;

  beforeAll(async () => {
    [testServer, nvdb] = await Promise.all([startTestServer(), startFakeNvdb()]);
    tmpRoot = mkdtempSync(path.join(tmpdir(), "tn-nvdb-it-"));
    stateDir = path.join(tmpRoot, "state");
    regionsPath = path.join(tmpRoot, "regions.json");
    writeFileSync(regionsPath, JSON.stringify({ regions: { norway: { name: "Norway (fixture)", bbox: [4, 57.5, 31.5, 71.5], officialSources: ["nvdb-no"], skipManifestCrossCheck: true } } }));
    token = await accessToken(testServer.serverUrl, testServer.clientId, testServer.clientSecret);
  });

  afterAll(async () => {
    await nvdb?.close();
    await testServer?.teardown();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  const importRun = (): Promise<CliResult> =>
    runCli(["--region", "norway", "--allow-non-empty"], {
      ...process.env,
      SERVER_URL: testServer.serverUrl,
      CLIENT_ID: testServer.clientId,
      CLIENT_SECRET: testServer.clientSecret,
      REGIONS_CONFIG_PATH: regionsPath,
      STATE_DIR: stateDir,
      DOWNLOAD_DIR: path.join(tmpRoot, "downloads"),
      OSM_ENABLED: "false",
      NVDB_NO_ENABLED: "true",
      NVDB_NO_BASE_URL: nvdb.baseUrl,
      NVDB_NO_MIN_REQUEST_INTERVAL_MS: "0",
      HTTP_BACKOFF_BASE_MS: "5",
      HTTP_BACKOFF_MAX_MS: "20",
      HTTP_MAX_RETRIES: "1",
      LOG_LEVEL: "info",
    });

  async function signsAround(lat: number, lng: number, radiusM: number): Promise<NearbySign[]> {
    const url = new URL("/v1/static-signs/nearby", testServer.serverUrl);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lng", String(lng));
    url.searchParams.set("radiusM", String(radiusM));
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`nearby failed: ${res.status}`);
    return ((await res.json()) as { signs: NearbySign[] }).signs.filter((s) => s.source === "nvdb-no");
  }
  const oslo = () => signsAround(59.88, 10.75, 20_000);
  const utsira = () => signsAround(59.3, 4.89, 10_000);

  it("a run that dies half-way: Oslo and Stavanger arrive whole, Utsira (API down) does not, and the run says so", async () => {
    nvdb.failMunicipalities.add(1151);
    const run = await importRun();
    nvdb.failMunicipalities.clear();

    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(run.stderr).toMatch(/failed after 2 attempts/);
    expect(await oslo()).toHaveLength(22); // 8 + 14 of the two real pages
    expect(await utsira()).toHaveLength(0);
    expect(existsSync(path.join(stateDir, "norway", "nvdb-no", "complete.marker"))).toBe(false);
  });

  it("the rerun resumes: Utsira arrives, Oslo is not imported a second time", async () => {
    const run = await importRun();
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/section already complete — skipping/);

    expect(await oslo()).toHaveLength(22);
    expect(await utsira()).toHaveLength(13);
    expect(existsSync(path.join(stateDir, "norway", "nvdb-no", "complete.marker"))).toBe(true);
  });

  it("every stored sign carries its provenance and the official code, verbatim behind the country prefix", async () => {
    const signs = [...(await oslo()), ...(await utsira())];
    expect(signs).toHaveLength(35);
    for (const sign of signs) {
      expect(sign).toMatchObject({ source: "nvdb-no", sourceLicense: "NLOD" });
      expect(sign.signType).toMatch(/^NO:[1-4]\d\d(\.[0-9A-Z]+)?$|^NO:U[1-4]\d\d/); // only the imported series
    }
    const codes = signs.map((s) => s.signType);
    expect(codes).toContain("NO:362.80"); // a speed limit of 80 km/h
    expect(codes).toContain("NO:202"); // give way
    expect(codes).toContain("NO:366"); // Utsira's real data
    expect(codes.some((c) => /^NO:[5-9]/.test(c))).toBe(false);

    // The position is the API's (lat, lon) as GeoJSON (lon, lat): plate 86558499 at 59.87012973 N, 10.82865387 E.
    const speed80 = (await oslo()).find((s) => s.signType === "NO:362.80" && Math.abs(s.position.coordinates[1] - 59.87012973) < 1e-6);
    expect(speed80?.position.coordinates[0]).toBeCloseTo(10.82865387, 6);
  });

  it("a further run finds the import complete and changes nothing", async () => {
    const before = [...(await oslo()), ...(await utsira())].length;
    nvdb.requests.length = 0;
    const run = await importRun();
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/already imported/);
    expect(nvdb.requests).toHaveLength(0); // it did not even ask the API
    expect([...(await oslo()), ...(await utsira())]).toHaveLength(before);
  });

  it("wrote the provenance file and one skip report per municipality for the quality report", () => {
    const dir = path.join(stateDir, "norway", "nvdb-no");
    const meta = JSON.parse(readFileSync(path.join(dir, "nvdb-no-meta.json"), "utf8"));
    expect(meta).toMatchObject({ source: "nvdb-no", license: "NLOD", municipalities: 3 });
    for (const section of ["kommune-0301", "kommune-1103", "kommune-1151"]) {
      expect(existsSync(path.join(dir, "skips", `${section}.json`)), section).toBe(true);
    }
  });

  it("the OSM source does not try to import a region that has no Geofabrik extract — it is skipped with the reason", async () => {
    const run = await runCli(["--region", "norway", "--allow-non-empty"], {
      ...process.env,
      SERVER_URL: testServer.serverUrl,
      CLIENT_ID: testServer.clientId,
      CLIENT_SECRET: testServer.clientSecret,
      REGIONS_CONFIG_PATH: regionsPath,
      STATE_DIR: path.join(tmpRoot, "state-osm"),
      OSM_ENABLED: "true",
      NVDB_NO_ENABLED: "false",
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/source skipped for this region/);
    expect(run.stderr).toMatch(/None of the enabled sources \(osm\) can import region "norway"/);
  });
});
