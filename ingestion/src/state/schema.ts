import { z } from "zod";

/** One line per successfully committed batch — see state/store.ts's doc comment for why batch, not row, granularity. */
export const batchRecordSchema = z.object({
  batchId: z.string().min(1),
  kind: z.enum(["speed-limit-segment", "static-sign", "fixed-speed-camera"]),
  postedAt: z.string().datetime(),
  insertedCount: z.number().int().nonnegative(),
  /** Dedup keys for every row in this batch — see pipeline/worker.ts for the key format. */
  keys: z.array(z.string().min(1)),
});

export type BatchRecord = z.infer<typeof batchRecordSchema>;

export const runSummarySchema = z.object({
  startedAt: z.string().datetime(),
  lastResumedAt: z.string().datetime().optional(),
  downloadChecksum: z.string().optional(),
  toolVersion: z.string().optional(),
  status: z.enum(["running", "complete"]),
});

export type RunSummary = z.infer<typeof runSummarySchema>;

/**
 * A row that was deliberately NOT imported: either it failed client-side
 * validation against the server's schema, or the server rejected it (HTTP 400)
 * even as a single-row batch. The full row is kept so nothing is lost and an
 * operator can inspect or re-post it by hand. Its key counts as "handled" on
 * resume, otherwise every resume would re-discover and re-bisect the same row.
 */
export const quarantineRecordSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(["speed-limit-segment", "static-sign", "fixed-speed-camera"]),
  reason: z.enum(["client-validation", "server-rejected"]),
  detail: z.unknown().optional(),
  row: z.unknown(),
  at: z.string().datetime(),
});

export type QuarantineRecord = z.infer<typeof quarantineRecordSchema>;

/** Per-section completion record (state/store.ts `sections/<id>.json`). */
export const sectionStatsSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  insertedByKind: z.record(z.string(), z.number().int().nonnegative()),
  skippedAlreadyDone: z.number().int().nonnegative(),
  quarantined: z.number().int().nonnegative(),
});

export type SectionStats = z.infer<typeof sectionStatsSchema>;
