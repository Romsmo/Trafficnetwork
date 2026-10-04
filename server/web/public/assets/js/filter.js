import { normalizeTimestamp } from "./format.js";

/** Report categories. The camera categories exist in the UI only when this node delivers camera data at all. */
export const GENERAL_TYPES = ["traffic", "accident", "ice", "construction", "breakdown", "obstacle"];
export const CAMERA_TYPES = ["fixedSpeedCamera", "mobileSpeedCamera", "trailerCamera", "redLightCamera", "distanceControl"];

/** Types the visitor may filter by and report — camera types are completely absent unless the node delivers them. */
export function selectableTypes(cameraAvailable) {
  return cameraAvailable ? [...GENERAL_TYPES, ...CAMERA_TYPES] : [...GENERAL_TYPES];
}

export function isCameraType(type) {
  return CAMERA_TYPES.includes(type);
}

/** The first-visit selection: the general categories are on; the camera categories exist but are off until the visitor ticks them. */
export function defaultEnabled(type) {
  return GENERAL_TYPES.includes(type);
}

export function anyCameraEnabled(enabledTypes) {
  return CAMERA_TYPES.some((type) => enabledTypes.has(type));
}

/** Reports whose type is enabled in the filter and that this UI is allowed to know about at all. */
export function filterReports(reports, enabledTypes, cameraAvailable) {
  return reports.filter((report) => {
    if (isCameraType(report.type) && !cameraAvailable) return false;
    return enabledTypes.has(report.type);
  });
}

/** The camera kinds of a zone that the filter has switched on. */
export function zoneTypes(zone, enabledTypes) {
  return (zone.cameraTypes ?? []).filter((type) => enabledTypes.has(type));
}

/** Zones are shown while at least one of their camera kinds is switched on (and the node delivers camera data). */
export function filterZones(zones, enabledTypes, cameraAvailable) {
  if (!cameraAvailable) return [];
  return zones.filter((zone) => zoneTypes(zone, enabledTypes).length > 0);
}

/** The outline of a zone as Leaflet wants it ([lat, lng], without the GeoJSON ring's closing repeat), or null if the zone has none. */
export function zoneLatLngs(zone) {
  const ring = zone?.boundary?.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const points = ring.map(([lng, lat]) => [lat, lng]);
  const [first, last] = [points[0], points[points.length - 1]];
  if (first[0] === last[0] && first[1] === last[1]) points.pop();
  return points;
}

/** Reports sorted newest first, for the accessible list. */
export function sortNewestFirst(reports) {
  const time = (report) => Date.parse(normalizeTimestamp(report.reportedAt)) || 0;
  return [...reports].sort((a, b) => time(b) - time(a));
}
