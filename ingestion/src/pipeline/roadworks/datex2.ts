import { SaxesParser, type SaxesTagNS } from "saxes";
import type { ParseResult, RoadworkCandidate, SkippedRecord, TimeWindow, Validity } from "./types.js";
import { parseIsoWithOffset } from "./time.js";

/**
 * DATEX II roadworks reader for v2.x and v3 publications (streaming, namespace-prefix independent).
 *
 * Written against two real documents: the French national feed (transport.data.gouv.fr, DATEX II 2_0, SOAP-wrapped, TPEG `from`/`to`
 * point coordinates) and the Dutch NDW planning feed (opendata.ndw.nu, DATEX II v3, `gmlLineString`/`posList`). For the parts read here — situation
 * records, validity, point coordinates — v2 and v3 use the same element names, so one reader serves both; the location referencing differs
 * only in that v3 usually carries a GML line string, which is handled below. Anything not recognized is skipped with its reason.
 *
 * What is taken from a `situationRecord`:
 *  - only the roadworks family (`MaintenanceWorks`, `ConstructionWorks`). The traffic measures that accompany them (lane/carriageway
 *    management, rerouting, speed management) describe the consequences, not the works, and would duplicate them;
 *  - the record id as the external id (stable per record; `version` changes, the id does not);
 *  - validity: `overallStartTime` / `overallEndTime` and explicit `validPeriod`s. A `validityStatus` of `suspended`, and validity given as
 *    recurring patterns (`recurringTimePeriodOfDay`, `recurringDayWeekMonthPeriod`) are NOT evaluated: such a record is skipped with that
 *    reason rather than shown as permanently active. Times without a zone offset are never guessed;
 *  - one representative point: the `from` end of a linear location (start of the stretch), else the first point coordinate, else the first
 *    vertex of a GML `posList` (axis order taken from its `srsName`; an unknown coordinate system is skipped, not guessed).
 */

const WORKS_TYPES = new Set(["MaintenanceWorks", "ConstructionWorks"]);

type Axis = "latlon" | "lonlat" | "unsupported";

function axisOf(srsName: string | undefined): Axis {
  if (!srsName) return "latlon"; // GML in DATEX II defaults to WGS 84 as written by the publishers seen so far
  if (/CRS84/i.test(srsName)) return "lonlat";
  if (/^(WGS ?84|EPSG:4326|urn:ogc:def:crs:EPSG:[0-9.]*:4326|https?:\/\/www\.opengis\.net\/def\/crs\/EPSG\/0\/4326)$/i.test(srsName.trim())) return "latlon";
  return "unsupported";
}

interface Coordinate {
  lat?: number;
  lng?: number;
  underFrom: boolean;
  /** `locationForDisplay`: the publisher's own "show it here" point. Used only when the record has no coordinate of its own. */
  forDisplay?: boolean;
  unsupportedAxis?: string;
}

interface PeriodState {
  start?: string;
  end?: string;
  name?: string;
}

interface RecordState {
  id: string;
  type: string;
  validityStatus?: string;
  overallStart?: string;
  overallEnd?: string;
  /** `validPeriod`s: when the record IS in force. */
  periods: PeriodState[];
  /** `exceptionPeriod`s: when the record is NOT in force although the overall interval says so. */
  exceptions: PeriodState[];
  recurring: boolean;
  coordinates: Coordinate[];
  comments: { type?: string; text: string }[];
}

function parentChain(path: string[], ancestor: string): boolean {
  return path.includes(ancestor);
}

/** The period element the reader is currently inside (the innermost of `exceptionPeriod` / `validPeriod`), or undefined when it is inside neither. */
function currentPeriod(record: RecordState, path: string[]): PeriodState | undefined {
  const exception = path.lastIndexOf("exceptionPeriod");
  const valid = path.lastIndexOf("validPeriod");
  if (exception < 0 && valid < 0) return undefined;
  return exception > valid ? record.exceptions[record.exceptions.length - 1] : record.periods[record.periods.length - 1];
}

