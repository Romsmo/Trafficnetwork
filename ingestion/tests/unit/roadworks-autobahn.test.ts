import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeAutobahnRoadworks, parseAutobahnValidity } from "../../src/pipeline/roadworks/autobahn-de.js";
import { parseIsoWithOffset, zonedTimeToDate } from "../../src/pipeline/roadworks/time.js";

const FIXTURE = JSON.parse(readFileSync(path.resolve(fileURLToPath(import.meta.url), "../../fixtures/roadworks/autobahn-de-excerpt.json"), "utf8")) as {
  roads: string[];
  roadworksByRoad: Record<string, { identifier: string; description: string[]; startTimestamp?: string }[]>;
};
const perRoad = Object.entries(FIXTURE.roadworksByRoad).map(([road, roadworks]) => ({ road, roadworks }));
const iso = (d: Date | undefined) => d?.toISOString();

describe("zonedTimeToDate (Europe/Berlin wall time → instant)", () => {
  it("applies the summer and the winter offset", () => {
    expect(zonedTimeToDate(2026, 6, 25, 23, 0, "Europe/Berlin").toISOString()).toBe("2026-06-25T21:00:00.000Z"); // CEST +02:00
    expect(zonedTimeToDate(2026, 11, 13, 18, 0, "Europe/Berlin").toISOString()).toBe("2026-11-13T17:00:00.000Z"); // CET +01:00
  });

  it("gets the days of the daylight-saving switches right", () => {
    expect(zonedTimeToDate(2026, 3, 29, 3, 30, "Europe/Berlin").toISOString()).toBe("2026-03-29T01:30:00.000Z"); // after 02:00 → 03:00
    expect(zonedTimeToDate(2026, 3, 29, 1, 30, "Europe/Berlin").toISOString()).toBe("2026-03-29T00:30:00.000Z"); // still +01:00
    expect(zonedTimeToDate(2026, 10, 25, 4, 0, "Europe/Berlin").toISOString()).toBe("2026-10-25T03:00:00.000Z"); // back to +01:00
  });
});

describe("parseIsoWithOffset", () => {
  it("accepts an explicit offset and refuses a time without one", () => {
    expect(iso(parseIsoWithOffset("2026-06-25T23:00:00+02:00"))).toBe("2026-06-25T21:00:00.000Z");
    expect(iso(parseIsoWithOffset("2026-09-24T05:00:00Z"))).toBe("2026-09-24T05:00:00.000Z");
    expect(parseIsoWithOffset("2026-09-24T05:00:00")).toBeUndefined();
    expect(parseIsoWithOffset("24.09.2026")).toBeUndefined();
    expect(parseIsoWithOffset(undefined)).toBeUndefined();
  });
});

describe("Autobahn GmbH roadworks — real records (A9, A1; fetched 2026-09-26)", () => {
  const result = normalizeAutobahnRoadworks(perRoad, true);
  const byId = (fragment: string) => result.candidates.find((c) => c.externalId.includes(fragment))!;

  it("turns every fixture record into a candidate at the API's own start coordinate", () => {
    expect(result.complete).toBe(true);
    expect(result.totalSeen).toBe(5);
    expect(result.candidates).toHaveLength(5);
    expect(byId("2026-003224--vi-bs.2026-06-25_23-00-00-000.devi-zus.2026-04-16_08-00-00-000.de11")).toMatchObject({ lat: 51.98688767215983, lng: 12.535771294841245 });
  });

  it("long-term phase: 'Beginn' / 'Ende' in German local time — and the text agrees with the structured startTimestamp", () => {
    const phase = byId("2026-003224--vi-bs.2026-06-25_23-00-00-000.devi-zus.2026-04-16_08-00-00-000.de11");
    expect(iso(phase.validity.start)).toBe("2026-06-25T21:00:00.000Z");
    expect(iso(phase.validity.end)).toBe("2026-11-13T17:00:00.000Z"); // 13.11.26 18:00 CET; NOT the end of the whole project (27.11.27)
    // Without the structured timestamp the German text alone gives the same instant.
    const fromTextOnly = parseAutobahnValidity(["Beginn: 25.06.26 um 23:00 Uhr", "Ende: 13.11.26 um 18:00 Uhr"]);
    expect("validity" in fromTextOnly && iso(fromTextOnly.validity.start)).toBe("2026-06-25T21:00:00.000Z");
  });

  it("short-term works with a window spanning midnight", () => {
    const span = byId("2026-049043--vi-bs.2026-10-01_21-00-00-000.de0");
    expect(span.validity.windows?.map((w) => [iso(w.start), iso(w.end)])).toEqual([["2026-10-01T19:00:00.000Z", "2026-10-02T04:00:00.000Z"]]);
    expect(span.validity.start).toBeUndefined();
  });

  it("short-term works with a same-day window", () => {
    const same = byId("2026-049045--vi-bs.2026-09-28_10-00-00-000");
    expect(same.validity.windows?.map((w) => [iso(w.start), iso(w.end)])).toEqual([["2026-09-28T08:00:00.000Z", "2026-09-28T16:00:00.000Z"]]);
  });

  it("short-term works recurring on named weekdays become one window per matching day (Tue–Thu, 29.09.–01.10.26, 09:00–15:00)", () => {
    const rec = byId("2026-048129--vi-bs.2026-09-29_09-00-00-000");
    expect(rec.validity.windows?.map((w) => [iso(w.start), iso(w.end)])).toEqual([
      ["2026-09-29T07:00:00.000Z", "2026-09-29T13:00:00.000Z"],
      ["2026-09-30T07:00:00.000Z", "2026-09-30T13:00:00.000Z"],
      ["2026-10-01T07:00:00.000Z", "2026-10-01T13:00:00.000Z"],
    ]);
  });
});

