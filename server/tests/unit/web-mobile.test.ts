import { describe, expect, it } from "vitest";
import { createTranslator } from "../../web/public/assets/js/i18n.js";
import { expiryRefusal, expiryRuleFor, formatEndDate, formatExactDuration, parseAmount, quickChoices, splitSeconds } from "../../web/public/assets/js/duration.js";
import { angleDelta, bearingDegrees, compassPoint, distanceMeters, distanceToLineMeters, lineThrough, nextHeading, nextLocateState, smoothHeading, tapToleranceMeters } from "../../web/public/assets/js/geo.js";
import * as limitInfo from "../../web/public/assets/js/limit-info.js";
import { nextDetent, settleDetent, stepDetent } from "../../web/public/assets/js/sheet.js";

// The module is plain JavaScript; its optional parameters default to null, which TypeScript would read as the only allowed value.
const { classifyLookup, correctionSettings, describeCorrectionError, describeOrigin, describeVoteResult, gapProposalsNear } = limitInfo;
const quickValues = limitInfo.quickValues as (unit: string, settings: unknown, current?: number | null) => number[];
const validateValue = limitInfo.validateValue as (raw: string, unit: string, settings: unknown, current?: number | null) => Record<string, unknown>;

const de = createTranslator("de");
const en = createTranslator("en");

describe("own duration (duration.js)", () => {
  const accident = { defaultSeconds: 25 * 60, minSeconds: 10 * 60, maxSeconds: 6 * 3600 };

  it("reads a node's rule and refuses a malformed one (then there is no choice to offer)", () => {
    expect(expiryRuleFor({ accident }, "accident")).toEqual(accident);
    expect(expiryRuleFor({ accident }, "ice")).toBeNull();
    expect(expiryRuleFor(null, "accident")).toBeNull();
    expect(expiryRuleFor({ accident: { ...accident, minSeconds: 10_000_000 } }, "accident")).toBeNull();
    expect(expiryRuleFor({ accident: { defaultSeconds: "25" } }, "accident")).toBeNull();
  });

  it("offers only quick choices inside the bounds, at most six, shortest first", () => {
    const choices = quickChoices(accident) as number[];
    expect(choices.length).toBeLessThanOrEqual(6);
    expect(choices[0]).toBe(600);
    expect(choices.at(-1)).toBe(6 * 3600);
    expect(choices.every((s) => s >= accident.minSeconds && s <= accident.maxSeconds)).toBe(true);
    expect(choices).toEqual([...choices].sort((a, b) => a - b));
    // A short-lived category gets short choices only.
    expect(quickChoices({ defaultSeconds: 720, minSeconds: 300, maxSeconds: 3600 })).toEqual([600, 900, 1800, 3600]);
    // Roadworks can last months.
    expect(quickChoices({ defaultSeconds: 7 * 86400, minSeconds: 3600, maxSeconds: 90 * 86400 }).at(-1)).toBe(90 * 86400);
  });

  it("turns a typed amount into seconds, and says why it cannot", () => {
    expect(parseAmount("2", "hours", accident)).toEqual({ ok: true, seconds: 7200 });
    expect(parseAmount(" 90 ", "minutes", accident)).toEqual({ ok: true, seconds: 5400 });
    expect(parseAmount("", "hours", accident)).toEqual({ ok: false, reason: "empty" });
    expect(parseAmount("1.5", "hours", accident)).toEqual({ ok: false, reason: "invalid" });
    expect(parseAmount("-3", "hours", accident)).toEqual({ ok: false, reason: "invalid" });
    expect(parseAmount("0", "hours", accident)).toEqual({ ok: false, reason: "invalid" });
    expect(parseAmount("5", "minutes", accident)).toEqual({ ok: false, reason: "tooShort" });
    expect(parseAmount("7", "hours", accident)).toEqual({ ok: false, reason: "tooLong" });
    expect(parseAmount("2", "weeks", accident)).toEqual({ ok: false, reason: "invalid" });
  });

  it("writes a duration exactly, in both languages", () => {
    expect(splitSeconds(5400)).toEqual({ amount: 90, unit: "minutes" });
    expect(splitSeconds(7200)).toEqual({ amount: 2, unit: "hours" });
    expect(splitSeconds(14 * 86400)).toEqual({ amount: 14, unit: "days" });
    expect(formatExactDuration(600, de)).toBe("10 Minuten");
    expect(formatExactDuration(3600, de)).toBe("1 Stunde");
    expect(formatExactDuration(14 * 86400, de)).toBe("14 Tage");
    expect(formatExactDuration(86400, en)).toBe("1 day");
    expect(formatExactDuration(7200, en)).toBe("2 hours");
  });

  it("recognises the node's refusal of a duration and nothing else", () => {
    const refusal = { status: 400, code: "EXPIRY_OUT_OF_RANGE", details: { defaultSeconds: 1500, minSeconds: 600, maxSeconds: 21_600 } };
    expect(expiryRefusal(refusal)).toEqual({ minSeconds: 600, maxSeconds: 21_600, defaultSeconds: 1500 });
    expect(expiryRefusal({ ...refusal, status: 422 })).toBeNull();
    expect(expiryRefusal({ ...refusal, details: {} })).toBeNull();
    expect(expiryRefusal(null)).toBeNull();
  });

  it("formats the end date in the visitor's language, empty for garbage", () => {
    expect(formatEndDate("2026-10-11T13:30:00Z", "de")).toMatch(/11\.10\.2026/);
    expect(formatEndDate("2026-10-11T13:30:00Z", "en")).toMatch(/11\/10\/2026/);
    expect(formatEndDate("soon", "de")).toBe("");
  });
});

