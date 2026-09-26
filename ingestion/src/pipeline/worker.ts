import type { Env } from "../config/env.js";
import type { Region } from "../config/regions.js";
import type { SourceId } from "../config/sources.js";
import type { Logger } from "../logging.js";
import type { FixedSpeedCameraRow, SpeedLimitSegmentRow, StaticSignRow } from "../api/types.js";

export type NormalizedRow =
  | { kind: "speed-limit-segment"; key: string; row: SpeedLimitSegmentRow }
  | { kind: "static-sign"; key: string; row: StaticSignRow }
  | { kind: "fixed-speed-camera"; key: string; row: FixedSpeedCameraRow };

export interface WorkerContext {
  regionId: string;
  region: Region;
  logger: Logger;
  /** Where a worker may cache downloaded source data between runs (config/env.ts's DOWNLOAD_DIR) — never used for dedup/resume state, that's state/store.ts's job. */
  downloadDir: string;
  /** The (region, source) state directory (state/store.ts). Workers may store provenance files next to the progress log (e.g. extract-meta.json); they never touch the progress log itself. */
  stateDir: string;
  /** Scratch directory for randomly-accessed indexes (put it on an SSD); defaults to the worker's own work directory. */
  indexDir?: string;
  /** The run's environment configuration, for workers with source-specific settings (e.g. NVDB_NO_*). */
  env?: Env;
}

/**
 * A resumable unit of a large source (e.g. one geographic tile of a Europe
 * extract). The driver keeps a completion marker and stats per section id,
 * skips finished sections without reading them, and flushes its batches at
 * every section boundary.
 */
export interface WorkerSection {
  id: string;
  /** 1-based position among all sections, for progress logs. */
  index: number;
  total: number;
  rows: AsyncGenerator<NormalizedRow>;
}

/**
 * The one extension point new sources (P3.3) implement — everything else
 * (dedup, batching, POST, durable-mark, verification) lives once in
 * run-worker.ts and never changes per source. A worker's only job is to
 * yield normalized rows; it does not know about the bulk-import API, state
 * files, or retries.
 *
 * A source with a large input additionally implements `runSections`; the
 * driver prefers it over `run`. Sources without it are treated as one section.
 */
export interface SourceWorker {
  readonly id: SourceId;
  /** Why this source cannot import into the region, or undefined if it can. The CLI skips a source that cannot, with this reason. */
  supportsRegion?(region: Region): string | undefined;
  run(ctx: WorkerContext): AsyncGenerator<NormalizedRow>;
  runSections?(ctx: WorkerContext): AsyncGenerator<WorkerSection>;
}
