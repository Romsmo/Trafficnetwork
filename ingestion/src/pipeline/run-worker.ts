import { randomUUID } from "node:crypto";
import { ApiError } from "../api/client.js";
import { BULK_IMPORT_KINDS, type BulkImportKind, type BulkImportPoster, type BulkImportRow } from "../api/types.js";
import { Batcher } from "../batching/batcher.js";
import type { Env } from "../config/env.js";
import type { Region } from "../config/regions.js";
import type { Logger } from "../logging.js";
import type { KeySet } from "../state/keyset.js";
import type { StateStore } from "../state/store.js";
import { validateRow } from "./validate.js";
import type { NormalizedRow, SourceWorker, WorkerContext, WorkerSection } from "./worker.js";

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
  /**
   * The server has no dedup. On a fresh start (no local progress) the run refuses to start
   * against a server that already holds static data, because importing a region into a server
   * that already contains it silently doubles it. Set this only to import on purpose into a
   * non-empty server (e.g. a different region).
   */
  allowNonEmpty?: boolean;
  /** Minimum pause after each committed batch — a pacing floor that keeps the server's CPU/IO bounded. Default 0. */
  batchPacingMs?: number;
  /** Abort when more rows than this were quarantined in total: that indicates a systematic problem, not stray bad data. Default 500. */
  maxQuarantined?: number;
  /** Process only these section ids (never marks the run complete). */
  onlySections?: string[];
  /** Passed to the worker as WorkerContext.indexDir. */
  indexDir?: string;
  /** Passed to the worker as WorkerContext.env. */
  env?: Env;
  /** How often the progress line is logged. Default 60 s. */
  progressIntervalMs?: number;
  /**
   * Test-only: an artificial pause after each durably-recorded batch. On a
   * real server over a real network a batch takes long enough for a "kill
   * mid-run" test to land between batches; against a tiny fixture over
   * localhost, three batches can complete in under a millisecond combined —
   * too fast for any external poll loop to ever observe an intermediate
   * state. Never set outside tests/integration/full-cycle.test.ts.
   */
  testOnlyBatchDelayMs?: number;
}

export interface RunWorkerResult {
  insertedByKind: Record<BulkImportKind, number>;
  skippedAlreadyDone: number;
  quarantined: number;
  sectionsProcessed: number;
  sectionsSkipped: number;
  shortCircuited: boolean;
}

function emptyCounts(): Record<BulkImportKind, number> {
  return { "speed-limit-segment": 0, "static-sign": 0, "fixed-speed-camera": 0 };
}

