import type { Env } from "../../config/env.js";
import type { HazardType } from "../../config/constants.js";
import { badRequest } from "../../lib/errors.js";

/**
 * speedKmh is only meaningful for the two mobile/temporary speed-enforcement
 * types — docs/concept.md's HazardReport pseudocode notes it's for "mobile
 * Geschwindigkeitskontrollen" (mobile speed checks); trailerCamera is the same
 * kind of temporary setup. Fixed cameras don't carry a measured speed at all
 * (they're not even hazard_reports rows — see modules/cameras, milestone P1.4).
 */
const TYPES_ACCEPTING_SPEED_KMH: readonly HazardType[] = ["mobileSpeedCamera", "trailerCamera"];

/**
 * type excludes fixedSpeedCamera: the route layer (modules/hazard-reports/routes.ts)
 * routes that classification into modules/cameras/service.ts before this ever
 * runs, since it's never stored as a hazard_reports row.
 */
export interface HazardReportInput {
  type: Exclude<HazardType, "fixedSpeedCamera">;
  lat: number;
  lng: number;
  speedKmh?: number;
}

/** Throws a 400 ApiError on the first violated rule; returns void on success. */
export function validatePlausibility(input: HazardReportInput, env: Env): void {
  if (input.lat === 0 && input.lng === 0) {
    throw badRequest("Position (0, 0) is rejected as implausible (\"null island\")");
  }

  const acceptsSpeed = TYPES_ACCEPTING_SPEED_KMH.includes(input.type);
  if (input.speedKmh !== undefined) {
    if (!acceptsSpeed) {
      throw badRequest(`speedKmh is not applicable to hazard type "${input.type}"`);
    }
    if (input.speedKmh < env.SPEED_KMH_MIN || input.speedKmh > env.SPEED_KMH_MAX) {
      throw badRequest(`speedKmh must be between ${env.SPEED_KMH_MIN} and ${env.SPEED_KMH_MAX}`);
    }
  }
}
