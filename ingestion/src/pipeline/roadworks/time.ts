/**
 * Local wall-clock time in a named zone → the instant it denotes.
 *
 * The Autobahn GmbH API states times as German text ("Ende: 13.11.26 um 18:00 Uhr") without an offset; the
 * offset depends on daylight saving, so it is derived from the zone's own rules (Intl), never hard-coded.
 * Guess the instant as if the wall time were UTC, ask what offset the zone has at that instant, correct, and
 * repeat once — the second pass settles the hours around a DST switch.
 */
export function zonedTimeToDate(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wallAsUtc;
  for (let i = 0; i < 2; i++) instant = wallAsUtc - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const value = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second")) - Math.floor(at.getTime() / 1000) * 1000;
}

/** A `Date` from an ISO-8601 string that carries an explicit offset (`Z` or `±hh:mm`); undefined for anything else (no zone → never guessed). */
export function parseIsoWithOffset(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
