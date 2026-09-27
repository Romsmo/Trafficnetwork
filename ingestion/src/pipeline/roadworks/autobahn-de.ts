import type { ParseResult, RoadworkCandidate, SkippedRecord, TimeWindow, Validity } from "./types.js";
import { parseIsoWithOffset, zonedTimeToDate } from "./time.js";

/**
 * Autobahn GmbH des Bundes roadworks (verkehr.autobahn.de/o/autobahn) — a bespoke JSON API, NOT DATEX II.
 *
 * Written against live responses (A9, A99, 2026-09-26). One request per road returns `{ roadworks: [...] }`; each entry has
 * `identifier`, `coordinate {lat,long}` (the start of the affected stretch), `display_type` and free-text `description` lines. The
 * times are only in the text, as German local time (Europe/Berlin), in three shapes seen in the real data:
 *
 *  - long-term phase (`display_type` ROADWORKS):     `Beginn: 25.06.26 um 23:00 Uhr` / `Ende: 13.11.26 um 18:00 Uhr`
 *    (the line `(Ende der Gesamtmaßnahme: …)` is the end of the whole project, not of this phase, and is ignored);
 *  - short-term works (SHORT_TERM_ROADWORKS), windows: `01.10.26 22:00 bis zum 02.10.26 05:00 Uhr.`
 *  - short-term works, same-day window:               `10.10.26 von 08:00 bis 20:00 Uhr`
 *  - short-term works, recurring by weekday:          `Jeden Montag, Dienstag und Freitag zwischen dem 28.09.26 und dem 10.10.26 von 19:00 bis 00:00 Uhr.`
 *    (`Jeden Tag …` = every day; an end time not after the start time means the next day, so "19:00 bis 00:00" ends at midnight). Each
 *    matching day becomes one window, so a night work is active at night only;
 *
 * A short-term work is only there during its windows (typically at night), so it is reported active only while a window is
 * running — a roadwork is never shown "all day" because its first window started. Anything not matching these shapes is skipped
 * with its reason, not guessed. The API's own `future` flag is not relied on: its meaning is undocumented, and in the real data
 * it was false for works whose windows lie days ahead.
 */

const ZONE = "Europe/Berlin";

const LONG_START = /^Beginn:\s*(\d{2})\.(\d{2})\.(\d{2})\s+um\s+(\d{2}):(\d{2})\s*Uhr/;
const LONG_END = /^Ende:\s*(\d{2})\.(\d{2})\.(\d{2})\s+um\s+(\d{2}):(\d{2})\s*Uhr/;
const WINDOW_SPAN = /^(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})\s+bis(?:\s+zum)?\s+(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})\s*Uhr/;
const WINDOW_SAME_DAY = /^(\d{2})\.(\d{2})\.(\d{2})\s+von\s+(\d{2}):(\d{2})\s+bis\s+(\d{2}):(\d{2})\s*Uhr/;
const WINDOW_RECURRING = /^Jeden\s+(.+?)\s+zwischen dem\s+(\d{2})\.(\d{2})\.(\d{2})\s+und dem\s+(\d{2})\.(\d{2})\.(\d{2})\s+von\s+(\d{2}):(\d{2})\s+bis\s+(\d{2}):(\d{2})\s*Uhr/;

const WEEKDAYS: Record<string, number> = { Sonntag: 0, Montag: 1, Dienstag: 2, Mittwoch: 3, Donnerstag: 4, Freitag: 5, Samstag: 6 };
const MAX_RECURRING_DAYS = 400;

/** The weekdays a "Jeden …" phrase names (0 = Sunday), or undefined if it names anything this reader does not know. */
function weekdaysOf(phrase: string): Set<number> | undefined {
  if (phrase.trim() === "Tag") return new Set([0, 1, 2, 3, 4, 5, 6]);
  const days = new Set<number>();
  for (const word of phrase.split(/,|\bund\b/).map((w) => w.trim()).filter((w) => w.length > 0)) {
    const day = WEEKDAYS[word];
    if (day === undefined) return undefined;
    days.add(day);
  }
  return days.size > 0 ? days : undefined;
}

/** One window per matching calendar day between two dates (Berlin calendar days). Undefined if the phrase or the range is not understood. */
function recurringWindows(m: RegExpExecArray): TimeWindow[] | undefined {
  const weekdays = weekdaysOf(m[1]!);
  if (!weekdays) return undefined;
  const from = Date.UTC(2000 + Number(m[4]), Number(m[3]) - 1, Number(m[2]));
  const to = Date.UTC(2000 + Number(m[7]), Number(m[6]) - 1, Number(m[5]));
  if (to < from || (to - from) / 86_400_000 > MAX_RECURRING_DAYS) return undefined;
  const [sh, sm, eh, em] = [Number(m[8]), Number(m[9]), Number(m[10]), Number(m[11])];
  const endsNextDay = eh * 60 + em <= sh * 60 + sm;
  const windows: TimeWindow[] = [];
  for (let t = from; t <= to; t += 86_400_000) {
    const day = new Date(t);
    if (!weekdays.has(day.getUTCDay())) continue;
    const end = new Date(t + (endsNextDay ? 86_400_000 : 0));
    windows.push({
      start: zonedTimeToDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), sh, sm, ZONE),
      end: zonedTimeToDate(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate(), eh, em, ZONE),
    });
  }
  return windows;
}

