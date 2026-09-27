import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import type { Region } from "../../src/config/regions.js";
import { loadSignMapping } from "../../src/pipeline/nvdb/mapping.js";
import { importableEnumIds, nvdbNoWorker, SERVER_FILTER_REASON, type SectionReport } from "../../src/pipeline/nvdb/worker.js";
import type { NormalizedRow, WorkerContext } from "../../src/pipeline/worker.js";
import { startFakeNvdb, type FakeNvdb } from "../helpers/nvdb-fake-server.js";

const silentLogger = pino({ level: "silent" });
const norway: Region = { name: "Norway", bbox: [4, 57.5, 31.5, 71.5], officialSources: ["nvdb-no"], skipManifestCrossCheck: true };

describe("nvdb-no worker (real HTTP against a fake serving real NVDB responses)", () => {
  let fake: FakeNvdb;
  let stateDir: string;
  let env: Env;

  beforeAll(async () => {
    fake = await startFakeNvdb();
  });
  afterAll(async () => {
    await fake.close();
  });
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-nvdb-"));
    fake.requests.length = 0;
    fake.failMunicipalities.clear();
    fake.mirrorPositions = false;
    fake.applyFilter = true;
    resetEnvCache();
    env = loadEnv({ SERVER_URL: "http://unused.test", CLIENT_ID: "x", CLIENT_SECRET: "y", NVDB_NO_ENABLED: "true", NVDB_NO_BASE_URL: fake.baseUrl, NVDB_NO_MIN_REQUEST_INTERVAL_MS: "0", HTTP_BACKOFF_BASE_MS: "1", HTTP_BACKOFF_MAX_MS: "2", HTTP_MAX_RETRIES: "1" });
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    resetEnvCache();
  });

  const ctx = (over: Partial<WorkerContext> = {}): WorkerContext => ({ regionId: "norway", region: norway, logger: silentLogger, downloadDir: stateDir, stateDir, env, ...over });

  async function readAll(context: WorkerContext): Promise<{ sections: { id: string; index: number; total: number; rows: NormalizedRow[] }[] }> {
    const sections = [];
    for await (const section of nvdbNoWorker.runSections!(context)) {
      const rows: NormalizedRow[] = [];
      for await (const row of section.rows) rows.push(row);
      sections.push({ id: section.id, index: section.index, total: section.total, rows });
    }
    return { sections };
  }

  it("makes one section per municipality, in order, with the rows of every plate that belongs to the imported series", async () => {
    const { sections } = await readAll(ctx());
    expect(sections.map((s) => [s.id, s.index, s.total, s.rows.length])).toEqual([
      ["kommune-0301", 1, 3, 22], // 8 + 14 from the two real Oslo pages
      ["kommune-1103", 2, 3, 0],
      ["kommune-1151", 3, 3, 13],
    ]);
    const first = sections[2]!.rows[0]!;
    expect(first).toMatchObject({ kind: "static-sign", row: { source: "nvdb-no", sourceLicense: "NLOD" } });
    expect(new Set(sections.flatMap((s) => s.rows.map((r) => r.key))).size).toBe(35);
  });

  it("restricts the request on the server to the Skiltnummer values the mapping imports", async () => {
    await readAll(ctx());
    const filtered = fake.requests.find((r) => r.url.pathname === "/vegobjekter/96")!;
    const filter = filtered.url.searchParams.get("egenskap")!;
    expect(filter).toMatch(/^egenskap\(5530\)in\[\d+(,\d+)*\]$/);
    // 44 real enum values in the fixture; the imported series 1-4 are a strict subset
    const ids = filter.slice("egenskap(5530)in[".length, -1).split(",");
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(44);
  });

  it("writes provenance and one skip report per municipality (the input of the quality report)", async () => {
    await readAll(ctx());
    const meta = JSON.parse(fs.readFileSync(path.join(stateDir, "nvdb-no-meta.json"), "utf8"));
    expect(meta).toMatchObject({ source: "nvdb-no", license: "NLOD", objectType: "96 Skiltplate", municipalities: 3 });
    expect(meta.attribution).toBe("Inneholder data under norsk lisens for offentlige data (NLOD) tilgjengeliggjort av Statens vegvesen.");

    const utsira = JSON.parse(fs.readFileSync(path.join(stateDir, "skips", "kommune-1151.json"), "utf8")) as SectionReport;
    // The server-side filter delivered only the 13 plates of the imported series; the other 19 of the 32 are the difference to the total.
    expect(utsira).toMatchObject({ totalPlates: 32, fetched: 13, imported: 13, passedThroughUnknownCode: 0 });
    expect(utsira.notImported).toEqual({ [SERVER_FILTER_REASON]: 19 });
    const oslo = JSON.parse(fs.readFileSync(path.join(stateDir, "skips", "kommune-0301.json"), "utf8")) as SectionReport;
    expect(oslo).toMatchObject({ totalPlates: 60, fetched: 22, imported: 22 });
    expect(oslo.notImported).toEqual({ [SERVER_FILTER_REASON]: 38 });
  });

  it("a server that ignores the series filter changes nothing: the client decides every series itself and reports the reasons one by one", async () => {
    fake.applyFilter = false;
    const { sections } = await readAll(ctx());
    expect(sections.map((s) => s.rows.length)).toEqual([22, 0, 13]);
    const utsira = JSON.parse(fs.readFileSync(path.join(stateDir, "skips", "kommune-1151.json"), "utf8")) as SectionReport;
    expect(utsira).toMatchObject({ totalPlates: 32, fetched: 32, imported: 13 });
    expect(utsira.notImported).toEqual({
      "series 6 not imported (service signs)": 2,
      "series 7 not imported (direction and wayfinding signs)": 10,
      "series 8 not imported (supplementary plates and text plates)": 4,
      "series 9 not imported (markers and delineation)": 3,
    });
  });

  it("refuses a region that does not list nvdb-no, and a context without the environment", async () => {
    await expect(readAll(ctx({ region: { ...norway, officialSources: undefined } }))).rejects.toThrow(/does not list "nvdb-no" in its officialSources/);
    await expect(readAll(ctx({ env: undefined }))).rejects.toThrow(/needs the environment configuration/);
    expect(nvdbNoWorker.supportsRegion!({ ...norway, officialSources: undefined })).toMatch(/officialSources/);
    expect(nvdbNoWorker.supportsRegion!(norway)).toBeUndefined();
  });

  it("stops (does not import wrong positions) when a whole page has coordinates outside Norway — an axis order change", async () => {
    fake.mirrorPositions = true;
    try {
      await expect(readAll(ctx())).rejects.toThrow(/axis order of the API probably changed/);
    } finally {
      fake.mirrorPositions = false;
    }
  });

  it("a failing municipality aborts the run, and the sections before it were delivered whole", async () => {
    fake.failMunicipalities.add(1151);
    const delivered: string[] = [];
    await expect(
      (async () => {
        for await (const section of nvdbNoWorker.runSections!(ctx())) {
          for await (const _row of section.rows) void _row;
          delivered.push(section.id);
        }
      })(),
    ).rejects.toThrow(/failed after 2 attempts/);
    expect(delivered).toEqual(["kommune-0301", "kommune-1103"]);
  });
});

describe("importableEnumIds", () => {
  const mapping = loadSignMapping();

  it("lists the enum ids of the imported series; undefined when nothing would be narrowed", () => {
    const enumCodes = new Map([
      [1, "362.50"],
      [2, "552"],
      [3, "202"],
      [4, "711.V90"],
    ]);
    expect(importableEnumIds(enumCodes, mapping)).toEqual([1, 3]);
    expect(importableEnumIds(new Map([[1, "362.50"], [3, "202"]]), mapping)).toBeUndefined(); // everything is imported: no filter needed
    expect(importableEnumIds(new Map([[2, "552"]]), mapping)).toBeUndefined(); // nothing imported: no filter that would make the API return everything's opposite
  });
});
