import { randomUUID } from "node:crypto";
import { BULK_IMPORT_KINDS, type BulkImportKind, type BulkImportPoster, type BulkImportRow } from "../api/types.js";
import { Batcher } from "../batching/batcher.js";
import type { Region } from "../config/regions.js";
import type { Logger } from "../logging.js";
import type { StateStore } from "../state/store.js";
import type { NormalizedRow, SourceWorker } from "./worker.js";

export interface RunWorkerOptions {
  worker: SourceWorker;
  regionId: string;
  region: Region;
  apiClient: BulkImportPoster;
  stateStore: StateStore;
  logger: Logger;
  batchSize: number;
  dryRun: boolean;
  downloadDir: string;
}

export interface RunWorkerResult {
  insertedByKind: Record<BulkImportKind, number>;
  skippedAlreadyDone: number;
  shortCircuited: boolean;
}

function emptyCounts(): Record<BulkImportKind, number> {
  return { "speed-limit-segment": 0, "static-sign": 0, "fixed-speed-camera": 0 };
}

/**
 * Source-agnostic driver: owns state/resume, batching, dedupe-filtering,
 * POST + durable-mark, for every SourceWorker identically (see worker.ts's
 * doc comment). This is the one place that must get the idempotency
 * write-ordering right — see state/store.ts and the plan's decision 4:
 * a row is only ever marked done *after* a response whose `inserted` count
 * matches what was sent, and only once that mark is durably fsync'd.
 */
export async function runWorker(options: RunWorkerOptions): Promise<RunWorkerResult> {
  const { worker, regionId, region, apiClient, stateStore, logger, batchSize, dryRun, downloadDir } = options;

  await stateStore.init();

  if (stateStore.isComplete()) {
    logger.info({ region: region.name, source: worker.id }, "already imported (complete.marker present) — nothing to do; use --fresh to force a full re-run");
    return { insertedByKind: emptyCounts(), skippedAlreadyDone: 0, shortCircuited: true };
  }

  const doneKeys = await stateStore.loadDoneKeys();
  logger.info({ region: region.name, source: worker.id, alreadyDone: doneKeys.size }, "starting (resuming from local progress state if any)");

  const existingSummary = await stateStore.readRunSummary();
  if (!dryRun) {
    await stateStore.writeRunSummary({
      startedAt: existingSummary?.startedAt ?? new Date().toISOString(),
      lastResumedAt: existingSummary ? new Date().toISOString() : undefined,
      status: "running",
    });
  }

  const batchers: Record<BulkImportKind, Batcher<NormalizedRow>> = {
    "speed-limit-segment": new Batcher(batchSize),
    "static-sign": new Batcher(batchSize),
    "fixed-speed-camera": new Batcher(batchSize),
  };

  const insertedByKind = emptyCounts();
  let skippedAlreadyDone = 0;

  const flushBatch = async (kind: BulkImportKind, batch: NormalizedRow[]): Promise<void> => {
    if (dryRun) {
      logger.info({ kind, count: batch.length }, "[dry-run] would POST batch (not sent)");
      return;
    }
    // Safe by construction: `batch` was accumulated in `batchers[kind]`, so
    // every element's `.row` is that kind's row shape — postBatch's generic
    // parameter just can't see that grouping-by-runtime-key already proved it.
    const rows = batch.map((r) => r.row) as BulkImportRow<typeof kind>[];
    const keys = batch.map((r) => r.key);
    const response = await apiClient.postBatch(kind, rows);
    if (response.inserted !== rows.length) {
      throw new Error(
        `Bulk import anomaly for kind=${kind}: posted ${rows.length} rows but server reported inserted=${response.inserted} — aborting rather than marking this batch done (see state/store.ts's write-ordering contract; a partial-looking response here means something is wrong enough to stop, not paper over)`,
      );
    }
    await stateStore.appendBatch({ batchId: randomUUID(), kind, postedAt: new Date().toISOString(), insertedCount: response.inserted, keys });
    insertedByKind[kind] += response.inserted;
    logger.info({ kind, count: response.inserted }, "batch imported");
  };

  for await (const normalized of worker.run({ regionId, region, logger, downloadDir })) {
    if (doneKeys.has(normalized.key)) {
      skippedAlreadyDone++;
      continue;
    }
    const full = batchers[normalized.kind].add(normalized);
    if (full) await flushBatch(normalized.kind, full);
  }

  for (const kind of BULK_IMPORT_KINDS) {
    const remainder = batchers[kind].flush();
    if (remainder) await flushBatch(kind, remainder);
  }

  if (!dryRun) {
    const summary = await stateStore.readRunSummary();
    await stateStore.writeRunSummary({ startedAt: summary?.startedAt ?? new Date().toISOString(), status: "complete" });
    await stateStore.markComplete();
  }

  logger.info({ insertedByKind, skippedAlreadyDone }, "run finished");
  return { insertedByKind, skippedAlreadyDone, shortCircuited: false };
}