describe("the location arrow (geo.js)", () => {
  const berlin = { lat: 52.52, lng: 13.405 };

  it("measures distance and bearing", () => {
    const east = { lat: 52.52, lng: 13.419 };
    expect(distanceMeters(berlin, east)).toBeGreaterThan(900);
    expect(distanceMeters(berlin, east)).toBeLessThan(1000);
    expect(bearingDegrees(berlin, east)).toBeGreaterThan(89);
    expect(bearingDegrees(berlin, east)).toBeLessThan(91);
    expect(bearingDegrees(berlin, { lat: 52.53, lng: 13.405 })).toBeCloseTo(0, 0);
    expect(bearingDegrees(berlin, { lat: 52.51, lng: 13.405 })).toBeCloseTo(180, 0);
  });

  it("turns the short way round", () => {
    expect(angleDelta(350, 10)).toBe(20);
    expect(angleDelta(10, 350)).toBe(-20);
    expect(smoothHeading(350, 10, 0.5)).toBeCloseTo(0, 5);
    expect(smoothHeading(null, 123)).toBe(123);
  });

  it("takes the device's heading, else the movement, else keeps what it had — and never invents one", () => {
    const base = { lat: 52.52, lng: 13.405 };
    // the device says 90 and moves
    expect(nextHeading({ fix: { ...base, heading: 90, speed: 8 }, previous: null, current: null })).toBe(90);
    // standing still: the device's heading is noise
    expect(nextHeading({ fix: { ...base, heading: 200, speed: 0 }, previous: null, current: 45 })).toBe(45);
    // no heading, moved 100 m east
    const moved = nextHeading({ fix: { lat: 52.52, lng: 13.4064, heading: null, speed: null }, previous: base, current: null });
    expect(moved).toBeGreaterThan(85);
    expect(moved).toBeLessThan(95);
    // GPS jitter of a few metres does not turn it
    expect(nextHeading({ fix: { lat: 52.520_01, lng: 13.405_01, heading: null, speed: null }, previous: base, current: 270 })).toBe(270);
    // never moved, no heading: unknown
    expect(nextHeading({ fix: { ...base, heading: null, speed: null }, previous: null, current: null })).toBeNull();
  });

  it("walks the button through off, centred, following, off — and a drag or an error steps back", () => {
    expect(nextLocateState("off", "press")).toBe("centered");
    expect(nextLocateState("centered", "press")).toBe("following");
    expect(nextLocateState("following", "press")).toBe("off");
    expect(nextLocateState("following", "drag")).toBe("centered");
    expect(nextLocateState("centered", "drag")).toBe("centered");
    expect(nextLocateState("following", "error")).toBe("off");
  });

  it("names a heading in the visitor's language's letters", () => {
    expect(compassPoint(90, "de")).toBe("O");
    expect(compassPoint(90, "en")).toBe("E");
    expect(compassPoint(45, "de")).toBe("NO");
    expect(compassPoint(359, "en")).toBe("N");
    expect(compassPoint(-90, "de")).toBe("W");
  });

  it("finds how far a tap is from a road, and how far a finger may be off", () => {
    const road: Array<[number, number]> = [
      [13.4, 52.52],
      [13.41, 52.52],
    ];
    expect(distanceToLineMeters({ lat: 52.52, lng: 13.405 }, road)).toBeLessThan(0.5);
    const off = distanceToLineMeters({ lat: 52.5209, lng: 13.405 }, road);
    expect(off).toBeGreaterThan(95);
    expect(off).toBeLessThan(105);
    expect(distanceToLineMeters(berlin, [])).toBe(Infinity);
    expect(tapToleranceMeters(16, 52.5)).toBeGreaterThan(12);
    expect(tapToleranceMeters(19, 52.5)).toBe(12);
  });

  it("draws the stretch of a chosen road axis through a point", () => {
    const [a, b] = lineThrough(berlin, 90, 120) as [{ lat: number; lng: number }, { lat: number; lng: number }];
    expect(a.lat).toBeCloseTo(berlin.lat, 6);
    expect(distanceMeters(a, b)).toBeGreaterThan(118);
    expect(distanceMeters(a, b)).toBeLessThan(122);
    expect(b.lng).toBeGreaterThan(a.lng);
  });
});