describe("parseAutobahnValidity — recurring phrases", () => {
  const windows = (line: string) => {
    const r = parseAutobahnValidity([line]);
    return "validity" in r ? (r.validity.windows ?? []).map((w) => [iso(w.start), iso(w.end)]) : r;
  };

  it("'until 00:00' ends at midnight of the NEXT day, and 'Jeden Tag' means every day", () => {
    expect(windows("Jeden Tag zwischen dem 21.09.26 und dem 22.09.26 von 21:00 bis 00:00 Uhr.")).toEqual([
      ["2026-09-21T19:00:00.000Z", "2026-09-21T22:00:00.000Z"],
      ["2026-09-22T19:00:00.000Z", "2026-09-22T22:00:00.000Z"],
    ]);
  });

  it("only the named weekdays, and a duplicated weekday name is harmless (real data: 'Jeden Mittwoch und Mittwoch')", () => {
    // 28.09.26 is a Monday; Mon–Fri → 28.–30.09. inside 28.09.–30.09.
    expect(windows("Jeden Montag, Dienstag, Mittwoch, Donnerstag und Freitag zwischen dem 28.09.26 und dem 30.09.26 von 19:00 bis 00:00 Uhr.")).toHaveLength(3);
    expect(windows("Jeden Mittwoch und Mittwoch zwischen dem 02.09.26 und dem 30.09.26 von 07:00 bis 14:00 Uhr.")).toHaveLength(5); // Wednesdays 02., 09., 16., 23., 30.
  });

  it("does not guess a weekday word it does not know, or an absurd range", () => {
    expect(windows("Jeden Feiertag zwischen dem 28.09.26 und dem 30.09.26 von 19:00 bis 00:00 Uhr.")).toEqual({ unevaluated: "recurring validity phrase not understood" });
    expect(windows("Jeden Tag zwischen dem 01.01.26 und dem 31.12.30 von 19:00 bis 00:00 Uhr.")).toEqual({ unevaluated: "recurring validity phrase not understood" });
  });

  it("says why when there is nothing to evaluate", () => {
    expect(parseAutobahnValidity(["Baustelle wegen Hochwasser", "keine Zeitangabe"])).toEqual({ unevaluated: "no evaluable validity in the description text" });
  });
});

describe("normalizeAutobahnRoadworks — completeness and bad entries", () => {
  const good = { identifier: "a", coordinate: { lat: 50, long: 10 }, description: ["Beginn: 01.01.26 um 08:00 Uhr"] };

  it("is complete only when every road request succeeded", () => {
    expect(normalizeAutobahnRoadworks([{ road: "A1", roadworks: [good] }], false, "1 of 55 road requests failed")).toMatchObject({ complete: false, incompleteReason: "1 of 55 road requests failed" });
  });

  it("does not call an empty answer 'complete' (an outage must not look like 'all roadworks ended')", () => {
    expect(normalizeAutobahnRoadworks([{ road: "A1", roadworks: [] }], true)).toMatchObject({ complete: false, incompleteReason: "the API returned no roadworks at all" });
  });

  it("skips entries without identifier or coordinate, and an identifier listed under two roads", () => {
    const result = normalizeAutobahnRoadworks(
      [
        { road: "A1", roadworks: [good, { ...good, identifier: undefined }, { ...good, identifier: "b", coordinate: {} }] },
        { road: "A2", roadworks: [good] },
      ],
      true,
    );
    expect(result.candidates.map((c) => c.externalId)).toEqual(["a"]);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(["entry without an identifier", "no usable coordinate", "same identifier listed under more than one road"]);
  });
});
