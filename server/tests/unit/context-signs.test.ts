import { describe, expect, it } from "vitest";
import { allSignTypes, signInfo, SIGN_COUNT } from "../../src/modules/context-signs/catalog.js";
import {
  DescriptorError,
  describeDescriptor,
  entryKeyOf,
  normaliseDescriptor,
  overlapShare,
  validateDescriptor,
  type ContextSignDescriptor,
} from "../../src/modules/context-signs/descriptor.js";
import { deriveState, tallyEntry, type TallyRules, type VoteInput } from "../../src/modules/context-signs/tally.js";
import { proposeTimezone, timezoneOfCountry } from "../../src/modules/context-signs/timezone.js";
import { tilesOf } from "../../src/modules/context-signs/service.js";

const limits = { timezonePrefixes: ["Europe/"] };

/** About 220 m east-west near Munich. */
const line: [number, number][] = [
  [11.5, 48.1],
  [11.502, 48.1],
  [11.503, 48.1001],
];

const base = (over: Partial<ContextSignDescriptor> = {}): ContextSignDescriptor => ({
  v: 1,
  signType: "DE:276",
  geometry: line,
  direction: "along",
  validity: { v: 1, tz: "Europe/Berlin" },
  value: null,
  unit: null,
  ...over,
});

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof DescriptorError) return e.code;
    throw e;
  }
}

describe("context sign catalogue", () => {
  it("holds exactly the 58 signs of the display (Appendix A of the requirement)", () => {
    expect(SIGN_COUNT).toBe(58);
    expect(new Set(allSignTypes()).size).toBe(58);
    expect(allSignTypes().filter((c) => signInfo(c)?.class === "hazard")).toHaveLength(31);
    expect(allSignTypes().filter((c) => signInfo(c)?.class === "prohibition")).toHaveLength(27);
  });

  it("knows German codes only, and rejects malformed ones", () => {
    expect(signInfo("DE:276")?.class).toBe("prohibition");
    expect(signInfo("DE:142-10")?.class).toBe("hazard");
    for (const bad of ["FR:276", "DE:999", "276", "DE:27", "de:276", "DE:276-", "DE:274", "DE:2760"]) expect(signInfo(bad)).toBeNull();
  });

  it("asks for a value only where the sign has one", () => {
    expect(signInfo("DE:265-3")?.value).toMatchObject({ unit: "m", required: true });
    expect(signInfo("DE:253")?.value).toMatchObject({ unit: "t", required: false });
    expect(signInfo("DE:276")?.value).toBeNull();
  });
});

