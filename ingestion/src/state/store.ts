import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { batchRecordSchema, runSummarySchema, type BatchRecord, type RunSummary } from "./schema.js";

/**
 * Per (region, source) local progress state — the *only* thing standing
 * between a resumed run and re-posting rows the server already accepted,
 * since server/src/db/queries/bulk-import.ts has no dedup/unique constraint
 * of its own (confirmed by reading it directly during planning). One line
 * per successfully committed batch, not per row: the batch is the actual
 * POST/commit boundary, and per-row granularity would multiply file size for
 * no durability benefit.
 */
export class StateStore {
  private readonly dir: string;

  constructor(stateDir: string, region: string, source: string) {
    this.dir = path.join(stateDir, region, source);
  }

  private get progressPath(): string {
    return path.join(this.dir, "progress.ndjson");
  }

  private get runSummaryPath(): string {
    return path.join(this.dir, "run.json");
  }

  private get completeMarkerPath(): string {
    return path.join(this.dir, "complete.marker");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  isComplete(): boolean {
    return existsSync(this.completeMarkerPath);
  }

  /** Replays progress.ndjson into an in-memory set of every already-committed row's dedup key. */
  async loadDoneKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    if (!existsSync(this.progressPath)) return keys;
    const content = await fs.readFile(this.progressPath, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        // A partial trailing line from a crash mid-write, before that line's
        // own fsync completed — never counted as durable, so treat it as
        // never having happened (same conservative choice as the accepted
        // single-batch duplication window this design documents).
        continue;
      }
      const parsed = batchRecordSchema.safeParse(json);
      if (!parsed.success) continue;
      for (const key of parsed.data.keys) keys.add(key);
    }
    return keys;
  }

  /**
   * Appends one durably-flushed line. Must only be called after the
   * corresponding API call returned a matching `inserted` count — see
   * pipeline/run-worker.ts. `fsync` (not just `write`) matters here: without
   * it, an OS-cache-only write could still be lost on a hard kill, silently
   * widening the documented duplication window.
   */
  async appendBatch(record: BatchRecord): Promise<void> {
    const line = JSON.stringify(record) + "\n";
    const handle = await fs.open(this.progressPath, "a");
    try {
      await handle.write(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async writeRunSummary(summary: RunSummary): Promise<void> {
    await fs.writeFile(this.runSummaryPath, JSON.stringify(summary, null, 2));
  }

  async readRunSummary(): Promise<RunSummary | undefined> {
    if (!existsSync(this.runSummaryPath)) return undefined;
    const parsed = runSummarySchema.safeParse(JSON.parse(await fs.readFile(this.runSummaryPath, "utf8")));
    return parsed.success ? parsed.data : undefined;
  }

  async markComplete(): Promise<void> {
    await fs.writeFile(this.completeMarkerPath, new Date().toISOString());
  }

  /** `--fresh`: wipes all local state for this (region, source) — the caller is responsible for warning that this WILL duplicate rows already on the server, since nothing here can undo that. */
  async reset(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true });
    await this.init();
  }
}
