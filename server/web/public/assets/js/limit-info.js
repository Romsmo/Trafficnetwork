/**
 * What the page knows how to say about a road's speed limit and about proposals for it (server 1.1.0: community corrections,
 * docs/speed-limit-corrections.md). Pure functions on the node's answers; the page (limit-detail.js) only turns them into elements.
 */
import { distanceToLineMeters } from "./geo.js";

/** The four road axes the page offers for "no limit on record" (the server needs a direction; a visitor cannot know a bearing). */
export const AXES = [
  { id: "ns", bearingDegrees: 0 },
  { id: "nesw", bearingDegrees: 45 },
  { id: "ew", bearingDegrees: 90 },
  { id: "nwse", bearingDegrees: 135 },
];

/** Reasons the node knows (additive enum). The first of each list is the preselected one. */
export const WRONG_REASONS = ["wrong_value", "limit_lifted", "sign_missing_or_new", "other"];
export const MISSING_REASONS = ["missing", "sign_missing_or_new", "limit_lifted", "other"];

/** A tap this close (metres) to a recorded road counts as "on that road"; the node's own lookup reaches further (200 m by default). */
export const NEAR_ROAD_NOTE_M = 200;

const COMMON_VALUES = {
  kmh: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 130],
  mph: [15, 20, 25, 30, 40, 50, 60, 70],
};

/** The community-correction settings of a node (`communityCorrections` in GET /v1/config), or null if it offers none. */
export function correctionSettings(serverConfig) {
  const c = serverConfig?.communityCorrections;
  if (!c || c.enabled !== true) return null;
  const range = (unit) => {
    const r = c.valueRange?.[unit];
    return r && Number.isInteger(r.min) && Number.isInteger(r.max) ? { min: r.min, max: r.max } : null;
  };
  const kmh = range("kmh");
  const mph = range("mph");
  if (!kmh || !mph || !Number.isInteger(c.valueStep) || c.valueStep <= 0) return null;
  return {
    required: Number.isInteger(c.confirmationsRequired) ? c.confirmationsRequired : 3,
    step: c.valueStep,
    range: { kmh, mph },
    windowMinutes: c.rateLimit?.windowMinutes ?? null,
  };
}

/** The quick-pick values that are allowed for a unit (inside the node's range, on its step), without the value already in force. */
export function quickValues(unit, settings, current = null) {
  const range = settings.range[unit];
  return (COMMON_VALUES[unit] ?? []).filter((v) => v >= range.min && v <= range.max && v % settings.step === 0 && v !== current);
}

/**
 * A typed value -> { ok: true, value } or { ok: false, reason, ... } with the numbers the message needs.
 * `current` (the value in force on an existing road) is refused as "noChange": the node would answer 422 CORRECTION_NO_CHANGE.
 */
export function validateValue(raw, unit, settings, current = null) {
  const range = settings.range[unit];
  const base = { min: range.min, max: range.max, step: settings.step };
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: false, reason: "empty", ...base };
  if (!/^\d+$/.test(text)) return { ok: false, reason: "notANumber", ...base };
  const value = Number(text);
  if (value < range.min || value > range.max) return { ok: false, reason: "outOfRange", ...base };
  if (value % settings.step !== 0) return { ok: false, reason: "notOnStep", ...base };
  if (current !== null && value === current) return { ok: false, reason: "noChange", ...base };
  return { ok: true, value };
}

/**
 * What a lookup (GET /v1/speed-limit) means for a tap `toleranceM` away from nothing in particular:
 * - "road": a recorded road is where the visitor tapped,
 * - "nearby": a recorded road exists within the node's lookup distance but not here (the tapped road has no entry),
 * - "none": nothing recorded in reach (the node answered 404, `lookup` is null).
 */
export function classifyLookup(lookup, toleranceM) {
  if (!lookup) return { kind: "none" };
  const distance = Number(lookup.distanceMeters);
  if (Number.isFinite(distance) && distance <= toleranceM) return { kind: "road", distance };
  return { kind: "nearby", distance: Number.isFinite(distance) ? Math.round(distance) : null };
}

