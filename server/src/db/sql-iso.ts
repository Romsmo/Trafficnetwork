import { sql, type SQL } from "drizzle-orm";

/**
 * ISO-8601 UTC text for a timestamptz column expression (`2026-09-24T12:00:00.123Z`).
 * Raw driver output for timestamps is Postgres' own text form (`2026-09-24 12:00:00.123+00`),
 * which older endpoints still return as-is; the correction endpoints use this so the new
 * fields are unambiguous ISO strings. `expr` must be a trusted SQL fragment (a column
 * name written in source), never user input.
 */
export function isoTimestamp(expr: string): SQL {
  return sql.raw(`to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
}
