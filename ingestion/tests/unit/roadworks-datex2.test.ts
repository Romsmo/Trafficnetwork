import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDatex2 } from "../../src/pipeline/roadworks/datex2.js";

const FIXTURES = path.resolve(fileURLToPath(import.meta.url), "../../fixtures/roadworks");
const read = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

async function* chunks(text: string, size: number): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

const parse = (xml: string, size = 65_536) => parseDatex2(chunks(xml, size));

/**
 * The fixtures are verbatim excerpts of real documents fetched on 2026-09-26: the French national feed
 * (transport.data.gouv.fr, Licence Ouverte 2.0; DATEX II v2, SOAP-wrapped) and the Dutch NDW planning feed
 * (opendata.ndw.nu; DATEX II v3).
 */
describe("parseDatex2 — French feed excerpt (DATEX II v2)", () => {
  it("reads the roadworks records and skips everything that is not roadworks, with reasons", async () => {
    const result = await parse(read("fr-tipi-excerpt.xml"));

    expect(result.complete).toBe(true);
    expect(result.totalSeen).toBe(5);
    expect(result.candidates.map((c) => c.externalId)).toEqual(["260918-001633-1", "260924-004402-1", "260915-001097-1"]);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(["record type RoadOrCarriagewayOrLaneManagement is not roadworks", "record type WeatherRelatedRoadConditions is not roadworks"]);
    expect(result.publishedAt?.toISOString()).toBe("2026-09-26T08:13:26.751Z");
  });

  it("uses the `from` end of a linear location as the representative point (in the document `to` comes first)", async () => {
    const [first] = (await parse(read("fr-tipi-excerpt.xml"))).candidates;
    // The record lists to = 44.57667/6.0742097 and then from = 44.581257/6.080705.
    expect(first).toMatchObject({ lat: 44.581257, lng: 6.080705 });
  });

  it("reads overall validity with its zone offset, and reports (not evaluates) a period that only carries a name", async () => {
    const { candidates } = await parse(read("fr-tipi-excerpt.xml"));
    const [named, dated, open] = candidates;

    expect(named!.validity.start?.toISOString()).toBe("2026-10-05T18:00:00.000Z");
    expect(named!.validity.end?.toISOString()).toBe("2026-10-16T04:00:00.000Z");
    expect(named!.validity.windows).toBeUndefined();
    expect(named!.caveat).toBe("period qualifier not evaluated: Uniquement de nuit"); // real data: all 120 validPeriods of the feed are name-only

    expect(dated!.validity.end?.toISOString()).toBe("2026-10-12T14:00:00.000Z");
    expect(dated!.caveat).toBeUndefined();

    expect(open!.validity.start?.toISOString()).toBe("2026-09-15T08:47:07.658Z");
    expect(open!.validity.end).toBeUndefined(); // no end date → the server's ttl applies
  });

  it("gives the same result however the document is chunked (streaming)", async () => {
    const whole = await parse(read("fr-tipi-excerpt.xml"));
    for (const size of [7, 97, 1000]) {
      const streamed = await parse(read("fr-tipi-excerpt.xml"), size);
      expect(streamed.candidates).toEqual(whole.candidates);
      expect(streamed.skipped).toEqual(whole.skipped);
    }
  });

  it("marks a truncated download as incomplete (a run on it must never retire anything)", async () => {
    const xml = read("fr-tipi-excerpt.xml");
    const result = await parse(xml.slice(0, Math.floor(xml.length * 0.6)));
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toMatch(/did not parse to its end/);
  });

  it("treats a document without any situation record as incomplete rather than as 'no roadworks'", async () => {
    const result = await parse('<?xml version="1.0"?><d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0"><payloadPublication/></d2LogicalModel>');
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toMatch(/no situation records/);
  });
});

