import type postgres from "postgres";

/**
 * Fixes the JSON shape of every **raw-SQL** read (`db.execute(sql\`...\`)`, used throughout
 * `db/queries/*.ts` instead of Drizzle's typed query builder — see those files' header comments
 * for why: PostGIS geometry columns, `for update`, `on conflict`, lateral joins and the like have
 * no typed-builder equivalent here). Without this, two column types come back wrong:
 *
 * 1. **`timestamptz` (OID 1184)** — `reportedAt`/`expiresAt`/`occurredAt` and friends came back as
 *    Postgres's own text form (`"2026-09-27 14:45:15.923718+00"`), not the RFC 3339 `api.md`
 *    documents (`"2026-09-27T14:45:15.923Z"`). Root cause: `drizzle-orm/postgres-js`'s driver
 *    (`construct()` in `drizzle-orm/postgres-js/driver.js`) installs a **transparent passthrough**
 *    parser for this OID on the *shared* postgres.js client, replacing its normal
 *    "parse to a JS `Date`" behaviour — so that its own typed query builder gets raw driver text
 *    and can apply its column-aware `PgTimestamp.mapFromDriverValue` exactly once, predictably.
 *    Raw SQL never goes through that mapping, so it kept the untouched Postgres text.
 * 2. **`int8`/`bigint` (OID 20)** — `sequence`/`snapshotSequence`/`nextSince` (and other bigserial
 *    ids) came back as a JSON *string*, because postgres.js has **no default parser for OID 20 at
 *    all** (its own `types.js`, deliberately: an int8 can exceed `Number.MAX_SAFE_INTEGER`). Every
 *    bigserial/bigint column in this schema is declared `{ mode: "number" }` (see `db/schema/*.ts`)
 *    and this project's own row counts stay far below 2^53 (documented on `event_log.sequence`),
 *    so converting with `Number(...)` here is safe and matches what the typed builder's
 *    `PgBigInt53.mapFromDriverValue` already does for the same columns.
 *
 * The fix: re-register both OIDs on the client's own parser table, normalizing to exactly what
 * `api.md` documents. This is a no-op for Drizzle's typed query builder — `PgTimestamp.mapFromDriverValue`
 * and `PgBigInt53.mapFromDriverValue` both accept a string input and produce the same `Date`/`number`
 * regardless of which text form the string is in — so every existing typed-builder read keeps working
 * exactly as before. Must run *after* `drizzle(client, ...)`, which is what installs the transparent
 * OID-1184 passthrough in the first place; installing our parsers earlier would just be overwritten.
 *
 * Only these two OIDs are touched. The schema has no plain `date`/`time`/`timestamp without time zone`
 * column, and no `bigint`/`timestamptz` *array* column (see the OID list `construct()` also
 * transparently passes through: 1082, 1083, 1114, 1182, 1185, 1115, 1231) — so leaving those as
 * Drizzle's passthrough is inert today. Add the matching OID here if such a column is ever introduced
 * and read through raw SQL.
 */
export function installRawSqlTypeParsers(client: postgres.Sql): void {
  client.options.parsers[20] = (value: string) => Number(value);
  client.options.parsers[1184] = (value: string) => new Date(value).toISOString();
}
