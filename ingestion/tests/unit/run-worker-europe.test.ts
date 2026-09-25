import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/client.js";
import type { BulkImportKind, BulkImportPoster, BulkImportResponse, BulkImportRow } from "../../src/api/types.js";
import type { Region } from "../../src/config/regions.js";
import { runWorker, type RunWorkerOptions } from "../../src/pipeline/run-worker.js";
import type { NormalizedRow, SourceWorker, WorkerContext, WorkerSection } from "../../src/pipeline/worker.js";
import { StateStore } from "../../src/state/store.js";

const region: Region = {
  name: "Test Region",
  geofabrikExtractUrl: "https://example.invalid/extract.osm.pbf",
  geofabrikChecksumUrl: "https://example.invalid/extract.osm.pbf.md5",
  bbox: [0, 0, 1, 1],
};

const silentLogger = pino({ level: "silent" });

function segment(id: number, source = "osm", speedLimit = 50): NormalizedRow {
  return {
    kind: "speed-limit-segment",
    key: `speed-limit-segment:way/${id}`,
    row: { lineString: [[0, 0], [1, 1]], speedLimit, speedLimitUnit: "kmh", source, sourceLicense: "ODbL" },
  };
}

async function* rowsOf(rows: NormalizedRow[]): AsyncGenerator<NormalizedRow> {
  for (const row of rows) yield row;
}

function sectionedWorker(sections: Record<string, NormalizedRow[]>): SourceWorker & { started: string[] } {
  const started: string[] = [];
  return {
    id: "osm",
    started,
    async *run() {
      for (const rows of Object.values(sections)) yield* rowsOf(rows);
    },
    async *runSections(_ctx: WorkerContext): AsyncGenerator<WorkerSection> {
      const ids = Object.keys(sections);
      let index = 0;
      for (const id of ids) {
        index++;
        started.push(id);
        yield { id, index, total: ids.length, rows: rowsOf(sections[id]!) };
      }
    },
  };
}

type Poster = BulkImportPoster & { posted: unknown[][]; emptyChecks: number };

/** Server fake: rejects (400) every batch that contains a row with source "bad", like the real Zod-validated route would reject a whole batch. */
function fakeServer(options: { empty?: boolean; failOnPost?: number } = {}): Poster {
  const posted: unknown[][] = [];
  let posts = 0;
  const poster: Poster = {
    posted,
    emptyChecks: 0,
    async postBatch<K extends BulkImportKind>(_kind: K, rows: BulkImportRow<K>[]): Promise<BulkImportResponse> {
      posts++;
      if (options.failOnPost !== undefined && posts === options.failOnPost) throw new Error("simulated network failure");
      if (rows.some((row) => (row as { source: string }).source === "bad")) {
        throw new ApiError("Bulk import failed: 400 Invalid request body", 400, { error: { code: "VALIDATION", message: "Invalid request body", details: [{ path: ["rows", 0, "source"] }] } });
      }
      posted.push(rows);
      return { inserted: rows.length };
    },
  };
  if (options.empty !== undefined) {
    poster.isStaticDataEmpty = async () => {
      poster.emptyChecks++;
      return options.empty!;
    };
  }
  return poster;
}