describe("parseDatex2 — Dutch NDW feed excerpt (DATEX II v3)", () => {
  it("reads a v3 record: GML posList (lat lon), validity in UTC, prefix-independent element names", async () => {
    const result = await parse(read("ndw-v3-excerpt.xml"));
    expect(result.complete).toBe(true);
    expect(result.totalSeen).toBe(3);
    expect(result.candidates).toHaveLength(1);
    const [c] = result.candidates;
    expect(c).toMatchObject({ externalId: "NDW03_613534_MAN", lat: 52.094624, lng: 5.1257863 });
    expect(c!.validity.start?.toISOString()).toBe("2026-09-24T05:00:00.000Z");
    expect(c!.validity.end?.toISOString()).toBe("2026-10-30T15:00:00.000Z");
    expect(result.publishedAt?.toISOString()).toBe("2026-09-26T08:15:00.003Z");
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(["record type PublicEvent is not roadworks", "record type SpeedManagement is not roadworks"]);
  });

  it("reads the axis order from the srsName when the polyline is the only coordinate: CRS84 is lon/lat, an unknown system is skipped, not guessed", async () => {
    // In the real excerpt the roadworks record has a point and the (skipped) speed record has the polyline. Give the roadworks
    // record the polyline instead, so the GML coordinates are all it has.
    const point = /<loc:pointCoordinates><loc:latitude>52\.094624<\/loc:latitude><loc:longitude>5\.1257863<\/loc:longitude><\/loc:pointCoordinates>/;
    const withLine = (srsName: string, posList: string) =>
      read("ndw-v3-excerpt.xml").replace(point, `<loc:gmlLineString srsName="${srsName}"><loc:posList>${posList}</loc:posList></loc:gmlLineString>`);

    // "WGS 84": lat lon, first vertex
    expect((await parse(withLine("WGS 84", "52.094556 5.125911 52.094636 5.125887"))).candidates[0]).toMatchObject({ lat: 52.094556, lng: 5.125911 });
    // CRS84: lon lat — the same place, written the other way round
    expect((await parse(withLine("urn:ogc:def:crs:OGC:1.3:CRS84", "5.125911 52.094556 5.125887 52.094636"))).candidates[0]).toMatchObject({ lat: 52.094556, lng: 5.125911 });

    const result = await parse(withLine("EPSG:2154", "52.094556 5.125911"));
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped.find((s) => s.externalId === "NDW03_613534_MAN")?.reason).toBe("unsupported coordinate system EPSG:2154");
  });

  it("prefers the record's own point coordinates over the polyline", async () => {
    const [c] = (await parse(read("ndw-v3-excerpt.xml"))).candidates;
    expect(c).toMatchObject({ lat: 52.094624, lng: 5.1257863 });
  });
});

describe("parseDatex2 — what is deliberately not guessed", () => {
  const base = read("ndw-v3-excerpt.xml");

  it("skips a record whose validity time has no zone offset", async () => {
    const result = await parse(base.replace("2026-09-24T05:00:00Z", "2026-09-24T05:00:00"));
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped.find((s) => s.externalId === "NDW03_613534_MAN")?.reason).toMatch(/without a zone offset/);
  });

  it("skips a suspended record", async () => {
    const result = await parse(base.replace(/<com:validityStatus>[^<]*<\/com:validityStatus>/, "<com:validityStatus>suspended</com:validityStatus>"));
    expect(result.skipped.find((s) => s.externalId === "NDW03_613534_MAN")?.reason).toBe("validity status suspended");
  });

  it("skips validity given as a recurring pattern instead of showing it as permanently active", async () => {
    const withRecurring = base.replace("</com:validityTimeSpecification>", "<com:recurringTimePeriodOfDay><com:startTimeOfPeriod>22:00:00</com:startTimeOfPeriod></com:recurringTimePeriodOfDay></com:validityTimeSpecification>");
    const result = await parse(withRecurring);
    expect(result.skipped.find((s) => s.externalId === "NDW03_613534_MAN")?.reason).toMatch(/recurring period/);
  });

  it("reads explicit validPeriods as time windows (NDW writes one that equals the overall span; more can follow)", async () => {
    const [plain] = (await parse(base)).candidates;
    expect(plain!.validity.windows).toEqual([{ start: new Date("2026-09-24T05:00:00Z"), end: new Date("2026-10-30T15:00:00Z") }]);

    const withPeriod = base.replace(
      "</com:validityTimeSpecification>",
      "<com:validPeriod><com:startOfPeriod>2026-10-01T20:00:00Z</com:startOfPeriod><com:endOfPeriod>2026-10-02T04:00:00Z</com:endOfPeriod></com:validPeriod></com:validityTimeSpecification>",
    );
    const [c] = (await parse(withPeriod)).candidates;
    expect(c!.validity.windows).toEqual([
      { start: new Date("2026-09-24T05:00:00Z"), end: new Date("2026-10-30T15:00:00Z") },
      { start: new Date("2026-10-01T20:00:00Z"), end: new Date("2026-10-02T04:00:00Z") },
    ]);
  });

  it("skips a validPeriod that has only one of start/end", async () => {
    const half = base.replace("</com:validityTimeSpecification>", "<com:validPeriod><com:startOfPeriod>2026-10-01T20:00:00Z</com:startOfPeriod></com:validPeriod></com:validityTimeSpecification>");
    expect((await parse(half)).skipped.find((s) => s.externalId === "NDW03_613534_MAN")?.reason).toMatch(/only one of start\/end/);
  });
});

/**
 * Fixtures fetched 2026-10-11 (verbatim excerpts): the French feed document that FAILED the importer ("Cannot set properties of
 * undefined (setting 'start')") because it carries `exceptionPeriod` elements, and the Luxembourg CITA feed (DATEX II 2.0, CC0 on
 * data.public.lu), whose records locate a stretch with `locationForDisplay` only.
 */
