/**
 * Builds a Postgres array literal (`{a,b,c}`) from a string array.
 *
 * Interpolating a bare JS array into drizzle-orm's `sql` template expands it
 * into a parenthesized, comma-separated parameter list (`($1, $2)`) — meant
 * for `IN (...)`-style lists — not a single array-typed parameter. That
 * breaks `= any(...)` and `::type[]` casts against a real Postgres array.
 * Passing the pre-built literal string instead sidesteps the expansion: it's
 * a single scalar parameter, and Postgres's own array input parser (invoked
 * by the `::type[]` cast, or by `any()`'s parameter-type inference) parses it
 * correctly.
 */
export function pgArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}
