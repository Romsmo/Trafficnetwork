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