describe("parseDatex2 — exception periods (French feed, 2026-10-11)", () => {
  const parseFr = () => parse(read("fr-tipi-exceptions-excerpt.xml"));

  it("reads the whole document: an exceptionPeriod used to throw and fail the entire feed", async () => {
    const result = await parseFr();
    expect(result.complete).toBe(true);
    expect(result.candidates.map((c) => c.externalId)).toEqual(["260928-001439-1", "261001-001715-1", "260625-000925-1", "260122-001707-1"]);
    expect(result.skipped.filter((s) => /could not be evaluated/.test(s.reason))).toEqual([]);
  });

  it("a concrete exceptionPeriod is an exception to the overall interval, never a window of validity", async () => {
    const [first] = (await parseFr()).candidates;
    expect(first!.validity.windows).toBeUndefined();
    expect(first!.validity.start).toEqual(new Date("2026-09-28T22:01:00Z"));
    expect(first!.validity.end).toEqual(new Date("2026-11-06T17:00:00Z"));
    expect(first!.validity.exceptions).toEqual([{ start: new Date("2026-10-05T04:00:00Z"), end: new Date("2026-10-09T16:00:00Z") }]);
    expect(first!.caveat).toBe("exception period ahead not applied to the end date");
  });

  it("a named exception ('week-end et jours fériés') is counted as a caveat, not evaluated and not guessed", async () => {
    const third = (await parseFr()).candidates.find((c) => c.externalId === "260625-000925-1");
    expect(third!.validity.exceptions).toBeUndefined();
    expect(third!.caveat).toBe("exception period not evaluated: week-end et jours fériés; period qualifier not evaluated: Uniquement de jour");
  });

  it("a record without any period keeps no caveat", async () => {
    const plain = (await parseFr()).candidates.find((c) => c.externalId === "260122-001707-1");
    expect(plain!.caveat).toBeUndefined();
    expect(plain!.validity).toEqual({ start: new Date("2026-12-03T07:30:00Z"), end: new Date("2026-12-03T15:30:00Z") });
  });

  it("an exception whose times cannot be read is reported as not evaluated; the other records are unaffected", async () => {
    const broken = read("fr-tipi-exceptions-excerpt.xml").replace("<ns2:startOfPeriod>2026-10-05T06:00:00.000+02:00</ns2:startOfPeriod>", "<ns2:startOfPeriod>not a time</ns2:startOfPeriod>");
    const result = await parse(broken);
    expect(result.complete).toBe(true);
    expect(result.candidates.map((c) => c.externalId)).toContain("260122-001707-1");
    expect(result.candidates.find((c) => c.externalId === "260928-001439-1")!.caveat).toBe("exception period not evaluated: unnamed");
  });

  it("a startOfPeriod outside any validPeriod/exceptionPeriod is ignored instead of crashing the reader", async () => {
    const stray = read("ndw-v3-excerpt.xml").replace("<com:validityTimeSpecification>", "<com:validityTimeSpecification><com:startOfPeriod>2026-10-01T20:00:00Z</com:startOfPeriod>");
    const result = await parse(stray);
    expect(result.complete).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(0);
  });
});

describe("parseDatex2 — Luxembourg CITA excerpt (DATEX II 2.0, locationForDisplay)", () => {
  it("places a record on its locationForDisplay point when it has no other coordinate", async () => {
    const result = await parse(read("lu-cita-excerpt.xml"));
    expect(result.complete).toBe(true);
    expect(result.publishedAt).toEqual(new Date("2026-10-11T10:20:04.276Z"));
    expect(result.candidates.map((c) => [c.externalId, c.lat, c.lng])).toEqual([
      ["237687-1", 49.534996, 6.021889],
      ["237687-2", 49.534836, 6.021822],
      ["231225-1", 49.57074, 6.125748],
    ]);
  });

  it("keeps a start without an end open-ended (the feed's ttlHours bounds it) and skips what is not roadworks, with the reason", async () => {
    const result = await parse(read("lu-cita-excerpt.xml"));
    expect(result.candidates[0]!.validity).toEqual({ start: new Date("2026-10-10T07:00:32Z") });
    expect(result.skipped.map((s) => s.reason)).toEqual(["record type EquipmentOrSystemFault is not roadworks", "record type PublicEvent is not roadworks"]);
  });

  it("prefers a real coordinate of the record over its locationForDisplay", async () => {
    const withPoint = read("lu-cita-excerpt.xml").replace(
      "<locationForDisplay>",
      '<tpegLinearLocation><from xsi:type="TpegNonJunctionPoint"><pointCoordinates><latitude>49.6</latitude><longitude>6.1</longitude></pointCoordinates></from></tpegLinearLocation><locationForDisplay>',
    );
    const [first] = (await parse(withPoint)).candidates;
    expect(first).toMatchObject({ lat: 49.6, lng: 6.1 });
  });
});
