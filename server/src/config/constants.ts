import type { Env } from "./env.js";

/**
 * HazardType enum, fixed order per docs/concept.md section 3.2 ("Reihenfolge nicht
 * ändern, nur anhängen"). fixedSpeedCamera is accepted as an input classification on
 * report submission but is routed into the fixed_speed_cameras table before insert
 * (see modules/cameras) — it never becomes a hazard_reports row and therefore has no
 * expiry band below.
 */
export const HAZARD_TYPES = [
  "traffic",
  "ice",
  "accident",
  "construction",
  "breakdown",
  "obstacle",
  "fixedSpeedCamera",
  "mobileSpeedCamera",
  "trailerCamera",
  "redLightCamera",
  "distanceControl",
] as const;

export type HazardType = (typeof HAZARD_TYPES)[number];

/** HazardType values that are ever stored as hazard_reports rows (excludes fixedSpeedCamera). */
export const REPORTABLE_HAZARD_TYPES = HAZARD_TYPES.filter(
  (t): t is Exclude<HazardType, "fixedSpeedCamera"> => t !== "fixedSpeedCamera",
);

/** The five speed-camera-adjacent types gated by SPEED_CAMERA_NAMESPACE_ENABLED. */
export const CAMERA_NAMESPACE_TYPES: readonly HazardType[] = [
  "fixedSpeedCamera",
  "mobileSpeedCamera",
  "trailerCamera",
  "redLightCamera",
  "distanceControl",
];

/**
 * The general /v1/hazard-reports/* endpoints only ever serve these — the four
 * camera-adjacent types that live in hazard_reports (mobileSpeedCamera etc.) are
 * exposed exclusively through /v1/speed-cameras/* (milestone P1.4), gated by the
 * namespace flag, so a client that never asks about cameras never sees them mixed
 * into an otherwise unrelated "traffic near me" query.
 */
export const NON_CAMERA_HAZARD_TYPES = REPORTABLE_HAZARD_TYPES.filter(
  (t) => !CAMERA_NAMESPACE_TYPES.includes(t),
);

/** The four camera-adjacent types actually stored as hazard_reports rows (excludes fixedSpeedCamera, which lives in its own table). */
export const DYNAMIC_CAMERA_TYPES = CAMERA_NAMESPACE_TYPES.filter((t) => t !== "fixedSpeedCamera");

type ExpiryBand = "short" | "medium" | "construction";

const EXPIRY_BAND_BY_TYPE: Record<Exclude<HazardType, "fixedSpeedCamera">, ExpiryBand> = {
  mobileSpeedCamera: "short",
  trailerCamera: "short",
  redLightCamera: "short",
  distanceControl: "short",
  traffic: "medium",
  ice: "medium",
  accident: "medium",
  breakdown: "medium",
  obstacle: "medium",
  construction: "construction",
};

/**
 * Base time-to-live for a freshly created (or re-confirmed) hazard report, per
 * docs/concept.md section 3.2. A "stillThere" confirmation resets expiresAt to
 * now + this duration rather than adding a fixed increment — simplest rule that
 * satisfies "Verlängerung durch Bestätigung" without inventing a second constant.
 */
export function hazardExpiryMs(type: Exclude<HazardType, "fixedSpeedCamera">, env: Env): number {
  const band = EXPIRY_BAND_BY_TYPE[type];
  switch (band) {
    case "short":
      return env.HAZARD_EXPIRY_SHORT_MINUTES * 60_000;
    case "medium":
      return env.HAZARD_EXPIRY_MEDIUM_MINUTES * 60_000;
    case "construction":
      return env.HAZARD_EXPIRY_CONSTRUCTION_DAYS * 24 * 60 * 60_000;
  }
}

/** construction is the only band with no automatic-expiry test expectation beyond its long default. */
export const AUTO_EXPIRING_BANDS: readonly ExpiryBand[] = ["short", "medium", "construction"];

/**
 * Device kinds stored in fixed_speed_cameras (add-on D, docs/persistent-enforcement-devices.md):
 * permanently installed enforcement devices that never expire and leave only through
 * accumulated "gone" reports. Every value is also a HazardType, so a client that decodes
 * `type` into the hazard enum handles them. Append only, like HAZARD_TYPES — a new value
 * must not reach a field an existing client decodes before that client tolerates unknown
 * values (client-lib decodes `type` into a closed enum).
 */
export const PERSISTENT_CAMERA_TYPES = ["fixedSpeedCamera", "redLightCamera", "distanceControl"] as const;
export type PersistentCameraType = (typeof PERSISTENT_CAMERA_TYPES)[number];

/** The persistent kinds that are not classic speed cameras: announced as `enforcementDevice`, never as `fixedSpeedCamera`. */
export const ADDITIONAL_PERSISTENT_CAMERA_TYPES = PERSISTENT_CAMERA_TYPES.filter(
  (t): t is Exclude<PersistentCameraType, "fixedSpeedCamera"> => t !== "fixedSpeedCamera",
);

export function isPersistentCameraType(type: string): type is PersistentCameraType {
  return (PERSISTENT_CAMERA_TYPES as readonly string[]).includes(type);
}

export const EVENT_TYPES = [
  "ReportCreated",
  "ReportConfirmed",
  "ReportDenied",
  "ReportExpired",
  "StaticDataUpdated",
  "StaticDataRemoved",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const ENTITY_TYPES = [
  "hazardReport",
  "fixedSpeedCamera",
  "speedLimitSegment",
  "staticSign",
  // Add-on D: events about persistent red-light / distance devices. Kept apart from
  // `fixedSpeedCamera` because clients treat that entity type as a classic speed camera.
  "enforcementDevice",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const SPEED_LIMIT_UNITS = ["kmh", "mph"] as const;
export type SpeedLimitUnit = (typeof SPEED_LIMIT_UNITS)[number];

/**
 * Community speed-limit corrections (add-on K-A, docs/speed-limit-corrections.md).
 * Lifecycle order matches the prompt: proposed -> applied -> reverted/superseded.
 */
export const CORRECTION_STATUSES = ["proposed", "applied", "superseded", "reverted"] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

/** "support" = "the limit here is X" (a proposal or a confirmation of one), "deny" = "X is wrong". */
export const CORRECTION_VOTE_KINDS = ["support", "deny"] as const;
export type CorrectionVoteKind = (typeof CORRECTION_VOTE_KINDS)[number];

/** Optional, informational: why the reporter thinks the imported value is wrong (prompt: falscher Wert, Limit aufgehoben, Schild fehlt/neu). */
export const CORRECTION_REASONS = ["wrong_value", "limit_lifted", "sign_missing_or_new", "other"] as const;
export type CorrectionReason = (typeof CORRECTION_REASONS)[number];

export const CLIENT_SCOPES = ["client", "bulk-import", "device-registration"] as const;
export type ClientScope = (typeof CLIENT_SCOPES)[number];
