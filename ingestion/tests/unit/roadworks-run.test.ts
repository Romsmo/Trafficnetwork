import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SeedReportPoster, SeedReportsRequest, SeedReportsResponse } from "../../src/api/types.js";
import type { FeedAdapter } from "../../src/pipeline/roadworks/adapters.js";
import type { FeedConfig } from "../../src/pipeline/roadworks/feeds.js";
import { runRoadworks, type FeedReport, type RoadworksRunOptions } from "../../src/pipeline/roadworks/run-roadworks.js";
import type { ParseResult, RoadworkCandidate } from "../../src/pipeline/roadworks/types.js";

const silentLogger = pino({ level: "silent" });
const T0 = new Date("2026-09-28T12:00:00Z");
const hoursAgo = (h: number) => new Date(T0.getTime() - h * 3_600_000);

function feed(id: string, over: Partial<FeedConfig> = {}): FeedConfig {
  return { id, enabled: true, kind: "datex2", country: "XX", name: id, url: `https://example.test/${id}`, sourceLicense: "Test License 1.0", attribution: "a", minIntervalMinutes: 60, ttlHours: 72, ...over };
}

function candidate(externalId: string, lat = 50, lng = 10, validity: RoadworkCandidate["validity"] = {}, caveat?: string): RoadworkCandidate {
  return { externalId, lat, lng, validity, caveat };
}

function result(candidates: RoadworkCandidate[], over: Partial<ParseResult> = {}): ParseResult {
  return { candidates, skipped: [], totalSeen: candidates.length, complete: true, publishedAt: hoursAgo(1), ...over };
}

class FakePoster implements SeedReportPoster {
  posts: SeedReportsRequest[] = [];
  retires: { feedId: string; runId: string }[] = [];
  failPostNumber: number | undefined;
  retiredCount = 7;

  async postSeedReports(request: SeedReportsRequest): Promise<SeedReportsResponse> {
    if (this.failPostNumber !== undefined && this.posts.length + 1 === this.failPostNumber) throw new Error("server said no");
    this.posts.push(request);
    return { created: request.reports.length, reactivated: 0, updated: 0, refreshed: 0, skippedEnded: 0, duplicatesInRequest: 0 };
  }

  async retireSeedReports(feedId: string, runId: string): Promise<{ retired: number }> {
    this.retires.push({ feedId, runId });
    return { retired: this.retiredCount };
  }
}

let stateDir: string;
let clock: Date;
let poster: FakePoster;
let calls: string[];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-roadworks-"));
  clock = T0;
  poster = new FakePoster();
  calls = [];
});
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

function run(feeds: FeedConfig[], results: Record<string, ParseResult | Error>, over: Partial<RoadworksRunOptions> = {}): Promise<FeedReport[]> {
  const adapter: FeedAdapter = async (f) => {
    calls.push(f.id);
    const r = results[f.id];
    if (!r) throw new Error(`no fake result for ${f.id}`);
    if (r instanceof Error) throw r;
    return r;
  };
  return runRoadworks({
    feeds,
    adapters: { datex2: adapter, "autobahn-de-json": adapter },
    apiClient: poster,
    stateDir,
    logger: silentLogger,
    dryRun: false,
    lookaheadMinutes: 30,
    mergeRadiusMeters: 250,
    batchSize: 2000,
    now: () => clock,
    ...over,
  });
}