/**
 * Where the shown value comes from.
 * - "imported": from the node's imported map data, no correction applies,
 * - "corrected": the community changed an imported value (`importedSpeedLimit` is still shown),
 * - "added": the community supplied a value for a road that had none (no imported value).
 */
export function describeOrigin(segment) {
  if (!segment?.correctedBy) return { kind: "imported" };
  const c = segment.correction ?? {};
  const counts = { confirmations: c.confirmations ?? 0, denials: c.denials ?? 0, needsReview: c.needsReview === true, correctionId: c.id ?? null };
  if (Number.isFinite(segment.importedSpeedLimit)) return { kind: "corrected", imported: segment.importedSpeedLimit, ...counts };
  return { kind: "added", ...counts };
}

/** Open proposals (status `proposed`) the visitor could confirm or deny, newest information first. */
export function openProposals(corrections) {
  return (corrections ?? [])
    .filter((c) => c && c.status === "proposed" && typeof c.id === "string")
    .sort((a, b) => (b.confirmations ?? 0) - (a.confirmations ?? 0));
}

/** Proposals for a road that has no segment yet (`segmentId: null`, with a geometry) that run within `maxMeters` of the tap. */
export function gapProposalsNear(corrections, point, maxMeters = 40) {
  return openProposals(corrections).filter((c) => c.segmentId === null && c.geometry?.coordinates && distanceToLineMeters(point, c.geometry.coordinates) <= maxMeters);
}

/**
 * The node's answer to a proposal or a vote -> what to tell the visitor (honest: new / merged into an existing one / nothing
 * changed, and whether the value now applies). `required` is the number of confirmations the node asks for.
 */
export function describeVoteResult(response, required) {
  const correction = response?.correction ?? {};
  const confirmations = Number(correction.confirmations ?? 0);
  const denials = Number(correction.denials ?? 0);
  const applied = correction.status === "applied";
  let kind = "new";
  if (response?.recorded === false) kind = "unchanged";
  else if (response?.merged === true) kind = "merged";
  return { kind, applied, confirmations, denials, required, value: correction.value ?? null, unit: correction.unit ?? null };
}

/**
 * An error from the node -> { key, params } for the i18n key `limit.error.<key>`, plus `switchTo` when the node says the road does
 * have a limit after all (422 ROAD_ALREADY_HAS_LIMIT names the segment: the visitor should correct that one).
 */
export function describeCorrectionError(error, settings) {
  const status = error?.status;
  const code = error?.code;
  const d = error?.details ?? {};
  if (status === 422 && code === "ROAD_ALREADY_HAS_LIMIT") {
    return { key: "roadAlreadyHasLimit", params: {}, switchTo: { segmentId: d.segmentId, speedLimit: d.speedLimit, unit: d.unit } };
  }
  if (status === 422 && code === "CORRECTION_VALUE_OUT_OF_RANGE") return { key: "outOfRange", params: { min: d.min, max: d.max, unit: d.unit } };
  if (status === 422 && code === "CORRECTION_VALUE_NOT_ON_STEP") return { key: "notOnStep", params: { step: d.step } };
  if (status === 422 && code === "CORRECTION_NO_CHANGE") return { key: "noChange", params: {} };
  if (status === 422 && code === "CORRECTION_UNIT_MISMATCH") return { key: "unitMismatch", params: { unit: d.segmentUnit } };
  if (status === 429) {
    const webScope = typeof d.scope === "string" ? d.scope : "";
    if (code === "WEB_RATE_LIMITED") {
      const scope = webScope.startsWith("session") ? "session" : webScope.startsWith("node") ? "node" : "network";
      return { key: `rateLimited.${scope}`, params: { minutes: Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60)) } };
    }
    return { key: "rateLimitedCorrections", params: { minutes: settings?.windowMinutes ?? 60 } };
  }
  if (status === 403) return { key: "forbidden", params: {} };
  if (status === 404) return { key: "notFound", params: {} };
  if (status === 400 || status === 422) return { key: "rejected", params: { reason: error.message ?? "" } };
  return { key: "failed", params: {} };
}
