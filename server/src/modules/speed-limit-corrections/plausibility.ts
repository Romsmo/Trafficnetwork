import type { Env } from "../../config/env.js";
import type { SpeedLimitUnit } from "../../config/constants.js";
import { unprocessable } from "../../lib/errors.js";

export interface CorrectionBounds {
  min: number;
  max: number;
  step: number;
}

export function correctionBounds(env: Env, unit: SpeedLimitUnit): CorrectionBounds {
  return unit === "kmh"
    ? { min: env.COMMUNITY_CORRECTIONS_KMH_MIN, max: env.COMMUNITY_CORRECTIONS_KMH_MAX, step: env.COMMUNITY_CORRECTIONS_VALUE_STEP }
    : { min: env.COMMUNITY_CORRECTIONS_MPH_MIN, max: env.COMMUNITY_CORRECTIONS_MPH_MAX, step: env.COMMUNITY_CORRECTIONS_VALUE_STEP };
}

/**
 * The value-only plausibility rules that need no database (docs D6): range and
 * step in the given unit. Throws a 422 with a machine-readable `code` so a
 * client can tell the user *why* it was rejected.
 */
export function validateCorrectionValue(value: number, unit: SpeedLimitUnit, env: Env): void {
  const bounds = correctionBounds(env, unit);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw unprocessable(
      "CORRECTION_VALUE_OUT_OF_RANGE",
      `A speed limit in ${unit === "kmh" ? "km/h" : "mph"} must be a whole number between ${bounds.min} and ${bounds.max}`,
      { unit, ...bounds },
    );
  }
  if (value % bounds.step !== 0) {
    throw unprocessable("CORRECTION_VALUE_NOT_ON_STEP", `A speed limit must be a multiple of ${bounds.step}`, { unit, ...bounds });
  }
}
