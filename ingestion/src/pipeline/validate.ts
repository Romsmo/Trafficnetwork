import type { NormalizedRow } from "./worker.js";

/**
 * Client-side mirror of the server's bulk-import row schemas
 * (server/src/modules/bulk-import/routes.ts) plus a plausibility ceiling.
 *
 * Why it exists: the server validates a whole batch and answers 400 for all
 * 2000 rows if one is invalid (real OSM data contained a stray `maxspeed=0`).
 * Catching what we can before the POST keeps batches whole; whatever the
 * server still rejects is handled by bisecting (pipeline/run-worker.ts).
 *
 * The plausibility ceiling is deliberately NOT a server rule: a numeric limit
 * above 200 km/h (125 mph) is a mapping typo, and importing it would put a
 * nonsensical number in front of a driver. Such rows are quarantined, not dropped
 * silently, so they stay inspectable.
 */
const MAX_PLAUSIBLE_KMH = 200;
const MAX_PLAUSIBLE_MPH = 125;

function isLng(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

function isLat(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

/** Returns a human-readable problem, or undefined if the row is acceptable. */
export function validateRow(normalized: NormalizedRow): string | undefined {
  switch (normalized.kind) {
    case "speed-limit-segment": {
      const row = normalized.row;
      if (!Array.isArray(row.lineString) || row.lineString.length < 2) return "lineString has fewer than 2 points";
      for (const point of row.lineString) {
        if (!Array.isArray(point) || point.length !== 2 || !isLng(point[0]) || !isLat(point[1])) return "lineString has a point outside [lng ±180, lat ±90]";
      }
      if (typeof row.speedLimit !== "number" || !Number.isFinite(row.speedLimit) || row.speedLimit <= 0) return `speedLimit ${String(row.speedLimit)} is not a positive number`;
      // The server's column is `integer` (db/schema/static.ts) while its Zod schema accepts any positive number:
      // a value like 42.5 passes validation and then fails in Postgres with a 500 that no retry can fix.
      if (!Number.isInteger(row.speedLimit)) return `speedLimit ${row.speedLimit} is not a whole number (the server stores integers)`;
      if (row.speedLimitUnit !== "kmh" && row.speedLimitUnit !== "mph") return `speedLimitUnit ${String(row.speedLimitUnit)} is not kmh/mph`;
      if (row.speedLimit > (row.speedLimitUnit === "kmh" ? MAX_PLAUSIBLE_KMH : MAX_PLAUSIBLE_MPH)) return `implausible speed limit ${row.speedLimit} ${row.speedLimitUnit}`;
      if (!row.source) return "empty source";
      return undefined;
    }
    case "static-sign": {
      const row = normalized.row;
      if (!isLat(row.lat) || !isLng(row.lng)) return "position outside [lat ±90, lng ±180]";
      if (typeof row.signType !== "string" || row.signType.length === 0) return "empty signType";
      if (row.signType.includes("\u0000")) return "signType contains a NUL character (Postgres text cannot store it)";
      if (!row.source) return "empty source";
      return undefined;
    }
    case "fixed-speed-camera": {
      const row = normalized.row;
      if (!isLat(row.lat) || !isLng(row.lng)) return "position outside [lat ±90, lng ±180]";
      if (!row.source) return "empty source";
      return undefined;
    }
  }
}