describe("runWorker — Europe-scale behaviour", () => {
  let stateDir: string;
  let stateStore: StateStore;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "ingestion-run-europe-test-"));
    stateStore = new StateStore(stateDir, "europe", "osm");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  const run = (overrides: Partial<RunWorkerOptions> & Pick<RunWorkerOptions, "worker" | "apiClient">) =>
    runWorker({ regionId: "europe", region, downloadDir: stateDir, stateStore, logger: silentLogger, batchSize: 4, dryRun: false, ...overrides });

  describe("sections", () => {
    it("imports every section, records per-section stats and marks the run complete", async () => {
      const worker = sectionedWorker({ x10_y40: [segment(1), segment(2), segment(3)], x0_y40: [segment(4), segment(5)] });
      const server = fakeServer();
      const result = await run({ worker, apiClient: server });

      expect(result.insertedByKind["speed-limit-segment"]).toBe(5);
      expect(result.sectionsProcessed).toBe(2);
      const stats = await stateStore.readSectionStats();
      expect(Object.fromEntries(stats.map((s) => [s.id, s.insertedByKind["speed-limit-segment"]]))).toEqual({ x10_y40: 3, x0_y40: 2 });
      expect(stateStore.isComplete()).toBe(true);
    });

    it("flushes at every section boundary, so a batch never spans two sections", async () => {
      const server = fakeServer();
      await run({ worker: sectionedWorker({ a: [segment(1), segment(2)], b: [segment(3)] }), apiClient: server, batchSize: 10 });
      expect(server.posted.map((batch) => batch.length)).toEqual([2, 1]);
    });

    it("skips finished sections without reading them when the run is repeated without complete.marker", async () => {
      const worker = sectionedWorker({ a: [segment(1)], b: [segment(2)] });
      await run({ worker, apiClient: fakeServer() });
      await import("node:fs/promises").then((fs) => fs.rm(path.join(stateStore.directory, "complete.marker")));

      const again = fakeServer();
      const result = await run({ worker: sectionedWorker({ a: [segment(1)], b: [segment(2)] }), apiClient: again });
      expect(result.sectionsSkipped).toBe(2);
      expect(again.posted).toHaveLength(0);
    });

    it("resumes after a failure in the middle of a section: finished sections are skipped, the rest is imported exactly once", async () => {
      const sections = { a: [segment(1), segment(2)], b: [segment(3), segment(4), segment(5), segment(6), segment(7), segment(8)] };
      const first = fakeServer({ failOnPost: 2 }); // section a = post 1, section b's first batch (4 rows) = post 2 → fails
      await expect(run({ worker: sectionedWorker(sections), apiClient: first })).rejects.toThrow(/simulated network failure/);
      expect(stateStore.isComplete()).toBe(false);
      expect(await stateStore.isSectionDone("a")).toBe(true);
      expect(await stateStore.isSectionDone("b")).toBe(false);

      const second = fakeServer();
      const result = await run({ worker: sectionedWorker(sections), apiClient: second });
      const allPosted = [...first.posted, ...second.posted].flat().length;
      expect(allPosted).toBe(8); // every row exactly once across both runs
      expect(result.sectionsSkipped).toBe(1);
      expect(stateStore.isComplete()).toBe(true);
    });

    it("--section: imports only the named sections and does not mark the run complete", async () => {
      const worker = sectionedWorker({ a: [segment(1)], b: [segment(2)] });
      const server = fakeServer();
      const result = await run({ worker, apiClient: server, onlySections: ["b"] });
      expect(result.insertedByKind["speed-limit-segment"]).toBe(1);
      expect(await stateStore.isSectionDone("a")).toBe(false);
      expect(await stateStore.isSectionDone("b")).toBe(true);
      expect(stateStore.isComplete()).toBe(false);
    });
  });

  describe("validation, bisect and quarantine", () => {
    it("quarantines rows that fail client-side validation and never posts them", async () => {
      const server = fakeServer();
      const result = await run({ worker: sectionedWorker({ a: [segment(1), segment(2, "osm", 0), segment(3), segment(4, "osm", 900)] }), apiClient: server });
      expect(result.insertedByKind["speed-limit-segment"]).toBe(2);
      expect(result.quarantined).toBe(2);
      const lines = readFileSync(path.join(stateStore.directory, "quarantine.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { key: string; reason: string });
      expect(lines.map((l) => [l.key, l.reason])).toEqual([
        ["speed-limit-segment:way/2", "client-validation"],
        ["speed-limit-segment:way/4", "client-validation"],
      ]);
    });

    it("bisects a batch the server rejects with 400 and quarantines only the offending row", async () => {
      const rows = [segment(1), segment(2), segment(3), segment(4, "bad"), segment(5), segment(6), segment(7), segment(8)];
      const server = fakeServer();
      const result = await run({ worker: sectionedWorker({ a: rows }), apiClient: server, batchSize: 8 });

      expect(result.insertedByKind["speed-limit-segment"]).toBe(7);
      expect(result.quarantined).toBe(1);
      expect(server.posted.flat()).toHaveLength(7);
      const quarantined = readFileSync(path.join(stateStore.directory, "quarantine.ndjson"), "utf8");
      expect(quarantined).toContain("speed-limit-segment:way/4");
      expect(quarantined).toContain("server-rejected");
      expect(quarantined).toContain('"detail":[{"path":["rows",0,"source"]}]'); // the server's own error details are kept with the row
      expect(stateStore.isComplete()).toBe(true);
    });

    it("does not retry a quarantined row on resume", async () => {
      const rows = [segment(1), segment(2, "bad"), segment(3)];
      await run({ worker: sectionedWorker({ a: rows }), apiClient: fakeServer() });
      await import("node:fs/promises").then((fs) => fs.rm(path.join(stateStore.directory, "sections"), { recursive: true, force: true }));
      await import("node:fs/promises").then((fs) => fs.rm(path.join(stateStore.directory, "complete.marker")));

      const server = fakeServer();
      const result = await run({ worker: sectionedWorker({ a: rows }), apiClient: server });
      expect(server.posted).toHaveLength(0);
      expect(result.skippedAlreadyDone).toBe(3);
    });

    it("aborts when far more rows are quarantined than stray bad data would explain", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => segment(i + 1, "osm", 0)); // all fail client validation
      await expect(run({ worker: sectionedWorker({ a: rows }), apiClient: fakeServer(), maxQuarantined: 3 })).rejects.toThrow(/more than 3 rows were quarantined/);
      expect(stateStore.isComplete()).toBe(false);
    });

    it("still aborts on a non-400 server error instead of quarantining", async () => {
      await expect(run({ worker: sectionedWorker({ a: [segment(1)] }), apiClient: fakeServer({ failOnPost: 1 }) })).rejects.toThrow(/simulated network failure/);
      expect(existsSync(path.join(stateStore.directory, "quarantine.ndjson"))).toBe(false);
    });
  });

  describe("empty-target guard", () => {
    it("refuses a fresh start against a server that already holds data", async () => {
      const server = fakeServer({ empty: false });
      await expect(run({ worker: sectionedWorker({ a: [segment(1)] }), apiClient: server })).rejects.toThrow(/Refusing to start.*--allow-non-empty/s);
      expect(server.posted).toHaveLength(0);
    });

    it("starts against an empty server", async () => {
      const server = fakeServer({ empty: true });
      const result = await run({ worker: sectionedWorker({ a: [segment(1)] }), apiClient: server });
      expect(result.insertedByKind["speed-limit-segment"]).toBe(1);
      expect(server.emptyChecks).toBe(1);
    });

    it("can be overridden on purpose", async () => {
      const server = fakeServer({ empty: false });
      const result = await run({ worker: sectionedWorker({ a: [segment(1)] }), apiClient: server, allowNonEmpty: true });
      expect(result.insertedByKind["speed-limit-segment"]).toBe(1);
      expect(server.emptyChecks).toBe(0);
    });

    it("does not apply to a resume: a server that holds the run's own earlier rows is expected to be non-empty", async () => {
      const first = fakeServer({ empty: true, failOnPost: 2 });
      await expect(run({ worker: sectionedWorker({ a: [segment(1)], b: [segment(2)] }), apiClient: first })).rejects.toThrow(/simulated/);

      const resumed = fakeServer({ empty: false }); // the server now holds section a
      const result = await run({ worker: sectionedWorker({ a: [segment(1)], b: [segment(2)] }), apiClient: resumed });
      expect(result.insertedByKind["speed-limit-segment"]).toBe(1);
      expect(resumed.emptyChecks).toBe(0);
    });
  });
});
