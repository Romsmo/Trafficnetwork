import type { Region } from "../config/regions.js";
import type { SourceId } from "../config/sources.js";
import type { Logger } from "../logging.js";
import type { FixedSpeedCameraRow, SpeedLimitSegmentRow, StaticSignRow } from "../api/types.js";

export type NormalizedRow =
  | { kind: "speed-limit-segment"; key: string; row: SpeedLimitSegmentRow }
  | { kind: "static-sign"; key: string; row: StaticSignRow }
  | { kind: "fixed-speed-camera"; key: string; row: FixedSpeedCameraRow };

export interface WorkerContext {
  region: Region;
  logger: Logger;
}

/**
 * The one extension point new sources (P3.3) implement — everything else
 * (dedup, batching, POST, durable-mark, verification) lives once in
 * run-worker.ts and never changes per source. A worker's only job is to
 * yield normalized rows; it does not know about the bulk-import API, state
 * files, or retries.
 */
export interface SourceWorker {
  readonly id: SourceId;
  run(ctx: WorkerContext): AsyncGenerator<NormalizedRow>;
}
