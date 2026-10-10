import { REPORTABLE_HAZARD_TYPES, type HazardType } from "./constants.js";
import type { Env } from "./env.js";

/**
 * How long a hazard report lives, and how long a reporter may ask it to live (docs/concept.md section 3.2,
 * server/docs/report-expiry.md).
 *
 * Every node of the network must reach the same `expiresAt` for the same signed report, so there is exactly one
 * effective value per type and field. Where it comes from, strongest first:
 *
 *   1. the signed network configuration's `reportExpiry` (signed offline by the network root key),
 *   2. `REPORT_EXPIRY_OVERRIDES` (an isolated node's own override, same JSON shape),
 *   3. the per-type and band environment variables (legacy `HAZARD_EXPIRY_*`),
 *   4. the table below, which ships with the server version.
 *
 * `fixedSpeedCamera` has no entry: it is not a hazard report and never expires.
 */
export type ExpiryType = Exclude<HazardType, "fixedSpeedCamera">;

export interface ExpiryRule {
  /** Used when the reporter does not ask for a duration, and by every confirmation. */
  defaultSeconds: number;
  /** Shortest duration a reporter may ask for. */
  minSeconds: number;
  /** Longest duration a reporter may ask for; no confirmation ever pushes `expiresAt` further than this from now. */
  maxSeconds: number;
}

export type ReportExpiryRules = Readonly<Record<ExpiryType, Readonly<ExpiryRule>>>;
export type ExpiryOverrides = Partial<Record<ExpiryType, Partial<ExpiryRule>>>;

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/** Sanity ceiling for anything an override may set: one year. */
export const ABSOLUTE_MAX_EXPIRY_SECONDS = 365 * DAY;

export const BUILTIN_REPORT_EXPIRY: ReportExpiryRules = {
  // Temporary speed enforcement: a mobile check is usually there for hours, a trailer for days.
  mobileSpeedCamera: { defaultSeconds: 3 * HOUR, minSeconds: 10 * MINUTE, maxSeconds: 12 * HOUR },
  trailerCamera: { defaultSeconds: 14 * DAY, minSeconds: HOUR, maxSeconds: 30 * DAY },
  redLightCamera: { defaultSeconds: 12 * MINUTE, minSeconds: 5 * MINUTE, maxSeconds: 6 * HOUR },
  distanceControl: { defaultSeconds: 12 * MINUTE, minSeconds: 5 * MINUTE, maxSeconds: 6 * HOUR },
  traffic: { defaultSeconds: 25 * MINUTE, minSeconds: 5 * MINUTE, maxSeconds: 6 * HOUR },
  accident: { defaultSeconds: 25 * MINUTE, minSeconds: 10 * MINUTE, maxSeconds: 6 * HOUR },
  breakdown: { defaultSeconds: 25 * MINUTE, minSeconds: 10 * MINUTE, maxSeconds: 6 * HOUR },
  obstacle: { defaultSeconds: 25 * MINUTE, minSeconds: 10 * MINUTE, maxSeconds: 6 * HOUR },
  ice: { defaultSeconds: 25 * MINUTE, minSeconds: 10 * MINUTE, maxSeconds: 12 * HOUR },
  construction: { defaultSeconds: 7 * DAY, minSeconds: HOUR, maxSeconds: 90 * DAY },
};

export class ReportExpiryConfigError extends Error {}

const RULE_FIELDS = ["defaultSeconds", "minSeconds", "maxSeconds"] as const;
// HAZARD_EXPIRY_SHORT_MINUTES keeps meaning "the short band", which is now only these two: every `.env` copied from
// the old .env.example sets it to 12, and that must not undo the 3 h / 14 d of the mobile and the trailer camera.
const SHORT_BAND_TYPES: readonly ExpiryType[] = ["redLightCamera", "distanceControl"];
const MEDIUM_BAND_TYPES: readonly ExpiryType[] = ["traffic", "ice", "accident", "breakdown", "obstacle"];

function isExpiryType(key: string): key is ExpiryType {
  return (REPORTABLE_HAZARD_TYPES as readonly string[]).includes(key);
}

/**
 * Reads `{ "<type>": { defaultSeconds?, minSeconds?, maxSeconds? } }`. Refuses what it cannot understand completely —
 * a signature proves who wrote a file, not that it is well-formed, and a half-applied rule would make nodes disagree.
 */
export function parseExpiryOverrides(raw: unknown, source: string): ExpiryOverrides {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReportExpiryConfigError(`${source}: expected an object keyed by hazard type`);
  }
  const out: ExpiryOverrides = {};
  for (const [type, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isExpiryType(type)) {
      throw new ReportExpiryConfigError(`${source}: "${type}" is not a hazard type with an expiry`);
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ReportExpiryConfigError(`${source}.${type}: expected an object`);
    }
    const rule: Partial<ExpiryRule> = {};
    for (const [field, value] of Object.entries(entry as Record<string, unknown>)) {
      if (!(RULE_FIELDS as readonly string[]).includes(field)) {
        throw new ReportExpiryConfigError(`${source}.${type}: unknown field "${field}"`);
      }
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > ABSOLUTE_MAX_EXPIRY_SECONDS) {
        throw new ReportExpiryConfigError(
          `${source}.${type}.${field}: expected a whole number of seconds between 1 and ${ABSOLUTE_MAX_EXPIRY_SECONDS}`,
        );
      }
      rule[field as keyof ExpiryRule] = value;
    }
    const { minSeconds: min, defaultSeconds: def, maxSeconds: max } = rule;
    if ((min !== undefined && def !== undefined && min > def) || (def !== undefined && max !== undefined && def > max) || (min !== undefined && max !== undefined && min > max)) {
      throw new ReportExpiryConfigError(`${source}.${type}: minSeconds <= defaultSeconds <= maxSeconds is required`);
    }
    out[type] = rule;
  }
  return out;
}

