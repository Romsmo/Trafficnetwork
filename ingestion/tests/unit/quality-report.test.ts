import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SeedReportPoster, SeedReportsRequest, SeedReportsResponse } from "../../src/api/types.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { nvdbNoWorker } from "../../src/pipeline/nvdb/worker.js";
import type { FeedConfig } from "../../src/pipeline/roadworks/feeds.js";
import { runRoadworks } from "../../src/pipeline/roadworks/run-roadworks.js";
import type { ParseResult } from "../../src/pipeline/roadworks/types.js";
import { collectSourceQuality, renderQualityMarkdown } from "../../src/report/quality.js";
import { StateStore } from "../../src/state/store.js";
import { startFakeNvdb, type FakeNvdb } from "../helpers/nvdb-fake-server.js";

const silentLogger = pino({ level: "silent" });

describe("source quality report — built only from what the importers recorded", () => {
  let stateDir: string;
  let fake: FakeNvdb;

  beforeAll(async () => {
    fake = await startFakeNvdb();
  });
  afterAll(async () => {
    await fake.close();
  });
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-quality-"));
    resetEnvCache();
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    resetEnvCache();
  });

  it("says so plainly when nothing has run", async () => {
    const items = await collectSourceQuality(stateDir);
    expect(items).toEqual([]);
    expect(renderQualityMarkdown(items, new Date("2026-09-26T12:00:00Z"))).toMatch(/No source has run yet/);
  });

  it("roadworks: taken over, discarded with reasons, merged into the other feed, and the caveats", async () => {
    const feed = (id: string): FeedConfig => ({ id, enabled: true, kind: "datex2", country: "XX", name: id, url: "https://example.test/", sourceLicense: "L", attribution: "a", minIntervalMinutes: 60, ttlHours: 72 });
    const now = new Date("2026-09-28T12:00:00Z");
    const result = (candidates: ParseResult["candidates"], skipped: ParseResult["skipped"] = []): ParseResult => ({ candidates, skipped, totalSeen: candidates.length + skipped.length, complete: true, publishedAt: new Date(now.getTime() - 3_600_000) });
    const poster: SeedReportPoster = {
      postSeedReports: async (r: SeedReportsRequest): Promise<SeedReportsResponse> => ({ created: r.reports.length, reactivated: 0, updated: 0, refreshed: 0, skippedEnded: 0, duplicatesInRequest: 0 }),
      retireSeedReports: async () => ({ retired: 2 }),
    };
    const start = new Date(now.getTime() - 86_400_000);
    const end = new Date(now.getTime() + 86_400_000);
    await runRoadworks({
      feeds: [feed("national"), feed("operator")],
      adapters: {
        datex2: async (f) =>
          f.id === "national"
            ? result([{ externalId: "n1", lat: 50, lng: 10, validity: { start, end }, caveat: "period qualifier not evaluated: night only" }, { externalId: "n2", lat: 51, lng: 10, validity: {} }], [{ reason: "record type SpeedManagement is not roadworks" }])
            : result([{ externalId: "o1", lat: 50.0005, lng: 10, validity: { start, end } }, { externalId: "o2", lat: 52, lng: 10, validity: { start: new Date("2027-01-01T00:00:00Z") } }]),
        "autobahn-de-json": async () => result([]),
      },
      apiClient: poster,
      stateDir,
      logger: silentLogger,
      dryRun: false,
      lookaheadMinutes: 30,
      mergeRadiusMeters: 250,
      batchSize: 2000,
      now: () => now,
    });

    const items = await collectSourceQuality(stateDir);
    const national = items.find((i) => i.id === "national")!;
    expect(national).toMatchObject({ kind: "roadworks-feed", imported: 2, discarded: 1, merged: 0, discardReasons: { "record type SpeedManagement is not roadworks": 1 } });
    expect(national.notes.join("\n")).toMatch(/1 sent with a timing detail not evaluated \(period qualifier not evaluated: night only\)/);
    expect(national.notes.join("\n")).toMatch(/2 roadworks no longer in the feed were ended/);

    const operator = items.find((i) => i.id === "operator")!;
    expect(operator).toMatchObject({ imported: 0, merged: 1, discarded: 1, discardReasons: { "starts later": 1 } });
  });

  it("official signs: sums the per-municipality reports, with the series the server-side filter left out", async () => {
    const env = loadEnv({ SERVER_URL: "http://unused.test", CLIENT_ID: "x", CLIENT_SECRET: "y", NVDB_NO_ENABLED: "true", NVDB_NO_BASE_URL: fake.baseUrl, NVDB_NO_MIN_REQUEST_INTERVAL_MS: "0" });
    const norwayState = new StateStore(stateDir, "norway", "nvdb-no");
    await norwayState.init();
    for await (const section of nvdbNoWorker.runSections!({ regionId: "norway", region: { name: "Norway", bbox: [4, 57.5, 31.5, 71.5], officialSources: ["nvdb-no"] }, logger: silentLogger, downloadDir: stateDir, stateDir: norwayState.directory, env })) {
      for await (const _row of section.rows) void _row;
    }

    const [before] = await collectSourceQuality(stateDir, { region: "norway", source: "nvdb-no" });
    expect(before).toMatchObject({ id: "nvdb-no@norway", kind: "official-signs", imported: 35, merged: 0, status: "incomplete (resumable)" });
    expect(before!.discarded).toBe(57); // (32 + 60) plates in the source − 35 imported; the API left them out on request
    expect(before!.discardReasons).toEqual({ "not in the imported Skiltnummer series (left out by the server-side filter)": 57 });
    expect(before!.notes.join("\n")).toMatch(/3 of 3 sections read, 92 objects in the source/);
    expect(before!.notes.join("\n")).toMatch(/license: NLOD/);

    await norwayState.markComplete();
    const [after] = await collectSourceQuality(stateDir, { source: "nvdb-no" });
    expect(after!.status).toBe("complete");
  });

  it("osm: what the finished sections delivered, and where the skip reasons are", async () => {
    const store = new StateStore(stateDir, "bayern", "osm");
    await store.init();
    const at = "2026-09-26T10:00:00.000Z";
    await store.markSectionDone({ id: "t1", startedAt: at, finishedAt: at, insertedByKind: { "speed-limit-segment": 10, "static-sign": 4 }, skippedAlreadyDone: 0, quarantined: 1 });
    await store.markSectionDone({ id: "t2", startedAt: at, finishedAt: at, insertedByKind: { "speed-limit-segment": 5, "fixed-speed-camera": 2 }, skippedAlreadyDone: 0, quarantined: 0 });

    const [osm] = await collectSourceQuality(stateDir, { region: "bayern" });
    expect(osm).toMatchObject({ id: "osm@bayern", kind: "osm", imported: 21, discarded: 1, status: "incomplete (resumable)" });
    expect(osm!.notes.join("\n")).toMatch(/speed-limit-segment 15, static-sign 4, fixed-speed-camera 2/);
    expect(osm!.notes.join("\n")).toMatch(/only in the import log/);
  });

  it("renders a table and per-source reasons as Markdown", async () => {
    const md = renderQualityMarkdown(
      [{ id: "a", kind: "roadworks-feed", label: "roadworks feed a", imported: 3, discarded: 4, merged: 1, discardReasons: { "starts later": 3, "already ended": 1 }, status: "ok (t)", notes: ["a note"] }],
      new Date("2026-09-26T12:00:00Z"),
    );
    expect(md).toContain("| roadworks feed a | ok (t) | 3 | 4 | 1 |");
    expect(md).toContain("- 3 × starts later");
    expect(md).toContain("- 1 left out because another source already describes the same roadwork");
    expect(md).toContain("- a note");
  });
});