function berlin(dd: string, mm: string, yy: string, hh: string, mi: string): Date {
  return zonedTimeToDate(2000 + Number(yy), Number(mm), Number(dd), Number(hh), Number(mi), ZONE);
}

interface AutobahnRoadwork {
  identifier?: unknown;
  display_type?: unknown;
  title?: unknown;
  startTimestamp?: unknown;
  coordinate?: { lat?: unknown; long?: unknown };
  description?: unknown;
}

/** Turns the description lines into a validity, or explains why they cannot be evaluated. */
export function parseAutobahnValidity(lines: string[], startTimestamp?: string): { validity: Validity } | { unevaluated: string } {
  let start: Date | undefined;
  let end: Date | undefined;
  const windows: TimeWindow[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = LONG_START.exec(line))) start = berlin(m[1]!, m[2]!, m[3]!, m[4]!, m[5]!);
    else if ((m = LONG_END.exec(line))) end = berlin(m[1]!, m[2]!, m[3]!, m[4]!, m[5]!);
    else if ((m = WINDOW_SPAN.exec(line))) windows.push({ start: berlin(m[1]!, m[2]!, m[3]!, m[4]!, m[5]!), end: berlin(m[6]!, m[7]!, m[8]!, m[9]!, m[10]!) });
    else if ((m = WINDOW_SAME_DAY.exec(line))) windows.push({ start: berlin(m[1]!, m[2]!, m[3]!, m[4]!, m[5]!), end: berlin(m[1]!, m[2]!, m[3]!, m[6]!, m[7]!) });
    else if ((m = WINDOW_RECURRING.exec(line))) {
      const expanded = recurringWindows(m);
      if (!expanded) return { unevaluated: "recurring validity phrase not understood" };
      windows.push(...expanded);
    }
  }

  // The structured timestamp, when present, is authoritative for the start of a long-term phase (it carries its offset).
  const structuredStart = parseIsoWithOffset(startTimestamp);
  if (structuredStart) start = structuredStart;

  if (windows.some((w) => w.end.getTime() <= w.start.getTime())) return { unevaluated: "a validity window ends before it starts" };
  if (windows.length > 0) return { validity: { windows } };
  if (start || end) {
    if (start && end && end.getTime() <= start.getTime()) return { unevaluated: "phase end is not after its start" };
    return { validity: { start, end } };
  }
  return { unevaluated: "no evaluable validity in the description text" };
}

/** Normalizes the `roadworks` arrays of every road; `complete` says whether every road's request succeeded. */
export function normalizeAutobahnRoadworks(perRoad: { road: string; roadworks: unknown[] }[], complete: boolean, incompleteReason?: string): ParseResult {
  const candidates: RoadworkCandidate[] = [];
  const skipped: SkippedRecord[] = [];
  let totalSeen = 0;
  const seen = new Set<string>();

  for (const { roadworks } of perRoad) {
    for (const entry of roadworks) {
      totalSeen++;
      const rw = entry as AutobahnRoadwork;
      const id = typeof rw.identifier === "string" && rw.identifier.length > 0 ? rw.identifier : undefined;
      if (!id) {
        skipped.push({ reason: "entry without an identifier" });
        continue;
      }
      if (seen.has(id)) {
        skipped.push({ externalId: id, reason: "same identifier listed under more than one road" });
        continue;
      }
      seen.add(id);

      const lat = Number(rw.coordinate?.lat);
      const lng = Number(rw.coordinate?.long);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        skipped.push({ externalId: id, reason: "no usable coordinate" });
        continue;
      }
      const lines = Array.isArray(rw.description) ? rw.description.filter((l): l is string => typeof l === "string") : [];
      const parsed = parseAutobahnValidity(lines, typeof rw.startTimestamp === "string" ? rw.startTimestamp : undefined);
      if ("unevaluated" in parsed) {
        skipped.push({ externalId: id, reason: parsed.unevaluated });
        continue;
      }
      candidates.push({ externalId: id, lat, lng, validity: parsed.validity, description: typeof rw.title === "string" ? rw.title : undefined });
    }
  }
  return { candidates, skipped, totalSeen, complete: complete && totalSeen > 0, incompleteReason: complete ? (totalSeen === 0 ? "the API returned no roadworks at all" : undefined) : incompleteReason };
}
