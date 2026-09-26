import { describe, expect, it } from "vitest";
import { distanceMeters, mergeAcrossFeeds, selectActive } from "../../src/pipeline/roadworks/select.js";
import type { ActiveRoadwork, RoadworkCandidate } from "../../src/pipeline/roadworks/types.js";

const NOW = new Date("2026-09-28T12:00:00Z");
const LOOKAHEAD = 30 * 60_000;
const at = (iso: string) => new Date(iso);

const candidate = (validity: RoadworkCandidate["validity"], extra: Partial<RoadworkCandidate> = {}): RoadworkCandidate => ({ externalId: "x", lat: 50, lng: 10, validity, ...extra });

describe("selectActive", () => {
  it("overall start/end: active inside, with the source's end as expiry", () => {
    const s = selectActive(candidate({ start: at("2026-09-01T00:00:00Z"), end: at("2026-10-01T00:00:00Z") }), NOW, LOOKAHEAD);
    expect(s).toMatchObject({ active: { externalId: "x", endsAt: at("2026-10-01T00:00:00Z") } });
  });

  it("no times at all: active without an end, so the server's ttl applies", () => {
    const s = selectActive(candidate({}), NOW, LOOKAHEAD);
    expect("active" in s && s.active.endsAt).toBeUndefined();
    expect("active" in s).toBe(true);
  });

  it("a roadwork that starts within the lookahead is announced already, a later one is not", () => {
    expect(selectActive(candidate({ start: at("2026-09-28T12:20:00Z") }), NOW, LOOKAHEAD)).toHaveProperty("active");
    expect(selectActive(candidate({ start: at("2026-09-28T12:45:00Z") }), NOW, LOOKAHEAD)).toEqual({ skip: "starts later" });
  });

  it("an ended roadwork is skipped", () => {
    expect(selectActive(candidate({ end: at("2026-09-28T12:00:00Z") }), NOW, LOOKAHEAD)).toEqual({ skip: "already ended" });
  });

  it("windows: only the running window counts, and the row expires at that window's end", () => {
    const windows = [
      { start: at("2026-09-27T19:00:00Z"), end: at("2026-09-28T04:00:00Z") },
      { start: at("2026-09-28T11:00:00Z"), end: at("2026-09-28T16:00:00Z") },
      { start: at("2026-09-29T19:00:00Z"), end: at("2026-09-30T04:00:00Z") },
    ];
    expect(selectActive(candidate({ windows }), NOW, LOOKAHEAD)).toMatchObject({ active: { endsAt: at("2026-09-28T16:00:00Z"), intervalStart: at("2026-09-28T11:00:00Z") } });
  });

  it("windows: between two windows it is NOT shown (a night work is not there at noon)", () => {
    const windows = [
      { start: at("2026-09-27T19:00:00Z"), end: at("2026-09-28T04:00:00Z") },
      { start: at("2026-09-28T19:00:00Z"), end: at("2026-09-29T04:00:00Z") },
    ];
    expect(selectActive(candidate({ windows }), NOW, LOOKAHEAD)).toEqual({ skip: "no validity window is running now" });
  });

  it("windows: all over → says so; a window starting within the lookahead is picked up early", () => {
    expect(selectActive(candidate({ windows: [{ start: at("2026-09-20T19:00:00Z"), end: at("2026-09-21T04:00:00Z") }] }), NOW, LOOKAHEAD)).toEqual({ skip: "all validity windows are over" });
    expect(selectActive(candidate({ windows: [{ start: at("2026-09-28T12:10:00Z"), end: at("2026-09-28T20:00:00Z") }] }), NOW, LOOKAHEAD)).toHaveProperty("active");
  });

  it("carries the caveat along", () => {
    expect(selectActive(candidate({}, { caveat: "night only" }), NOW, LOOKAHEAD)).toMatchObject({ active: { caveat: "night only" } });
  });
});

describe("distanceMeters", () => {
  it("is about 111 km per degree of latitude and 0 for the same point", () => {
    expect(distanceMeters(50, 10, 51, 10)).toBeGreaterThan(111_000);
    expect(distanceMeters(50, 10, 51, 10)).toBeLessThan(111_400);
    expect(distanceMeters(50, 10, 50, 10)).toBe(0);
  });
});

describe("mergeAcrossFeeds", () => {
  const rw = (externalId: string, lat: number, lng: number, start?: string, end?: string): ActiveRoadwork => ({
    externalId,
    lat,
    lng,
    intervalStart: start ? at(start) : undefined,
    intervalEnd: end ? at(end) : undefined,
  });

  it("drops a roadwork of a lower-priority feed that a higher-priority feed already has nearby at the same time", () => {
    const result = mergeAcrossFeeds(
      [
        { feedId: "high", active: [rw("h1", 50, 10, "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z")] },
        { feedId: "low", active: [rw("l1", 50.0009, 10, "2026-09-10T00:00:00Z", "2026-09-20T00:00:00Z"), rw("l2", 51, 10)] },
      ],
      250,
    );
    expect(result.kept.get("high")!.map((r) => r.externalId)).toEqual(["h1"]);
    expect(result.kept.get("low")!.map((r) => r.externalId)).toEqual(["l2"]); // l1 is ~100 m from h1 and overlaps in time
    expect(result.mergedAway.get("low")).toBe(1);
    expect(result.mergedAway.get("high")).toBe(0);
  });

  it("keeps both when they are near but at different times, or at the same time but far apart", () => {
    const result = mergeAcrossFeeds(
      [
        { feedId: "high", active: [rw("h1", 50, 10, "2026-09-01T00:00:00Z", "2026-09-05T00:00:00Z")] },
        { feedId: "low", active: [rw("later", 50, 10, "2026-09-10T00:00:00Z", "2026-09-20T00:00:00Z"), rw("far", 50.1, 10, "2026-09-01T00:00:00Z", "2026-09-05T00:00:00Z")] },
      ],
      250,
    );
    expect(result.kept.get("low")!.map((r) => r.externalId)).toEqual(["later", "far"]);
  });

  it("never merges roadworks of the same feed with each other", () => {
    const result = mergeAcrossFeeds([{ feedId: "only", active: [rw("a", 50, 10), rw("b", 50.0001, 10)] }], 250);
    expect(result.kept.get("only")).toHaveLength(2);
  });

  it("treats a missing interval end as open-ended", () => {
    const result = mergeAcrossFeeds([{ feedId: "high", active: [rw("h", 50, 10, "2026-09-01T00:00:00Z")] }, { feedId: "low", active: [rw("l", 50, 10, "2027-01-01T00:00:00Z", "2027-01-02T00:00:00Z")] }], 250);
    expect(result.mergedAway.get("low")).toBe(1);
  });
});
