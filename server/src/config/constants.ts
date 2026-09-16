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
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const CLIENT_SCOPES = ["client", "bulk-import"] as const;
export type ClientScope = (typeof CLIENT_SCOPES)[number];