describe("descriptor", () => {
  it("has the same key however the same thing is written down", () => {
    const a = base({ direction: "both" });
    const reversed = base({ direction: "both", geometry: [...line].reverse() });
    expect(entryKeyOf(reversed)).toBe(entryKeyOf(a));
    // windows: order and duplicate days do not matter
    const w1 = base({ validity: { v: 1, tz: "Europe/Berlin", windows: [{ days: [5, 1, 1, 2], from: "07:00", to: "17:00" }, { days: [6], from: "08:00", to: "12:00" }] } });
    const w2 = base({ validity: { v: 1, tz: "Europe/Berlin", windows: [{ days: [6], from: "08:00", to: "12:00" }, { days: [1, 2, 5], from: "07:00", to: "17:00" }] } });
    expect(entryKeyOf(w1)).toBe(entryKeyOf(w2));
    expect(entryKeyOf(a)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is a different entry when direction, validity, shape or value differ", () => {
    const keys = new Set([
      entryKeyOf(base()),
      entryKeyOf(base({ direction: "both" })),
      entryKeyOf(base({ geometry: [...line].reverse() })), // one way, the other way round
      entryKeyOf(base({ validity: { v: 1, tz: "Europe/Berlin", period: { from: "2026-10-01", to: "2026-11-30" } } })),
      entryKeyOf(base({ signType: "DE:277" })),
    ]);
    expect(keys.size).toBe(5);
  });

  it("rounds coordinates to 1e-7 degrees and drops repeated points", () => {
    const n = normaliseDescriptor(base({ geometry: [[11.5, 48.1], [11.5000000001, 48.1], [11.502, 48.1]] }));
    expect(n.geometry).toEqual([[11.5, 48.1], [11.502, 48.1]]);
  });

  it("rejects what the catalogue does not know, and values where a sign carries none", () => {
    expect(codeOf(() => validateDescriptor(base({ signType: "DE:999" }), limits))).toBe("UNKNOWN_SIGN");
    expect(codeOf(() => validateDescriptor(base({ value: 3, unit: "t" }), limits))).toBe("INVALID_VALUE");
    expect(codeOf(() => validateDescriptor(base({ signType: "DE:265-3" }), limits))).toBe("VALUE_REQUIRED");
    expect(validateDescriptor(base({ signType: "DE:265-3", value: 3.8, unit: "m" }), limits).value).toBe(3.8);
    expect(codeOf(() => validateDescriptor(base({ signType: "DE:265-3", value: 3.8, unit: "t" }), limits))).toBe("INVALID_VALUE");
    expect(codeOf(() => validateDescriptor(base({ signType: "DE:265-3", value: 99, unit: "m" }), limits))).toBe("INVALID_VALUE");
    expect(codeOf(() => validateDescriptor({ nonsense: true }, limits))).toBe("INVALID_DESCRIPTOR");
    expect(codeOf(() => validateDescriptor({ ...base(), extra: 1 }, limits))).toBe("INVALID_DESCRIPTOR");
  });

  it("limits the length of a stretch per sign", () => {
    // a point-like sign (end of a no-overtaking zone) is a few metres, never 220 m
    expect(codeOf(() => validateDescriptor(base({ signType: "DE:280" }), limits))).toBe("STRETCH_TOO_LONG");
    expect(codeOf(() => validateDescriptor(base({ signType: "DE:286" }), limits))).toBeNull();
    const long: [number, number][] = Array.from({ length: 12 }, (_, i) => [11.5 + i * 0.02, 48.1] as [number, number]);
    expect(codeOf(() => validateDescriptor(base({ geometry: long, signType: "DE:286" }), limits))).toBe("STRETCH_TOO_LONG");
    expect(codeOf(() => validateDescriptor(base({ geometry: [[11.5, 48.1], [11.5, 48.1]] }), limits))).toBe("INVALID_GEOMETRY");
    expect(codeOf(() => validateDescriptor(base({ geometry: [[11.5, 48.1], [11.5, 48.2]] }), limits))).toBe("INVALID_GEOMETRY");
  });

  it("checks time zone, windows and periods", () => {
    const v = (validity: Partial<ContextSignDescriptor["validity"]>) => base({ validity: { v: 1, tz: "Europe/Berlin", ...validity } });
    expect(codeOf(() => validateDescriptor(v({ tz: "America/New_York" }), limits))).toBe("INVALID_TIMEZONE");
    expect(codeOf(() => validateDescriptor(v({ tz: "Mars/Olympus" }), limits))).toBe("INVALID_TIMEZONE");
    expect(codeOf(() => validateDescriptor(v({ tz: "America/New_York" }), { timezonePrefixes: ["Europe/", "America/"] }))).toBeNull();
    expect(codeOf(() => validateDescriptor(v({ windows: [{ days: [1], from: "07:00", to: "07:00" }] }), limits))).toBe("INVALID_WINDOW");
    expect(codeOf(() => validateDescriptor(v({ windows: [{ days: [1], from: "22:00", to: "06:00" }] }), limits))).toBeNull(); // over midnight is fine
    expect(codeOf(() => validateDescriptor(v({ windows: [{ days: [8], from: "07:00", to: "08:00" }] }), limits))).toBe("INVALID_DESCRIPTOR");
    expect(codeOf(() => validateDescriptor(v({ windows: [{ days: [1], from: "7:00", to: "08:00" }] }), limits))).toBe("INVALID_DESCRIPTOR");
    expect(codeOf(() => validateDescriptor(v({ period: { from: "2026-02-30", to: "2026-03-01" } }), limits))).toBe("INVALID_PERIOD");
    expect(codeOf(() => validateDescriptor(v({ period: { from: "2026-12-01", to: "2026-11-01" } }), limits))).toBe("INVALID_PERIOD");
    expect(codeOf(() => validateDescriptor(v({ period: { from: "2026-10-01", to: null } }), limits))).toBeNull(); // until revoked
  });

  it("makes a roadworks sign temporary: a period with an end, at most 90 days", () => {
    const works = (period?: { from: string; to: string | null }) => base({ signType: "DE:123", validity: { v: 1, tz: "Europe/Berlin", ...(period ? { period } : {}) } });
    expect(codeOf(() => validateDescriptor(works(), limits))).toBe("PERIOD_REQUIRED");
    expect(codeOf(() => validateDescriptor(works({ from: "2026-10-01", to: null }), limits))).toBe("PERIOD_REQUIRED");
    expect(codeOf(() => validateDescriptor(works({ from: "2026-10-01", to: "2027-03-01" }), limits))).toBe("PERIOD_TOO_LONG");
    expect(codeOf(() => validateDescriptor(works({ from: "2026-10-01", to: "2026-11-30" }), limits))).toBeNull();
  });

  it("describes a valid descriptor with its key, length and class", () => {
    const d = describeDescriptor(base({ signType: "DE:142-10", direction: "both" }), limits);
    expect(d.signClass).toBe("hazard");
    expect(d.lengthM).toBeGreaterThan(150);
    expect(d.entryKey).toBe(entryKeyOf(d.descriptor));
  });
});

const rules: TallyRules = { confirmationsRequired: { prohibition: 3, hazard: 2 }, disputeMinDenials: 2, unconfirmedDays: 14, openEndedDays: 365 };
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T10:00:00Z");
const vote = (id: string, reporterId: string, kind: "support" | "deny", at = 0): VoteInput => ({ id, reporterId, kind, timestamp: T0 + at });
const validity = { v: 1 as const, tz: "Europe/Berlin" };

describe("tally and state", () => {
  it("counts one voice per device, the latest stance standing", () => {
    const t = tallyEntry([vote("1", "device:a", "support", 0), vote("2", "device:a", "deny", 10), vote("3", "device:b", "support", 5), vote("4", "device:a", "support", 20)]);
    expect(t).toMatchObject({ support: 2, deny: 0 });
  });

  it("gives the same answer in any arrival order", () => {
    const votes = [vote("1", "device:a", "support", 0), vote("2", "device:b", "deny", 1), vote("3", "device:b", "support", 2), vote("4", "device:c", "deny", 3), vote("5", "device:a", "deny", 4)];
    const reference = tallyEntry(votes);
    for (let i = 0; i < 20; i++) {
      const shuffled = [...votes].sort(() => Math.random() - 0.5);
      expect(tallyEntry(shuffled)).toEqual(reference);
    }
  });

  it("counts anonymous web visitors together as at most one voice", () => {
    const web = Array.from({ length: 5 }, (_, i) => vote(`w${i}`, `web:session-${i}`, "support", i));
    expect(tallyEntry(web)).toMatchObject({ support: 1, deny: 0 });
    expect(tallyEntry([...web, vote("d", "device:a", "support", 9)]).support).toBe(2);
    // more of them against than for: one objection; a tie says nothing
    expect(tallyEntry([vote("1", "web:a", "deny", 0), vote("2", "web:b", "deny", 1), vote("3", "web:c", "support", 2)])).toMatchObject({ support: 0, deny: 1 });
    expect(tallyEntry([vote("1", "web:a", "deny", 0), vote("2", "web:b", "support", 1)])).toMatchObject({ support: 0, deny: 0 });
  });

  it("confirms at the threshold of its class: a prohibition needs one voice more than a warning", () => {
    const two = tallyEntry([vote("1", "device:a", "support"), vote("2", "device:b", "support")]);
    expect(deriveState({ tally: two, signClass: "hazard", validity, blocked: false, rules })).toMatchObject({ status: "confirmed", confirmed: true });
    expect(deriveState({ tally: two, signClass: "prohibition", validity, blocked: false, rules })).toMatchObject({ status: "proposed", confirmed: false });
    const three = tallyEntry([vote("1", "device:a", "support"), vote("2", "device:b", "support"), vote("3", "device:c", "support")]);
    expect(deriveState({ tally: three, signClass: "prohibition", validity, blocked: false, rules }).status).toBe("confirmed");
  });

  it("calls an entry disputed when at least two object and as many as support - and confirmed entries survive a lone objection", () => {
    const contested = tallyEntry([vote("1", "device:a", "support"), vote("2", "device:b", "deny"), vote("3", "device:c", "deny")]);
    expect(deriveState({ tally: contested, signClass: "hazard", validity, blocked: false, rules }).status).toBe("disputed");
    const strong = tallyEntry([vote("1", "device:a", "support"), vote("2", "device:b", "support"), vote("3", "device:c", "support"), vote("4", "device:d", "deny"), vote("5", "device:e", "deny")]);
    expect(deriveState({ tally: strong, signClass: "prohibition", validity, blocked: false, rules }).status).toBe("confirmed");
    const lone = tallyEntry([vote("1", "device:a", "support"), vote("2", "device:b", "deny")]);
    expect(deriveState({ tally: lone, signClass: "hazard", validity, blocked: false, rules }).status).toBe("proposed");
  });

  it("lets an operator's removal win over any votes", () => {
    const three = tallyEntry([vote("1", "device:a", "support"), vote("2", "device:b", "support"), vote("3", "device:c", "support")]);
    expect(deriveState({ tally: three, signClass: "prohibition", validity, blocked: true, rules })).toMatchObject({ status: "removed", expiresAt: null });
  });

  it("expires: unconfirmed after 14 days, a period at its end, 'until revoked' a year after the last support, a permanent sign never", () => {
    const one = tallyEntry([vote("1", "device:a", "support", 0)]);
    expect(deriveState({ tally: one, signClass: "hazard", validity, blocked: false, rules }).expiresAt).toBe(T0 + 14 * DAY);
    const confirmed = tallyEntry([vote("1", "device:a", "support", 0), vote("2", "device:b", "support", 3 * DAY)]);
    expect(deriveState({ tally: confirmed, signClass: "hazard", validity, blocked: false, rules }).expiresAt).toBeNull();
    const period = { ...validity, period: { from: "2026-10-01", to: "2026-11-30" } };
    expect(deriveState({ tally: confirmed, signClass: "hazard", validity: period, blocked: false, rules }).expiresAt).toBe(Date.parse("2026-12-02T00:00:00Z"));
    const open = { ...validity, period: { from: "2026-10-01", to: null } };
    expect(deriveState({ tally: confirmed, signClass: "hazard", validity: open, blocked: false, rules }).expiresAt).toBe(T0 + 3 * DAY + 365 * DAY);
    // a new confirmation keeps an open-ended entry alive
    const renewed = tallyEntry([vote("1", "device:a", "support", 0), vote("2", "device:b", "support", 3 * DAY), vote("3", "device:c", "support", 300 * DAY)]);
    expect(deriveState({ tally: renewed, signClass: "hazard", validity: open, blocked: false, rules }).expiresAt).toBe(T0 + 300 * DAY + 365 * DAY);
  });
});

describe("time zones and tiles", () => {
  it("proposes the zone of a country if this node accepts it, else the node default", () => {
    expect(timezoneOfCountry("DE")).toBe("Europe/Berlin");
    expect(timezoneOfCountry("PT")).toBe("Europe/Lisbon");
    expect(timezoneOfCountry("US")).toBeNull();
    expect(proposeTimezone("DE", ["Europe/"], "Europe/Vienna")).toBe("Europe/Berlin");
    expect(proposeTimezone("IS", ["Europe/"], "Europe/Berlin")).toBe("Europe/Berlin"); // Atlantic/Reykjavik is not open yet
    expect(proposeTimezone(null, ["Europe/"], "Europe/Vienna")).toBe("Europe/Vienna");
  });

  it("tiles a shape by the vertex rule of the static-data packages", () => {
    const tiles = tilesOf(line, 4);
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(tiles).toEqual([...tiles].sort());
    expect(tilesOf([[11.5, 48.1], [11.5, 48.1]], 4)).toHaveLength(1);
  });
});

describe("overlap of two stretches", () => {
  const road: [number, number][] = [[11.5, 48.1], [11.51, 48.1]]; // about 740 m
  it("is the share of one line within the tolerance of the other", () => {
    expect(overlapShare(road, road, 15)).toBe(1);
    expect(overlapShare([[11.502, 48.1], [11.506, 48.1]], road, 15)).toBe(1); // inside it
    expect(overlapShare(road, [[11.502, 48.1], [11.506, 48.1]], 15)).toBeCloseTo(0.4, 1); // the longer one is only partly covered
    expect(overlapShare([[11.5, 48.1005], [11.51, 48.1005]], road, 15)).toBe(0); // 55 m beside it
    expect(overlapShare([[11.5, 48.10005], [11.51, 48.10005]], road, 15)).toBe(1); // 5.6 m beside it
    expect(overlapShare([[11.5, 48.1], [11.5, 48.1]], road, 15)).toBe(0);
  });
});