export async function parseDatex2(source: AsyncIterable<string | Uint8Array>): Promise<ParseResult> {
  const candidates: RoadworkCandidate[] = [];
  const skipped: SkippedRecord[] = [];
  let totalSeen = 0;
  let publishedAt: Date | undefined;
  let error: Error | undefined;

  const parser = new SaxesParser({ xmlns: true });
  const path: string[] = [];
  let record: RecordState | undefined;
  let text = "";
  let currentComment: { type?: string; text: string } | undefined;
  let srsName: string | undefined;

  const skip = (externalId: string | undefined, reason: string): void => {
    skipped.push({ externalId, reason });
  };

  const finish = (r: RecordState): void => {
    totalSeen++;
    if (!WORKS_TYPES.has(r.type)) return skip(r.id, `record type ${r.type || "unknown"} is not roadworks`);
    if (r.validityStatus === "suspended") return skip(r.id, "validity status suspended");
    if (r.recurring) return skip(r.id, "validity given as a recurring period (not evaluated)");

    const start = parseIsoWithOffset(r.overallStart);
    const end = parseIsoWithOffset(r.overallEnd);
    if ((r.overallStart && !start) || (r.overallEnd && !end)) return skip(r.id, "validity time without a zone offset (not guessed)");

    const windows: TimeWindow[] = [];
    const caveats = new Set<string>();
    for (const period of r.periods) {
      if (!period.start && !period.end) {
        // Real data (French feed: all 120 validPeriods) has periods that only carry a name such as "Uniquement de jour": a qualifier of the
        // overall interval, not a time window. The overall interval stays authoritative; the qualifier is reported, not evaluated.
        caveats.add(`period qualifier not evaluated: ${period.name ?? "unnamed"}`);
        continue;
      }
      const ps = parseIsoWithOffset(period.start);
      const pe = parseIsoWithOffset(period.end);
      if (!ps || !pe) return skip(r.id, "validPeriod with only one of start/end, or without a zone offset (not guessed)");
      windows.push({ start: ps, end: pe });
    }

    // Exception periods (French feed, 58 of them on 2026-10-11: "week-end et jours fériés" or a concrete start/end) are the times the works are
    // NOT in force although the overall interval says so. A concrete one is honoured when it runs at import time (selectActive); a named one,
    // and every concrete one still ahead, is reported as a caveat — never turned into a window of validity, which they are the opposite of.
    const exceptions: TimeWindow[] = [];
    for (const exception of r.exceptions) {
      const es = parseIsoWithOffset(exception.start);
      const ee = parseIsoWithOffset(exception.end);
      if (es && ee && ee.getTime() > es.getTime()) {
        exceptions.push({ start: es, end: ee });
        caveats.add("exception period ahead not applied to the end date");
      } else {
        caveats.add(`exception period not evaluated: ${exception.name ?? "unnamed"}`);
      }
    }
    const caveat = caveats.size > 0 ? [...caveats].sort().join("; ") : undefined;

    const usable = r.coordinates.filter((c) => c.lat !== undefined && c.lng !== undefined);
    const point = usable.find((c) => c.underFrom) ?? usable.find((c) => !c.forDisplay) ?? usable[0];
    if (!point) {
      const unsupported = r.coordinates.find((c) => c.unsupportedAxis)?.unsupportedAxis;
      return skip(r.id, unsupported ? `unsupported coordinate system ${unsupported}` : "no coordinates");
    }
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat!) > 90 || Math.abs(point.lng!) > 180) return skip(r.id, "coordinates out of range");

    const validity: Validity = { start, end, ...(windows.length > 0 ? { windows } : {}), ...(exceptions.length > 0 ? { exceptions } : {}) };
    const description = r.comments.find((c) => c.type === "description")?.text ?? r.comments[0]?.text;
    candidates.push({ externalId: r.id, lat: point.lat!, lng: point.lng!, validity, description, ...(caveat ? { caveat } : {}) });
  };

  parser.on("error", (err) => {
    error ??= err;
  });

  parser.on("opentag", (tag: SaxesTagNS) => {
    path.push(tag.local);
    text = "";
    if (tag.local === "situationRecord") {
      const attrs = Object.values(tag.attributes);
      const xsiType = attrs.find((a) => a.local === "type" && a.uri === "http://www.w3.org/2001/XMLSchema-instance")?.value ?? "";
      const id = attrs.find((a) => a.local === "id" && a.uri === "")?.value ?? "";
      record = { id, type: xsiType.includes(":") ? xsiType.slice(xsiType.indexOf(":") + 1) : xsiType, periods: [], exceptions: [], recurring: false, coordinates: [], comments: [] };
    } else if (record) {
      if (tag.local === "validPeriod") record.periods.push({});
      else if (tag.local === "exceptionPeriod") record.exceptions.push({});
      else if (tag.local === "recurringTimePeriodOfDay" || tag.local === "recurringDayWeekMonthPeriod") record.recurring = true;
      else if (tag.local === "pointCoordinates") record.coordinates.push({ underFrom: path.includes("from") });
      else if (tag.local === "locationForDisplay") record.coordinates.push({ underFrom: false, forDisplay: true });
      else if (tag.local === "generalPublicComment") currentComment = { text: "" };
      else if (tag.local === "gmlLineString" || tag.local === "posList") {
        const name = Object.values(tag.attributes).find((a) => a.local === "srsName")?.value;
        if (name !== undefined) srsName = name;
        if (tag.local === "gmlLineString") srsName = name;
      }
    }
  });

  parser.on("text", (chunk) => {
    text += chunk;
  });

  parser.on("closetag", (tag: SaxesTagNS) => {
    const name = tag.local;
    const value = text.trim();
    if (record) {
      const parent = path[path.length - 2];
      if (name === "validityStatus") record.validityStatus = value;
      else if (name === "overallStartTime") record.overallStart = value;
      else if (name === "overallEndTime") record.overallEnd = value;
      else if (name === "startOfPeriod" || name === "endOfPeriod") {
        // `startOfPeriod` is used by `validPeriod` AND `exceptionPeriod`; which one it belongs to decides whether it opens a window or a gap.
        const period = currentPeriod(record, path);
        if (period) period[name === "startOfPeriod" ? "start" : "end"] = value;
      } else if (name === "value" && parentChain(path, "periodName")) {
        const period = currentPeriod(record, path);
        if (period) period.name ??= value;
      } else if ((name === "latitude" || name === "longitude") && (parent === "pointCoordinates" || parent === "locationForDisplay")) {
        const coordinate = record.coordinates[record.coordinates.length - 1];
        if (coordinate) coordinate[name === "latitude" ? "lat" : "lng"] = Number(value);
      } else if (name === "posList") {
        const [first, second] = value.split(/\s+/).map(Number);
        const axis = axisOf(srsName);
        if (axis === "unsupported") record.coordinates.push({ underFrom: path.includes("from"), unsupportedAxis: srsName });
        else if (first !== undefined && second !== undefined) record.coordinates.push(axis === "latlon" ? { lat: first, lng: second, underFrom: path.includes("from") } : { lat: second, lng: first, underFrom: path.includes("from") });
      } else if (name === "commentType" && currentComment) currentComment.type = value;
      else if (name === "value" && currentComment && path.includes("comment") && !currentComment.text) currentComment.text = value;
      else if (name === "generalPublicComment" && currentComment) {
        record.comments.push(currentComment);
        currentComment = undefined;
      } else if (name === "situationRecord") {
        // One record the reader cannot make sense of must cost that record, never the whole feed (a throw here used to fail the French feed
        // on 2026-10-11 because of an `exceptionPeriod`).
        const finished = record;
        record = undefined;
        try {
          finish(finished);
        } catch (err) {
          skip(finished.id, `record could not be evaluated: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else if (name === "publicationTime" && path[path.length - 2] === "payloadPublication") {
      const parsed = parseIsoWithOffset(value);
      if (parsed) publishedAt = parsed;
    } else if (name === "publicationTime" && path[path.length - 2] === "payload") {
      // v3: <mc:payload xsi:type="sit:SituationPublication"><com:publicationTime>
      const parsed = parseIsoWithOffset(value);
      if (parsed) publishedAt = parsed;
    }
    path.pop();
    text = "";
  });

  for await (const chunk of source) {
    if (error) break;
    parser.write(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  if (!error) {
    try {
      parser.close();
    } catch (err) {
      error ??= err as Error;
    }
  }

  const incompleteReason = error ? `XML did not parse to its end: ${error.message.split("\n")[0]}` : totalSeen === 0 ? "the document contained no situation records at all" : undefined;
  return { candidates, skipped, totalSeen, complete: !incompleteReason, publishedAt, incompleteReason };
}
