/**
 * Postgres error codes live on the driver's error, but drizzle-orm (0.45) wraps a failed query in a
 * `DrizzleQueryError` and keeps the driver's error under `.cause` — so `err.code` alone misses them.
 * Walks the `cause` chain (bounded) looking for the SQLSTATE.
 */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** SQLSTATE 23505: a UNIQUE constraint was violated. */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23505";
}
