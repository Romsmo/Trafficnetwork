import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { KeySet } from "./keyset.js";
import {
  batchRecordSchema,
  quarantineRecordSchema,
  runSummarySchema,
  sectionStatsSchema,
  type BatchRecord,
  type QuarantineRecord,
  type RunSummary,
  type SectionStats,
} from "./schema.js";

/**
 * Per (region, source) local progress state — the *only* thing standing
 * between a resumed run and re-posting rows the server already accepted,
 * since server/src/db/queries/bulk-import.ts has no dedup/unique constraint
 * of its own (confirmed by reading it directly during planning). One line
 * per successfully committed batch, not per row: the batch is the actual
 * POST/commit boundary, and per-row granularity would multiply file size for
 * no durability benefit.
 *
 * Europe scale (≈15 M keys, ≈0.7 GB of progress lines): the log is replayed
 * as a stream and collected into a compact KeySet — never read into one
 * string (V8's string limit is ≈536 M chars) or a Set<string>.
 */
export class StateStore {
  private readonly dir: string;

  constructor(stateDir: string, region: string, source: string) {
    this.dir = path.join(stateDir, region, source);
  }

  /** The directory holding this (region, source)'s state — workers may put provenance files (extract-meta.json) next to it. */
  get directory(): string {
    return this.dir;
  }

  private get progressPath(): string {
    return path.join(this.dir, "progress.ndjson");
  }

  private get quarantinePath(): string {
    return path.join(this.dir, "quarantine.ndjson");
  }

  private get runSummaryPath(): string {
    return path.join(this.dir, "run.json");
  }

  private get completeMarkerPath(): string {
    return path.join(this.dir, "complete.marker");
  }

  private get sectionsDir(): string {
    return path.join(this.dir, "sections");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(this.sectionsDir, { recursive: true });
    await repairTail(this.progressPath);
    await repairTail(this.quarantinePath);
  }

  isComplete(): boolean {
    return existsSync(this.completeMarkerPath);
  }

  /** True once any batch was committed or a run was started — a "fresh start" (nothing recorded) is what the empty-target guard applies to. */
  async hasProgress(): Promise<boolean> {
    if (existsSync(this.runSummaryPath)) return true;
    try {
      return (await fs.stat(this.progressPath)).size > 0;
    } catch {
      return false;
    }
  }

  /**
   * Replays progress.ndjson (and quarantine.ndjson) into the set of every
   * already-handled row's dedup key, line by line.
   */
  async loadDoneKeys(): Promise<KeySet> {
    const keys = new KeySet();
    for await (const json of readNdjson(this.progressPath)) {
      const parsed = batchRecordSchema.safeParse(json);
      if (!parsed.success) continue;
      for (const key of parsed.data.keys) keys.add(key);
    }
    for await (const json of readNdjson(this.quarantinePath)) {
      const parsed = quarantineRecordSchema.safeParse(json);
      if (parsed.success) keys.add(parsed.data.key);
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
    await appendDurably(this.progressPath, JSON.stringify(record) + "\n");
  }

  async appendQuarantine(record: QuarantineRecord): Promise<void> {
    await appendDurably(this.quarantinePath, JSON.stringify(record) + "\n");
  }

  async countQuarantined(): Promise<number> {
    let count = 0;
    for await (const json of readNdjson(this.quarantinePath)) if (quarantineRecordSchema.safeParse(json).success) count++;
    return count;
  }

  async isSectionDone(id: string): Promise<boolean> {
    return existsSync(path.join(this.sectionsDir, `${safeFileName(id)}.json`));
  }

  async markSectionDone(stats: SectionStats): Promise<void> {
    await fs.writeFile(path.join(this.sectionsDir, `${safeFileName(stats.id)}.json`), JSON.stringify(stats, null, 2));
  }

  async readSectionStats(): Promise<SectionStats[]> {
    if (!existsSync(this.sectionsDir)) return [];
    const stats: SectionStats[] = [];
    for (const name of (await fs.readdir(this.sectionsDir)).sort()) {
      if (!name.endsWith(".json")) continue;
      const parsed = sectionStatsSchema.safeParse(JSON.parse(await fs.readFile(path.join(this.sectionsDir, name), "utf8")));
      if (parsed.success) stats.push(parsed.data);
    }
    return stats;
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

function safeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Streams parsed JSON lines; an unparseable line (crash mid-write) is skipped — it was never counted as durable. */
async function* readNdjson(filePath: string): AsyncGenerator<unknown> {
  if (!existsSync(filePath)) return;
  const rl = readline.createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A partial trailing line from a crash mid-write, before that line's own fsync completed — never
      // counted as durable, so treat it as never having happened (same conservative choice as the
      // accepted single-batch duplication window this design documents).
      continue;
    }
  }
}

async function appendDurably(filePath: string, line: string): Promise<void> {
  const handle = await fs.open(filePath, "a");
  try {
    await handle.write(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * If a previous run died mid-line, the file ends without "\n". Appending the
 * next record directly would glue it onto the fragment and make the NEW, valid
 * record unparseable on the following resume — silently losing its keys and
 * re-importing that batch. Terminate the fragment first.
 */
async function repairTail(filePath: string): Promise<void> {
  if (!existsSync(filePath)) return;
  const handle = await fs.open(filePath, "r+");
  try {
    const { size } = await handle.stat();
    if (size === 0) return;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    if (last[0] !== 0x0a) {
      await handle.write("\n", size);
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
}
