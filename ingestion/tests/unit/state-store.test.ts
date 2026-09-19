import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { StateStore } from "../../src/state/store.js";

describe("StateStore", () => {
  let stateDir: string;
  let store: StateStore;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "ingestion-state-test-"));
    store = new StateStore(stateDir, "bayern", "osm");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("starts incomplete with no done keys before anything is written", async () => {
    await store.init();
    expect(store.isComplete()).toBe(false);
    expect(await store.loadDoneKeys()).toEqual(new Set());
  });

  it("records a batch's keys and replays them into the done set", async () => {
    await store.init();
    await store.appendBatch({
      batchId: "b1",
      kind: "speed-limit-segment",
      postedAt: new Date().toISOString(),
      insertedCount: 2,
      keys: ["speed-limit-segment:way/1", "speed-limit-segment:way/2"],
    });
    const done = await store.loadDoneKeys();
    expect(done.has("speed-limit-segment:way/1")).toBe(true);
    expect(done.has("speed-limit-segment:way/2")).toBe(true);
    expect(done.size).toBe(2);
  });

  it("accumulates keys across multiple appended batches", async () => {
    await store.init();
    await store.appendBatch({ batchId: "b1", kind: "static-sign", postedAt: new Date().toISOString(), insertedCount: 1, keys: ["static-sign:node/1"] });
    await store.appendBatch({ batchId: "b2", kind: "static-sign", postedAt: new Date().toISOString(), insertedCount: 1, keys: ["static-sign:node/2"] });
    const done = await store.loadDoneKeys();
    expect(done).toEqual(new Set(["static-sign:node/1", "static-sign:node/2"]));
  });

  it("skips a corrupted/partial trailing line instead of crashing resume", async () => {
    await store.init();
    await store.appendBatch({ batchId: "b1", kind: "static-sign", postedAt: new Date().toISOString(), insertedCount: 1, keys: ["static-sign:node/1"] });
    // Simulate a crash mid-write: append a truncated, invalid JSON line directly.
    await fs.appendFile(path.join(stateDir, "bayern", "osm", "progress.ndjson"), '{"batchId":"b2","kind":"static-sig');
    const done = await store.loadDoneKeys();
    expect(done).toEqual(new Set(["static-sign:node/1"]));
  });

  it("markComplete / isComplete round-trip", async () => {
    await store.init();
    expect(store.isComplete()).toBe(false);
    await store.markComplete();
    expect(store.isComplete()).toBe(true);
  });

  it("run summary round-trips and reset() clears everything including completion", async () => {
    await store.init();
    await store.writeRunSummary({ startedAt: "2026-01-01T00:00:00.000Z", status: "running" });
    expect(await store.readRunSummary()).toMatchObject({ status: "running" });

    await store.appendBatch({ batchId: "b1", kind: "static-sign", postedAt: new Date().toISOString(), insertedCount: 1, keys: ["static-sign:node/1"] });
    await store.markComplete();

    await store.reset();

    expect(store.isComplete()).toBe(false);
    expect(await store.loadDoneKeys()).toEqual(new Set());
    expect(await store.readRunSummary()).toBeUndefined();
  });
});