async function* singleSection(rows: AsyncGenerator<NormalizedRow>): AsyncGenerator<WorkerSection> {
  yield { id: "all", index: 1, total: 1, rows };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Source-agnostic driver: owns state/resume, batching, dedupe-filtering,
 * POST + durable-mark, for every SourceWorker identically (see worker.ts's
 * doc comment). This is the one place that must get the idempotency
 * write-ordering right — see state/store.ts and the plan's decision 4:
 * a row is only ever marked done *after* a response whose `inserted` count
 * matches what was sent, and only once that mark is durably fsync'd.
 *
 * Europe-scale additions (docs/europe-feasibility.md §7): sections with their
 * own completion markers, client-side validation, bisect-and-quarantine of
 * batches the server rejects, the empty-target guard, pacing and a periodic
 * progress line.
 */
export async function runWorker(options: RunWorkerOptions): Promise<RunWorkerResult> {
  const { worker, regionId, region, apiClient, stateStore, logger, batchSize, dryRun, downloadDir, testOnlyBatchDelayMs } = options;
  const batchPacingMs = options.batchPacingMs ?? 0;
  const maxQuarantined = options.maxQuarantined ?? 500;
  const progressIntervalMs = options.progressIntervalMs ?? 60_000;

  await stateStore.init();

  if (stateStore.isComplete()) {
    logger.info({ region: region.name, source: worker.id }, "already imported (complete.marker present) — nothing to do; use --fresh to force a full re-run");
    return { insertedByKind: emptyCounts(), skippedAlreadyDone: 0, quarantined: 0, sectionsProcessed: 0, sectionsSkipped: 0, shortCircuited: true };
  }

  if (!dryRun && !options.allowNonEmpty && apiClient.isStaticDataEmpty && !(await stateStore.hasProgress())) {
    if (!(await apiClient.isStaticDataEmpty())) {
      throw new Error(
        `Refusing to start: the target server already contains static data and this run has no local progress for region "${regionId}". ` +
          "The server has no dedup, so importing a region it may already hold would silently duplicate it. " +
          "If this is deliberate (e.g. importing a different region into a populated server), re-run with --allow-non-empty.",
      );
    }
  }

  const doneKeys: KeySet = await stateStore.loadDoneKeys();
  const previouslyQuarantined = await stateStore.countQuarantined();
  logger.info({ region: region.name, source: worker.id, alreadyDone: doneKeys.size, previouslyQuarantined }, "starting (resuming from local progress state if any)");

  const existingSummary = await stateStore.readRunSummary();
  if (!dryRun) {
    await stateStore.writeRunSummary({
      startedAt: existingSummary?.startedAt ?? new Date().toISOString(),
      lastResumedAt: existingSummary ? new Date().toISOString() : undefined,
      status: "running",
    });
  }

  const insertedByKind = emptyCounts();
  let skippedAlreadyDone = 0;
  let quarantinedThisRun = 0;
  let sectionsProcessed = 0;
  let sectionsSkipped = 0;
  // The clock for rows/s starts when the first section begins importing — not at process start, which would
  // include the (hours-long) download and osmium phases and make the rate look wrong.
  let importStartedAt: number | undefined;
  let lastProgressLogAt = Date.now();
  let currentSection = { id: "-", index: 0, total: 0 };
  let sectionInserted = emptyCounts();

  const totalInserted = (): number => BULK_IMPORT_KINDS.reduce((sum, kind) => sum + insertedByKind[kind], 0);

  const logProgress = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastProgressLogAt < progressIntervalMs) return;
    lastProgressLogAt = now;
    const elapsedS = Math.max(1, (now - (importStartedAt ?? now)) / 1000);
    logger.info(
      {
        section: currentSection.id,
        sectionIndex: currentSection.index,
        sectionTotal: currentSection.total,
        inserted: totalInserted(),
        insertedByKind,
        skippedAlreadyDone,
        quarantined: quarantinedThisRun,
        rowsPerSecond: Math.round(totalInserted() / elapsedS),
        elapsedMinutes: Math.round(elapsedS / 6) / 10,
      },
      "progress",
    );
  };

  const quarantine = async (normalized: NormalizedRow, reason: "client-validation" | "server-rejected", detail: unknown): Promise<void> => {
    await stateStore.appendQuarantine({ key: normalized.key, kind: normalized.kind, reason, detail, row: normalized.row, at: new Date().toISOString() });
    doneKeys.add(normalized.key);
    quarantinedThisRun++;
    logger.warn({ key: normalized.key, reason, detail }, "row quarantined (not imported) — see quarantine.ndjson");
    if (previouslyQuarantined + quarantinedThisRun > maxQuarantined) {
      throw new Error(
        `Aborting: more than ${maxQuarantined} rows were quarantined in total (${previouslyQuarantined + quarantinedThisRun}). ` +
          "That points to a systematic mismatch between the data and the server's schema, not stray bad rows — inspect quarantine.ndjson before resuming.",
      );
    }
  };

  /** One POST + durable mark. Throws ApiError on a non-2xx (bisect logic upstream decides what to do with a 400). */
  const commit = async (kind: BulkImportKind, batch: NormalizedRow[]): Promise<void> => {
    // Safe by construction: `batch` was accumulated per kind, so every element's `.row` is that
    // kind's row shape — postBatch's generic parameter just can't see that grouping-by-runtime-key already proved it.
    const rows = batch.map((r) => r.row) as BulkImportRow<typeof kind>[];
    const keys = batch.map((r) => r.key);
    const response = await apiClient.postBatch(kind, rows);
    if (response.inserted !== rows.length) {
      throw new Error(
        `Bulk import anomaly for kind=${kind}: posted ${rows.length} rows but server reported inserted=${response.inserted} — aborting rather than marking this batch done (see state/store.ts's write-ordering contract; a partial-looking response here means something is wrong enough to stop, not paper over)`,
      );
    }
    await stateStore.appendBatch({ batchId: randomUUID(), kind, postedAt: new Date().toISOString(), insertedCount: response.inserted, keys });
    for (const key of keys) doneKeys.add(key);
    insertedByKind[kind] += response.inserted;
    sectionInserted[kind] += response.inserted;
    logger.debug({ kind, count: response.inserted }, "batch imported");
    if (batchPacingMs > 0) await sleep(batchPacingMs);
    if (testOnlyBatchDelayMs) await sleep(testOnlyBatchDelayMs);
    logProgress();
  };

  /**
   * A 400 means the server validated the body and rejected it *before inserting anything* (routes.ts
   * parses the whole body first), so re-posting halves cannot duplicate rows.
   *
   * A 413 (body too large) is safe to bisect for the same reason: Fastify's body-size limit is enforced
   * while the request body is read, before the route handler (and any DB write) ever runs — confirmed by
   * reading server/src/app.ts (no custom bodyLimit, so Fastify's 1 MiB default applies uniformly). At
   * Europe scale a batch of long speed-limit-segment LineStrings routinely exceeds it even at a modest
   * BATCH_SIZE (hit for real on 2026-09-25: "413 Request body is too large" aborted the whole run instead
   * of being handled); bisecting converges on a batch size the server accepts without needing a static
   * BATCH_SIZE tuned per row kind. An OSM way's node count is capped at 2000 by the OSM API itself, so a
   * single row can never itself be the cause — reaching batch.length===1 here would mean the server's
   * limit is smaller than one row, an actual data problem, so that row is quarantined rather than retried
   * forever.
   */
  const postWithBisect = async (kind: BulkImportKind, batch: NormalizedRow[]): Promise<void> => {
    try {
      await commit(kind, batch);
    } catch (err) {
      if (!(err instanceof ApiError) || (err.status !== 400 && err.status !== 413)) throw err;
      if (batch.length === 1) {
        await quarantine(batch[0]!, "server-rejected", err.body?.error?.details ?? err.message);
        return;
      }
      const reason = err.status === 413 ? "server rejected the batch (413, too large) — bisecting to find a size it accepts" : "server rejected the batch (400) — bisecting to isolate the offending row(s)";
      logger.warn({ kind, size: batch.length, status: err.status }, reason);
      const middle = batch.length >> 1;
      await postWithBisect(kind, batch.slice(0, middle));
      await postWithBisect(kind, batch.slice(middle));
    }
  };

  const flushBatch = async (kind: BulkImportKind, batch: NormalizedRow[]): Promise<void> => {
    if (dryRun) {
      logger.info({ kind, count: batch.length }, "[dry-run] would POST batch (not sent)");
      return;
    }
    const valid: NormalizedRow[] = [];
    for (const normalized of batch) {
      const problem = validateRow(normalized);
      if (problem) await quarantine(normalized, "client-validation", problem);
      else valid.push(normalized);
    }
    if (valid.length > 0) await postWithBisect(kind, valid);
  };

  const ctx: WorkerContext = { regionId, region, logger, downloadDir, stateDir: stateStore.directory, indexDir: options.indexDir, env: options.env };
  const sections = worker.runSections ? worker.runSections(ctx) : singleSection(worker.run(ctx));

  for await (const section of sections) {
    if (options.onlySections && !options.onlySections.includes(section.id)) {
      await section.rows.return(undefined);
      continue;
    }
    if (await stateStore.isSectionDone(section.id)) {
      logger.info({ section: section.id, index: section.index, total: section.total }, "section already complete — skipping");
      await section.rows.return(undefined);
      sectionsSkipped++;
      continue;
    }

    importStartedAt ??= Date.now();
    currentSection = { id: section.id, index: section.index, total: section.total };
    const sectionStartedAt = new Date().toISOString();
    const skippedBefore = skippedAlreadyDone;
    const quarantinedBefore = quarantinedThisRun;
    sectionInserted = emptyCounts();
    logger.info({ section: section.id, index: section.index, total: section.total }, "section started");

    const batchers: Record<BulkImportKind, Batcher<NormalizedRow>> = {
      "speed-limit-segment": new Batcher(batchSize),
      "static-sign": new Batcher(batchSize),
      "fixed-speed-camera": new Batcher(batchSize),
    };

    for await (const normalized of section.rows) {
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

    sectionsProcessed++;
    if (!dryRun) {
      await stateStore.markSectionDone({
        id: section.id,
        startedAt: sectionStartedAt,
        finishedAt: new Date().toISOString(),
        insertedByKind: { ...sectionInserted },
        skippedAlreadyDone: skippedAlreadyDone - skippedBefore,
        quarantined: quarantinedThisRun - quarantinedBefore,
      });
    }
    logger.info(
      { section: section.id, index: section.index, total: section.total, inserted: { ...sectionInserted }, skippedAlreadyDone: skippedAlreadyDone - skippedBefore, quarantined: quarantinedThisRun - quarantinedBefore },
      "section finished",
    );
    logProgress(true);
  }

  if (!dryRun && !options.onlySections) {
    const summary = await stateStore.readRunSummary();
    await stateStore.writeRunSummary({ startedAt: summary?.startedAt ?? new Date().toISOString(), status: "complete" });
    await stateStore.markComplete();
  }

  logger.info({ insertedByKind, skippedAlreadyDone, quarantined: quarantinedThisRun, sectionsProcessed, sectionsSkipped }, "run finished");
  return { insertedByKind, skippedAlreadyDone, quarantined: quarantinedThisRun, sectionsProcessed, sectionsSkipped, shortCircuited: false };
}
