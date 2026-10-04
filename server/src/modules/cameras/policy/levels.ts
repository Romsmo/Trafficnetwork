/**
 * Delivery levels of the country-based camera policy (docs/camera-country-policy.md).
 * Ordered from strictest to most generous; "stricter" always means "smaller".
 */
export const CAMERA_LEVELS = ["off", "zones", "full"] as const;
export type CameraLevel = (typeof CAMERA_LEVELS)[number];

const RANK: Record<CameraLevel, number> = { off: 0, zones: 1, full: 2 };

export function isCameraLevel(value: unknown): value is CameraLevel {
  return typeof value === "string" && (CAMERA_LEVELS as readonly string[]).includes(value);
}

/** The stricter of two levels. */
export function stricter(a: CameraLevel, b: CameraLevel): CameraLevel {
  return RANK[a] <= RANK[b] ? a : b;
}

/** The strictest of any number of levels; an empty list is `off` (nothing known = nothing delivered). */
export function strictest(levels: Iterable<CameraLevel>): CameraLevel {
  let result: CameraLevel | undefined;
  for (const level of levels) result = result === undefined ? level : stricter(result, level);
  return result ?? "off";
}

/** ISO 3166-1 alpha-2, upper case. The policy never accepts lower case or longer codes — a typo must not silently match nothing. */
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/** Upper bound on the number of countries a signed policy may list (there are fewer than 250 ISO codes). */
export const MAX_POLICY_COUNTRIES = 300;

export class CameraPolicyError extends Error {}

/**
 * Validates the `cameraPolicyByCountry` object of a signed network config. Throws on anything unexpected rather than
 * dropping it: a policy file that cannot be understood completely must not be applied partly.
 */
export function parseCountryLevels(input: unknown, label = "cameraPolicyByCountry"): Record<string, CameraLevel> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new CameraPolicyError(`${label} must be an object mapping ISO 3166-1 alpha-2 codes to "off" | "zones" | "full"`);
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_POLICY_COUNTRIES) {
    throw new CameraPolicyError(`${label} lists ${entries.length} countries (more than ${MAX_POLICY_COUNTRIES})`);
  }
  const out: Record<string, CameraLevel> = {};
  for (const [code, level] of entries) {
    if (!COUNTRY_CODE_PATTERN.test(code)) {
      throw new CameraPolicyError(`${label}: "${code}" is not an upper-case ISO 3166-1 alpha-2 country code`);
    }
    if (!isCameraLevel(level)) {
      throw new CameraPolicyError(`${label}: level of ${code} must be "off", "zones" or "full" (got ${JSON.stringify(level)})`);
    }
    out[code] = level;
  }
  return out;
}

export interface LocalCaps {
  /** Per-country upper bounds. */
  byCountry: Record<string, CameraLevel>;
  /** The cap of every country not listed (`*=…`); undefined = no cap. */
  fallback: CameraLevel | undefined;
}

/**
 * `CAMERA_POLICY_LOCAL_CAPS`: a node-local upper bound, never a grant — `DE=zones,CH=off,*=full`. The effective level of a
 * country is the stricter of the network policy and its cap, so a cap can only withhold more.
 */
export function parseLocalCaps(spec: string): LocalCaps {
  const caps: LocalCaps = { byCountry: {}, fallback: undefined };
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [code, level, ...rest] = part.split("=").map((s) => s.trim());
    if (rest.length > 0 || code === undefined || level === undefined) {
      throw new CameraPolicyError(`CAMERA_POLICY_LOCAL_CAPS: "${part}" is not of the form CC=level`);
    }
    if (!isCameraLevel(level)) {
      throw new CameraPolicyError(`CAMERA_POLICY_LOCAL_CAPS: level in "${part}" must be off, zones or full`);
    }
    if (code === "*") {
      caps.fallback = level;
    } else if (COUNTRY_CODE_PATTERN.test(code)) {
      caps.byCountry[code] = level;
    } else {
      throw new CameraPolicyError(`CAMERA_POLICY_LOCAL_CAPS: "${code}" is not an upper-case ISO 3166-1 alpha-2 code or *`);
    }
  }
  return caps;
}

export function capFor(caps: LocalCaps, country: string): CameraLevel {
  return caps.byCountry[country] ?? caps.fallback ?? "full";
}
