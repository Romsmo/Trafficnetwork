import { normalizeTimestamp } from "./format.js";

/** Report categories. The camera categories exist in the UI only when this node's effective flag allows them. */
export const GENERAL_TYPES = ["traffic", "accident", "ice", "construction", "breakdown", "obstacle"];
export const CAMERA_TYPES = ["fixedSpeedCamera", "mobileSpeedCamera", "trailerCamera", "redLightCamera", "distanceControl"];

/** Types the visitor may filter by and report — camera types are completely absent unless enabled. */
export function selectableTypes(cameraNamespaceEnabled) {
  return cameraNamespaceEnabled ? [...GENERAL_TYPES, ...CAMERA_TYPES] : [...GENERAL_TYPES];
}

export function isCameraType(type) {
  return CAMERA_TYPES.includes(type);
}

/** Reports whose type is enabled in the filter and that this UI is allowed to know about at all. */
export function filterReports(reports, enabledTypes, cameraNamespaceEnabled) {
  return reports.filter((report) => {
    if (isCameraType(report.type) && !cameraNamespaceEnabled) return false;
    return enabledTypes.has(report.type);
  });
}

/** Reports sorted newest first, for the accessible list. */
export function sortNewestFirst(reports) {
  const time = (report) => Date.parse(normalizeTimestamp(report.reportedAt)) || 0;
  return [...reports].sort((a, b) => time(b) - time(a));
}