describe("runRoadworks — the normal cycle", () => {
  it("sends what is active with the feed's license, then retires what this run did not see (same run id)", async () => {
    const [report] = await run(
      [feed("a")],
      {
        a: result([candidate("open-ended"), candidate("with-end", 51, 11, { start: hoursAgo(48), end: new Date("2026-10-01T00:00:00Z") })]),
      },
    );

    expect(poster.posts).toHaveLength(1);
    const post = poster.posts[0]!;
    expect(post).toMatchObject({ feedId: "a", sourceLicense: "Test License 1.0" });
    expect(post.reports).toEqual([
      { externalId: "open-ended", type: "construction", lat: 50, lng: 10, ttlHours: 72 }, // no end → the feed's ttl, renewed on every sighting
      { externalId: "with-end", type: "construction", lat: 51, lng: 11, endsAt: "2026-10-01T00:00:00.000Z" }, // the source's own end wins
    ]);
    expect(poster.retires).toEqual([{ feedId: "a", runId: post.runId }]);
    expect(report).toMatchObject({ feedId: "a", status: "ok", fetched: 2, sent: 2, retired: 7 });
    expect(report!.server).toMatchObject({ created: 2 });
  });

  it("writes a per-feed report file for the operator", async () => {
    await run([feed("a")], { a: result([candidate("x")]) });
    const written = JSON.parse(fs.readFileSync(path.join(stateDir, "roadworks", "a.report.json"), "utf8")) as FeedReport;
    expect(written).toMatchObject({ feedId: "a", status: "ok", sent: 1 });
  });

  it("counts why records were left out — parse-time skips and not-active-now alike — instead of dropping them silently", async () => {
    const [report] = await run([feed("a")], {
      a: result([candidate("later", 50, 10, { start: new Date("2026-10-20T00:00:00Z") }), candidate("over", 50, 10, { end: hoursAgo(5) }), candidate("now")], {
        skipped: [{ reason: "record type SpeedManagement is not roadworks" }, { reason: "record type SpeedManagement is not roadworks" }],
        totalSeen: 5,
      }),
    });
    expect(report!.notImported).toEqual({ "record type SpeedManagement is not roadworks": 2, "starts later": 1, "already ended": 1 });
    expect(report!.sent).toBe(1);
  });

  it("counts (and sends) records whose timing could not be fully evaluated", async () => {
    const [report] = await run([feed("a")], { a: result([candidate("n1", 50, 10, {}, "period qualifier not evaluated: Uniquement de nuit"), candidate("n2", 51, 10, {}, "period qualifier not evaluated: Uniquement de nuit"), candidate("plain", 52, 10)]) });
    expect(report!.sent).toBe(3);
    expect(report!.sentWithCaveat).toEqual({ "period qualifier not evaluated: Uniquement de nuit": 2 });
  });

  it("does not send an id the server would refuse, and says so", async () => {
    const [report] = await run([feed("a")], { a: result([candidate("x".repeat(201)), candidate("ok")]) });
    expect(poster.posts[0]!.reports.map((r) => r.externalId)).toEqual(["ok"]);
    expect(report!.notImported).toEqual({ "external id empty or longer than 200 characters": 1 });
  });

  it("splits a big feed into batches that share ONE run id, and retires once at the end", async () => {
    const many = Array.from({ length: 5 }, (_, i) => candidate(`r${i}`, 50 + i, 10));
    const [report] = await run([feed("a")], { a: result(many) }, { batchSize: 2 });
    expect(poster.posts.map((p) => p.reports.length)).toEqual([2, 2, 1]);
    expect(new Set(poster.posts.map((p) => p.runId)).size).toBe(1);
    expect(poster.retires).toHaveLength(1);
    expect(report!.sent).toBe(5);
    expect(report!.server).toMatchObject({ created: 5 });
  });

  it("an empty active set neither posts nor retires (the server refuses an empty run; rows end by their own expiry)", async () => {
    const [report] = await run([feed("a")], { a: result([candidate("later", 50, 10, { start: new Date("2026-12-01T00:00:00Z") })]) });
    expect(poster.posts).toHaveLength(0);
    expect(poster.retires).toHaveLength(0);
    expect(report).toMatchObject({ status: "ok", sent: 0 });
    expect(report!.retireSkippedBecause).toMatch(/no roadwork is active/);
  });
});