describe("the bottom sheet's resting places (sheet.js)", () => {
  const heights = { small: 100, half: 400, full: 700 };

  it("settles at the nearest resting place, and an upward fling counts as higher", () => {
    expect(settleDetent(120, heights)).toBe("small");
    expect(settleDetent(380, heights)).toBe("half");
    expect(settleDetent(650, heights)).toBe("full");
    expect(settleDetent(260, heights)).toBe("half"); // 260 is closer to 400 than to 100
    expect(settleDetent(230, heights, 0)).toBe("small");
    expect(settleDetent(230, heights, -2)).toBe("half"); // flung upwards
  });

  it("cycles on activation and steps with the arrow keys without leaving the range", () => {
    expect(nextDetent("small")).toBe("half");
    expect(nextDetent("half")).toBe("full");
    expect(nextDetent("full")).toBe("small");
    expect(stepDetent("small", -1)).toBe("small");
    expect(stepDetent("full", 1)).toBe("full");
    expect(stepDetent("half", 1)).toBe("full");
  });
});

describe("speed-limit proposals (limit-info.js)", () => {
  const config = { communityCorrections: { enabled: true, confirmationsRequired: 3, valueStep: 5, valueRange: { kmh: { min: 5, max: 130 }, mph: { min: 5, max: 85 } }, rateLimit: { max: 10, windowMinutes: 60 } } };
  const settings = correctionSettings(config)!;

  it("offers the feature only when the node does", () => {
    expect(settings).toMatchObject({ required: 3, step: 5, windowMinutes: 60 });
    expect(correctionSettings({})).toBeNull();
    expect(correctionSettings({ communityCorrections: { ...config.communityCorrections, enabled: false } })).toBeNull();
  });

  it("offers quick values inside the node's range and step, without the value in force", () => {
    const kmh = quickValues("kmh", settings, 50);
    expect(kmh).toContain(30);
    expect(kmh).not.toContain(50);
    expect(kmh.every((v) => v % 5 === 0 && v >= 5 && v <= 130)).toBe(true);
    expect(quickValues("mph", settings).every((v) => v <= 85)).toBe(true);
  });

  it("validates a typed value the way the node will", () => {
    expect(validateValue("30", "kmh", settings, 50)).toEqual({ ok: true, value: 30 });
    expect(validateValue("", "kmh", settings)).toMatchObject({ ok: false, reason: "empty" });
    expect(validateValue("3o", "kmh", settings)).toMatchObject({ ok: false, reason: "notANumber" });
    expect(validateValue("200", "kmh", settings)).toMatchObject({ ok: false, reason: "outOfRange", min: 5, max: 130 });
    expect(validateValue("33", "kmh", settings)).toMatchObject({ ok: false, reason: "notOnStep", step: 5 });
    expect(validateValue("50", "kmh", settings, 50)).toMatchObject({ ok: false, reason: "noChange" });
  });

  it("tells a tapped road from a road nearby and from nothing", () => {
    expect(classifyLookup(null, 20)).toEqual({ kind: "none" });
    expect(classifyLookup({ distanceMeters: 4 }, 20)).toMatchObject({ kind: "road" });
    expect(classifyLookup({ distanceMeters: 97.4 }, 20)).toEqual({ kind: "nearby", distance: 97 });
  });

  it("says where a value comes from", () => {
    expect(describeOrigin({ speedLimit: 50 })).toEqual({ kind: "imported" });
    expect(describeOrigin({ correctedBy: "community", importedSpeedLimit: 50, correction: { id: "c1", confirmations: 3, denials: 1, needsReview: false } })).toMatchObject({ kind: "corrected", imported: 50, confirmations: 3, denials: 1 });
    expect(describeOrigin({ correctedBy: "community", importedSpeedLimit: null, correction: { id: "c2", confirmations: 3, needsReview: true } })).toMatchObject({ kind: "added", needsReview: true });
  });

  it("describes the node's answer honestly: new, merged, unchanged, applied", () => {
    expect(describeVoteResult({ correction: { status: "proposed", confirmations: 1, denials: 0, value: 30, unit: "kmh" }, recorded: true }, 3)).toMatchObject({ kind: "new", applied: false, confirmations: 1, required: 3 });
    expect(describeVoteResult({ correction: { status: "proposed", confirmations: 2, denials: 0 }, recorded: true, merged: true }, 3).kind).toBe("merged");
    expect(describeVoteResult({ correction: { status: "proposed", confirmations: 2 }, recorded: false }, 3).kind).toBe("unchanged");
    expect(describeVoteResult({ correction: { status: "applied", confirmations: 3, value: 30, unit: "kmh" }, recorded: true }, 3)).toMatchObject({ applied: true, value: 30 });
  });

  it("maps the node's refusals to words, and a road that is there after all to the road to correct", () => {
    expect(describeCorrectionError({ status: 422, code: "ROAD_ALREADY_HAS_LIMIT", details: { segmentId: "s1", speedLimit: 50, unit: "kmh" } }, settings)).toMatchObject({ key: "roadAlreadyHasLimit", switchTo: { segmentId: "s1", speedLimit: 50 } });
    expect(describeCorrectionError({ status: 422, code: "CORRECTION_VALUE_NOT_ON_STEP", details: { step: 5 } }, settings)).toEqual({ key: "notOnStep", params: { step: 5 } });
    expect(describeCorrectionError({ status: 429, code: "WEB_RATE_LIMITED", details: { scope: "session" }, retryAfterSeconds: 130 }, settings)).toEqual({ key: "rateLimited.session", params: { minutes: 3 } });
    expect(describeCorrectionError({ status: 500 }, settings).key).toBe("failed");
  });

  it("finds open 'no limit' proposals near a tap and ignores those on a recorded segment", () => {
    const near = { id: "g1", status: "proposed", segmentId: null, confirmations: 1, geometry: { coordinates: [[13.4, 52.52], [13.401, 52.52]] } };
    const far = { id: "g2", status: "proposed", segmentId: null, confirmations: 1, geometry: { coordinates: [[13.5, 52.6], [13.501, 52.6]] } };
    const onSegment = { id: "s1", status: "proposed", segmentId: "seg", confirmations: 2, geometry: { coordinates: [[13.4, 52.52], [13.401, 52.52]] } };
    const result = gapProposalsNear([near, far, onSegment], { lat: 52.52, lng: 13.4005 });
    expect(result.map((c: { id: string }) => c.id)).toEqual(["g1"]);
  });
});