interface Layer {
  source: string;
  overrides: ExpiryOverrides;
  /** Only the signed network configuration is reported as overriding a node's own setting. */
  signed?: boolean;
}

/**
 * The effective rules for this node: pure — the same env and signed payload always give the same result.
 * `warn` is told when the signed configuration replaces a value this node's own environment set differently.
 */
export function resolveReportExpiry(
  env: Env,
  network?: { reportExpiry?: unknown } | null,
  warn?: (message: string) => void,
): ReportExpiryRules {
  const layers: Layer[] = [];

  // 3. environment variables (legacy bands first, the per-type ones beat them)
  const bands: ExpiryOverrides = {};
  if (env.HAZARD_EXPIRY_SHORT_MINUTES !== undefined) {
    for (const t of SHORT_BAND_TYPES) bands[t] = { defaultSeconds: env.HAZARD_EXPIRY_SHORT_MINUTES * MINUTE };
  }
  for (const t of MEDIUM_BAND_TYPES) bands[t] = { defaultSeconds: env.HAZARD_EXPIRY_MEDIUM_MINUTES * MINUTE };
  bands.construction = { defaultSeconds: env.HAZARD_EXPIRY_CONSTRUCTION_DAYS * DAY };
  layers.push({ source: "HAZARD_EXPIRY_*_MINUTES/DAYS", overrides: bands });

  const perType: ExpiryOverrides = {};
  if (env.HAZARD_EXPIRY_MOBILE_SPEED_CAMERA_MINUTES !== undefined) {
    perType.mobileSpeedCamera = { defaultSeconds: env.HAZARD_EXPIRY_MOBILE_SPEED_CAMERA_MINUTES * MINUTE };
  }
  if (env.HAZARD_EXPIRY_TRAILER_CAMERA_DAYS !== undefined) {
    perType.trailerCamera = { defaultSeconds: env.HAZARD_EXPIRY_TRAILER_CAMERA_DAYS * DAY };
  }
  layers.push({ source: "HAZARD_EXPIRY_MOBILE_SPEED_CAMERA_MINUTES/HAZARD_EXPIRY_TRAILER_CAMERA_DAYS", overrides: perType });

  // 2. the node's JSON override
  if (env.REPORT_EXPIRY_OVERRIDES && env.REPORT_EXPIRY_OVERRIDES.trim() !== "") {
    layers.push({
      source: "REPORT_EXPIRY_OVERRIDES",
      overrides: parseExpiryOverrides(JSON.parse(env.REPORT_EXPIRY_OVERRIDES), "REPORT_EXPIRY_OVERRIDES"),
    });
  }

  // 1. the signed network configuration
  if (network?.reportExpiry !== undefined) {
    layers.push({ source: "signed network configuration", overrides: parseExpiryOverrides(network.reportExpiry, "reportExpiry"), signed: true });
  }

  const rules = {} as Record<ExpiryType, ExpiryRule>;
  for (const t of REPORTABLE_HAZARD_TYPES) rules[t] = { ...BUILTIN_REPORT_EXPIRY[t] };
  const nodeSet = new Map<string, { source: string; value: number }>();

  for (const layer of layers) {
    for (const [type, partial] of Object.entries(layer.overrides) as [ExpiryType, Partial<ExpiryRule>][]) {
      for (const field of RULE_FIELDS) {
        const value = partial[field];
        if (value === undefined) continue;
        const key = `${type}.${field}`;
        const previous = nodeSet.get(key);
        if (layer.signed && previous && previous.value !== value && warn) {
          warn(
            `report expiry ${key}: ${previous.source} sets ${previous.value}, the signed network configuration sets ${value} — the signed value applies`,
          );
        }
        rules[type][field] = value;
        if (!layer.signed && value !== BUILTIN_REPORT_EXPIRY[type][field]) nodeSet.set(key, { source: layer.source, value });
      }
    }
  }

  // The default is always inside its own bounds, whatever layer moved which field.
  for (const t of REPORTABLE_HAZARD_TYPES) {
    const r = rules[t];
    r.minSeconds = Math.min(r.minSeconds, r.defaultSeconds);
    r.maxSeconds = Math.max(r.maxSeconds, r.defaultSeconds);
  }
  return rules;
}

export type RequestedExpiryCheck = { ok: true; seconds: number } | { ok: false; rule: ExpiryRule; message: string };

/** Validates a duration a reporter asked for (or returns the default when none was asked for). */
export function checkRequestedExpiry(rules: ReportExpiryRules, type: ExpiryType, requestedSeconds: number | undefined): RequestedExpiryCheck {
  const rule = rules[type];
  if (requestedSeconds === undefined) return { ok: true, seconds: rule.defaultSeconds };
  if (!Number.isInteger(requestedSeconds) || requestedSeconds < rule.minSeconds || requestedSeconds > rule.maxSeconds) {
    return {
      ok: false,
      rule: { ...rule },
      message: `expiresInSeconds for "${type}" must be a whole number between ${rule.minSeconds} and ${rule.maxSeconds} (default ${rule.defaultSeconds})`,
    };
  }
  return { ok: true, seconds: requestedSeconds };
}

/** The shape `GET /v1/config` publishes as `reportExpiry`. */
export function describeReportExpiry(rules: ReportExpiryRules): Record<string, ExpiryRule> {
  return Object.fromEntries(REPORTABLE_HAZARD_TYPES.map((t) => [t, { ...rules[t] }]));
}
