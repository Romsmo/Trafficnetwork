import { CAMERA_NAMESPACE_TYPES, HAZARD_TYPES, NON_CAMERA_HAZARD_TYPES, type HazardType } from "../../config/constants.js";

export function isCameraType(type: HazardType): boolean {
  return (CAMERA_NAMESPACE_TYPES as readonly HazardType[]).includes(type);
}

/**
 * The allow-list for /v1/snapshot and /v1/delta, where "nothing requested" should
 * mean "everything the flag currently permits" — unlike /v1/hazard-reports/* and
 * /v1/speed-cameras/*, which each hard-restrict to their own fixed subset
 * regardless of the flag (see modules/hazard-reports/routes.ts's resolveTypes and
 * modules/cameras/routes.ts).
 *
 * Deliberately the full HAZARD_TYPES list when enabled, not REPORTABLE_HAZARD_TYPES
 * — this allow-list is matched against the event log's `payload->>'type'` (see
 * db/queries/event-log.ts's getDeltaPage), and fixedSpeedCamera events carry
 * `type: "fixedSpeedCamera"` in their payload (see FixedSpeedCameraApi) even
 * though that value never appears in the hazard_reports.type column itself.
 * Excluding it here would make it permanently unrequestable via delta even with
 * the flag on.
 */
export function resolveSyncHazardTypes(requested: HazardType[] | undefined, cameraNamespaceEnabled: boolean): HazardType[] {
  const allowed = cameraNamespaceEnabled ? HAZARD_TYPES : NON_CAMERA_HAZARD_TYPES;
  if (!requested) return [...allowed];
  const filtered = requested.filter((t) => (allowed as readonly HazardType[]).includes(t));
  return filtered.length > 0 ? filtered : [...allowed];
}
