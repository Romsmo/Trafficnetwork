/**
 * Report objects carry the reporting client's pseudonymous id (`reporterId`). Authenticated API clients have always
 * seen it; an anonymous web visitor has no credential at all, so web sessions must not learn other devices' ids.
 * Removes every `reporterId` key from a JSON-like value (deeply, non-mutating).
 */
export function stripReporterIds<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripReporterIds(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === "reporterId") continue;
      out[key] = stripReporterIds(inner);
    }
    return out as T;
  }
  return value;
}