describe("runRoadworks — a feed that is not read completely must never end anything", () => {
  it("incomplete read (truncated download, failed sub-request): sent, NOT retired, and not counted as a success", async () => {
    const [report] = await run([feed("a")], { a: result([candidate("x")], { complete: false, incompleteReason: "1 of 55 road requests failed" }) });
    expect(poster.posts).toHaveLength(1);
    expect(poster.retires).toHaveLength(0);
    expect(report).toMatchObject({ status: "incomplete", retireSkippedBecause: "1 of 55 road requests failed" });

    // Not a success → the next scheduled pass is not blocked by minIntervalMinutes.
    clock = new Date(T0.getTime() + 60_000);
    const [again] = await run([feed("a")], { a: result([candidate("x")]) });
    expect(again!.status).toBe("ok");
    expect(poster.retires).toHaveLength(1);
  });

  it("a feed whose own publication time is too old (silently stopped updating) is used but retires nothing", async () => {
    const [report] = await run([feed("a", { maxFeedAgeHours: 6 })], { a: result([candidate("x")], { publishedAt: hoursAgo(30) }) });
    expect(poster.posts).toHaveLength(1);
    expect(poster.retires).toHaveLength(0);
    expect(report!.status).toBe("incomplete");
    expect(report!.retireSkippedBecause).toMatch(/older than 6 h/);
  });

  it("the default staleness limit is 24 h", async () => {
    await run([feed("a")], { a: result([candidate("x")], { publishedAt: hoursAgo(23) }) });
    expect(poster.retires).toHaveLength(1);
    await run([feed("b")], { b: result([candidate("y")], { publishedAt: hoursAgo(25) }) });
    expect(poster.retires).toHaveLength(1); // still only a's
  });

  it("a feed that cannot be read at all sends nothing, retires nothing — and does not stop the other feeds", async () => {
    const reports = await run([feed("down"), feed("up")], { down: new Error("GET https://example.test/down failed: HTTP 404"), up: result([candidate("x")]) });
    expect(reports.map((r) => [r.feedId, r.status])).toEqual([
      ["down", "failed"],
      ["up", "ok"],
    ]);
    expect(reports[0]!.error).toMatch(/HTTP 404/);
    expect(poster.posts.map((p) => p.feedId)).toEqual(["up"]);
    expect(poster.retires.map((r) => r.feedId)).toEqual(["up"]);
  });

  it("if sending fails part-way, nothing is retired and the feed is reported failed", async () => {
    poster.failPostNumber = 2;
    const many = Array.from({ length: 4 }, (_, i) => candidate(`r${i}`, 50 + i, 10));
    const [report] = await run([feed("a")], { a: result(many) }, { batchSize: 2 });
    expect(poster.posts).toHaveLength(1);
    expect(poster.retires).toHaveLength(0);
    expect(report).toMatchObject({ status: "failed", error: "server said no" });
  });
});

describe("runRoadworks — polling etiquette and dry-run", () => {
  it("does not touch a feed again within its minIntervalMinutes, and does again afterwards", async () => {
    await run([feed("a", { minIntervalMinutes: 60 })], { a: result([candidate("x")]) });
    expect(calls).toEqual(["a"]);

    clock = new Date(T0.getTime() + 10 * 60_000);
    const [soon] = await run([feed("a", { minIntervalMinutes: 60 })], { a: result([candidate("x")]) });
    expect(soon!.status).toBe("skipped-too-soon");
    expect(calls).toEqual(["a"]); // the feed was not fetched
    expect(poster.posts).toHaveLength(1);

    clock = new Date(T0.getTime() + 61 * 60_000);
    const [later] = await run([feed("a", { minIntervalMinutes: 60 })], { a: result([candidate("x")], { publishedAt: new Date(clock.getTime() - 3_600_000) }) });
    expect(later!.status).toBe("ok");
    expect(calls).toEqual(["a", "a"]);
  });

  it("dry-run reads and reports but sends nothing, retires nothing, and leaves no 'success' behind", async () => {
    const [report] = await run([feed("a")], { a: result([candidate("x"), candidate("y", 51, 10)]) }, { dryRun: true });
    expect(report).toMatchObject({ status: "dry-run", sent: 2 });
    expect(poster.posts).toHaveLength(0);
    expect(poster.retires).toHaveLength(0);

    const [real] = await run([feed("a")], { a: result([candidate("x")]) });
    expect(real!.status).toBe("ok"); // not skipped-too-soon
  });
});

describe("runRoadworks — the same roadwork in two feeds", () => {
  it("is created once: the lower-priority feed leaves out what the higher-priority feed already has", async () => {
    const reports = await run([feed("national"), feed("operator")], {
      national: result([candidate("n1", 50, 10, { start: hoursAgo(24), end: new Date("2026-10-30T00:00:00Z") })]),
      operator: result([candidate("o1", 50.0005, 10, { start: hoursAgo(24), end: new Date("2026-10-30T00:00:00Z") }), candidate("o2", 52, 12)]),
    });
    expect(poster.posts.map((p) => [p.feedId, p.reports.map((r) => r.externalId)])).toEqual([
      ["national", ["n1"]],
      ["operator", ["o2"]],
    ]);
    expect(reports.find((r) => r.feedId === "operator")).toMatchObject({ mergedIntoOtherFeed: 1, sent: 1 });
    // The operator feed still retires by its own run: o1, sent in an earlier run, is simply not re-stamped and ends.
    expect(poster.retires.map((r) => r.feedId)).toEqual(["national", "operator"]);
  });

  it("if the higher-priority feed failed to load, the other feed keeps its own roadwork", async () => {
    await run([feed("national"), feed("operator")], { national: new Error("down"), operator: result([candidate("o1", 50, 10)]) });
    expect(poster.posts.map((p) => [p.feedId, p.reports.length])).toEqual([["operator", 1]]);
  });
});
