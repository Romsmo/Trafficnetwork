import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { BulkImportKind, BulkImportPoster, BulkImportResponse, BulkImportRow } from "../../src/api/types.js";
import type { Region } from "../../src/config/regions.js";
import { runWorker } from "../../src/pipeline/run-worker.js";
import type { NormalizedRow, SourceWorker, WorkerContext } from "../../src/pipeline/worker.js";
import { StateStore } from "../../src/state/store.js";

const region: Region = {
  name: "Test Region",
  geofabrikExtractUrl: "https://example.invalid/extract.osm.pbf",
  geofabrikChecksumUrl: "https://example.invalid/extract.osm.pbf.md5",
  bbox: [0, 0, 1, 1],
};

const silentLogger = pino({ level: "silent" });

function fakeWorker(rows: NormalizedRow[]): SourceWorker {
  return {
    id: "osm",
    async *run(_ctx: WorkerContext) {
      for (const row of rows) yield row;
    },
  };
}

function segmentRow(id: number): NormalizedRow {
  return {
    kind: "speed-limit-segment",
    key: `speed-limit-segment:way/${id}`,
    row: { lineString: [[0, 0], [1, 1]], speedLimit: 50, speedLimitUnit: "kmh", source: "osm", sourceLicense: "ODbL" },
  };
}

function signRow(id: number): NormalizedRow {
  return {
    kind: "static-sign",
    key: `static-sign:node/${id}`,
    row: { lat: 0, lng: 0, signType: "DE:274-50", source: "osm", sourceLicense: "ODbL" },
  };
}

/** Records every call and always reports inserted === rows.length, unless overridden. */
function fakeApiClient(overrides: Partial<Record<BulkImportKind, number>> = {}): BulkImportPoster & { calls: { kind: BulkImportKind; rows: unknown[] }[] } {
  const calls: { kind: BulkImportKind; rows: unknown[] }[] = [];
  return {
    calls,
    async postBatch<K extends BulkImportKind>(kind: K, rows: BulkImportRow<K>[]): Promise<BulkImportResponse> {
      calls.push({ kind, rows });
      return { inserted: overrides[kind] ?? rows.length };
    },
  };
}

describe("runWorker", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "ingestion-run-worker-test-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("batches rows per kind, posts them, and records progress", async () => {
    const rows = [segmentRow(1), segmentRow(2), signRow(1)];
    const apiClient = fakeApiClient();
    const stateStore = new StateStore(stateDir, "bayern", "osm");

    const result = await runWorker({ worker: fakeWorker(rows), regionId: "test-region", region, downloadDir: "/tmp/ingestion-test-downloads", apiClient, stateStore, logger: silentLogger, batchSize: 10, dryRun: false });

    expect(result.insertedByKind["speed-limit-segment"]).toBe(2);
    expect(result.insertedByKind["static-sign"]).toBe(1);
    expect(result.skippedAlreadyDone).toBe(0);
    expect(apiClient.calls).toHaveLength(2); // one flush per kind on final flush
    expect(stateStore.isComplete()).toBe(true);
  });

  it("splits a kind's rows across multiple batches once batchSize is reached", async () => {
    const rows = [segmentRow(1), segmentRow(2), segmentRow(3)];
    const apiClient = fakeApiClient();
    const stateStore = new StateStore(stateDir, "bayern", "osm");

    await runWorker({ worker: fakeWorker(rows), regionId: "test-region", region, downloadDir: "/tmp/ingestion-test-downloads", apiClient, stateStore, logger: silentLogger, batchSize: 2, dryRun: false });

    const segmentCalls = apiClient.calls.filter((c) => c.kind === "speed-limit-segment");
    expect(segmentCalls.map((c) => c.rows.length)).toEqual([2, 1]);
  });

  it("skips rows already recorded from a prior run and does not re-post them", async () => {
    const stateStore = new StateStore(stateDir, "bayern", "osm");
    await stateStore.init();
    await stateStore.appendBatch({
      batchId: "prior",
      kind: "speed-limit-segment",
      postedAt: new Date().toISOString(),
      insertedCount: 1,
      keys: ["speed-limit-segment:way/1"],
    });

    const rows = [segmentRow(1), segmentRow(2)];
    const apiClient = fakeApiClient();

    const result = await runWorker({ worker: fakeWorker(rows), regionId: "test-region", region, downloadDir: "/tmp/ingestion-test-downloads", apiClient, stateStore, logger: silentLogger, batchSize: 10, dryRun: false });

    expect(result.skippedAlreadyDone).toBe(1);
    expect(result.insertedByKind["speed-limit-segment"]).toBe(1);
    const postedIds = apiClient.calls.flatMap((c) => c.rows);
    expect(postedIds).toHaveLength(1);
  });

  it("short-circuits without calling the worker when complete.marker already exists", async () => {
    const stateStore = new StateStore(stateDir, "bayern", "osm");
    await stateStore.init();
    await stateStore.markComplete();

    const runSpy = vi.fn(async function* () {
      // should never run
    });
    const worker: SourceWorker = { id: "osm", run: runSpy as unknown as SourceWorker["run"] };
    const apiClient = fakeApiClient();

    const result = await runWorker({ worker, regionId: "test-region", region, downloadDir: "/tmp/ingestion-test-downloads", apiClient, stateStore, logger: silentLogger, batchSize: 10, dryRun: false });

    expect(result.shortCircuited).toBe(true);
    expect(runSpy).not.toHaveBeenCalled();
    expect(apiClient.calls).toHaveLength(0);
  });

  it("throws and does not mark the batch done when the server's inserted count doesn't match", async () => {
    const rows = [segmentRow(1), segmentRow(2)];
    const apiClient = fakeApiClient({ "speed-limit-segment": 1 }); // anomaly: posted 2, server says 1
    const stateStore = new StateStore(stateDir, "bayern", "osm");

    await expect(runWorker({ worker: fakeWorker(rows), regionId: "test-region", region, downloadDir: "/tmp/ingestion-test-downloads", apiClient, stateStore, logger: silentLogger, batchSize: 10, dryRun: false })).rejects.toThrow(
      /anomaly/i,
    );

    expect(await stateStore.loadDoneKeys()).toEqual(new Set());
    expect(stateStore.isComplete()).toBe(false);
  });

  it("dry-run sends nothing and leaves no state behind", async () => {
    const rows = [segmentRow(1)];
    const apiClient = fakeApiClient();
    const stateStore = new StateStore(stateDir, "bayern", "osm");

    const result = await runWorker({ worker: fakeWorker(rows), regionId: "test-region", region, downloadDir: "/tmp/ingestion-test-downloads", apiClient, stateStore, logger: silentLogger, batchSize: 10, dryRun: true });

    expect(apiClient.calls).toHaveLength(0);
    expect(result.insertedByKind["speed-limit-segment"]).toBe(0);
    expect(stateStore.isComplete()).toBe(false);
  });
});
