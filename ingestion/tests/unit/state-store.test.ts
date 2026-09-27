import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  const progressFile = () => path.join(stateDir, "bayern", "osm", "progress.ndjson");

  it("starts incomplete with no done keys before anything is written", async () => {
    await store.init();
    expect(store.isComplete()).toBe(false);
    expect((await store.loadDoneKeys()).size).toBe(0);
    expect(await store.hasProgress()).toBe(false);
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
    expect(await store.hasProgress()).toBe(true);
  });

  it("accumulates keys across multiple appended batches", async () => {
    await store.init();
    await store.appendBatch({ batchId: "b1", kind: "static-sign", postedAt: new Date().toISOString(), insertedCount: 1, keys: ["static-sign:node/1"] });
    await store.appendBatch({ batchId: "b2", kind: "static-sign", postedAt: new Date().toISOString(), insertedCount: 1, keys: ["static-sign:node/2"] });
    const done = await store.loadDoneKeys();
    expect(done.size).toBe(2);
    expect(done.has("static-sign:node/1")).toBe(true);
    expect(done.has("static-sign:node/2")).toBe(true);
  });

  it("skips a corrupted/partial trailing line instead of crashing resume", async () => {
    await store.init();
    await store.appendBatch({ batchId: "b1", kind: "static-sign", postedAt: new Date().toISOString(), insertedCount: 1, keys: ["static-sign:node/1"] });
    // Simulate a crash mid-write: append a truncated, invalid JSON line directly.
    await fs.appendFile(progressFile(), '{"batchId":"b2","kind":"static-sig');
    const done = await store.loadDoneKeys();
    expect(done.size).toBe(1);
    expect(done.has("static-sign:node/1")).toBe(true);
  });

  it("terminates a crash fragment on init, so the NEXT record after a resume is not glued onto it and lost", async () => {
    await store.init();
    await store.appendBatch({ batchId: "b1", kind: "static-sign", postedAt: new Date().toISOString(), insertedCount: 1, keys: ["static-sign:node/1"] });
    await fs.appendFile(progressFile(), '{"batchId":"b2","kind":"static-sig'); // died mid-line, no trailing newline

    const resumed = new StateStore(stateDir, "bayern", "osm");
    await resumed.init();
    await resumed.appendBatch({ batchId: "b3", kind: "static-sign", postedAt: new Date().toISOString(), insertedCount: 1, keys: ["static-sign:node/3"] });

    const done = await resumed.loadDoneKeys();
    expect(done.has("static-sign:node/1")).toBe(true);
    expect(done.has("static-sign:node/3")).toBe(true); // would be false if b3 had been appended onto the fragment
    expect(readFileSync(progressFile(), "utf8").endsWith("\n")).toBe(true);
  });

  it("markComplete / isComplete round-trip", async () => {
    await store.init();
    expect(store.isComplete()).toBe(false);
    await store.markComplete();
    expect(store.isComplete()).toBe(true);
  });

  it("quarantined rows count as handled on resume and are countable", async () => {
    await store.init();
    await store.appendQuarantine({ key: "speed-limit-segment:way/9", kind: "speed-limit-segment", reason: "server-rejected", detail: { issues: [] }, row: { speedLimit: -1 }, at: new Date().toISOString() });
    const done = await store.loadDoneKeys();
    expect(done.has("speed-limit-segment:way/9")).toBe(true);
    expect(await store.countQuarantined()).toBe(1);
  });

  it("tracks per-section completion and returns the stats", async () => {
    await store.init();
    expect(await store.isSectionDone("x10_y40")).toBe(false);
    await store.markSectionDone({
      id: "x10_y40",
      startedAt: "2026-09-25T10:00:00.000Z",
      finishedAt: "2026-09-25T10:05:00.000Z",
      insertedByKind: { "speed-limit-segment": 7 },
      skippedAlreadyDone: 1,
      quarantined: 0,
    });
    expect(await store.isSectionDone("x10_y40")).toBe(true);
    expect(await store.isSectionDone("x0_y40")).toBe(false);
    expect((await store.readSectionStats()).map((s) => s.id)).toEqual(["x10_y40"]);
  });

  it("streams a progress log far larger than a single batch without building one giant string", async () => {
    await store.init();
    for (let b = 0; b < 20; b++) {
      const keys = Array.from({ length: 5000 }, (_, i) => `speed-limit-segment:way/${b * 5000 + i + 1}`);
      await store.appendBatch({ batchId: `b${b}`, kind: "speed-limit-segment", postedAt: new Date().toISOString(), insertedCount: keys.length, keys });
    }
    const done = await store.loadDoneKeys();
    expect(done.size).toBe(100_000);
    expect(done.has("speed-limit-segment:way/100000")).toBe(true);
    expect(done.has("speed-limit-segment:way/100001")).toBe(false);
  });

  it("run summary round-trips and reset() clears everything including completion", async () => {
    await store.init();
    await store.writeRunSummary({ startedAt: "2026-01-01T00:00:00.000Z", status: "running" });
    expect(await store.readRunSummary()).toMatchObject({ status: "running" });

    await store.appendBatch({ batchId: "b1", kind: "static-sign", postedAt: new Date().toISOString(), insertedCount: 1, keys: ["static-sign:node/1"] });
    await store.markComplete();

    await store.reset();

    expect(store.isComplete()).toBe(false);
    expect((await store.loadDoneKeys()).size).toBe(0);
    expect(await store.readRunSummary()).toBeUndefined();
  });
});
