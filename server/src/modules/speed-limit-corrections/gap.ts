import { createHash } from "node:crypto";
import { cellToLatLng, getResolution, isValidCell, latLngToCell } from "h3-js";

/**
 * "This road has no speed limit on record" (docs/speed-limit-corrections.md D13).
 *
 * The import only holds roads that carry a limit, so a road without one has no geometry to vote on. A proposal therefore
 * names a *place and a direction* and the server derives a short, fixed stretch of road from it:
 *
 *   cell  = the H3 cell (resolution 10, edge ~ 66 m) of the reported position,
 *   axis  = the road's direction as one of 8 buckets of 22.5 degrees (an axis, not a heading: 90 degrees = east-west),
 *   line  = GAP_LENGTH_M long, centred on the cell centre, along the axis.
 *
 * Everything is a pure function of (cell, axis), so every node derives the same geometry and the same key, and two devices
 * that report the same road within the same cell and direction bucket are the same proposal. A proposal can never colour
 * more than one such stretch: that is the answer to "a point must not colour a long road".
 */
export const GAP_CELL_RESOLUTION = 10;
export const GAP_AXES = 8;
export const GAP_LENGTH_M = 120;

/** What a device signs to name a gap: `gap:<h3 cell, 15 hex chars>:<axis 0..7>`. A device can compute it; it cannot compute the geometry key. */
export const GAP_REF_PATTERN = /^gap:[0-9a-f]{15}:[0-7]$/;

const METERS_PER_DEGREE_LAT = 111_320;

export interface GapPlace {
  cell: string;
  axis: number;
}

/** 0..360 (any heading, either direction of the road) -> axis bucket 0..7. 0 = north-south, 4 = east-west. */
export function axisBucket(bearingDegrees: number): number {
  const axisDegrees = ((bearingDegrees % 180) + 180) % 180;
  return Math.round(axisDegrees / (180 / GAP_AXES)) % GAP_AXES;
}

export function gapRef(place: GapPlace): string {
  return `gap:${place.cell}:${place.axis}`;
}

/** The place a reference names, or null if it is not a well-formed reference to a resolution-10 cell. */
export function parseGapRef(ref: string): GapPlace | null {
  if (!GAP_REF_PATTERN.test(ref)) return null;
  const [, cell, axis] = ref.split(":");
  if (!cell || axis === undefined || !isValidCell(cell) || getResolution(cell) !== GAP_CELL_RESOLUTION) return null;
  return { cell, axis: Number(axis) };
}

export function placeOf(lat: number, lng: number, bearingDegrees: number): GapPlace {
  return { cell: latLngToCell(lat, lng, GAP_CELL_RESOLUTION), axis: axisBucket(bearingDegrees) };
}

const round7 = (degrees: number) => Math.round(degrees * 1e7) / 1e7;

/** [lng, lat] of the two end points. Rounded to 1e-7 degrees, the precision geometry keys are computed at. */
export function gapCoordinates(place: GapPlace): [[number, number], [number, number]] {
  const [lat, lng] = cellToLatLng(place.cell);
  const azimuth = (place.axis * (180 / GAP_AXES) * Math.PI) / 180;
  const half = GAP_LENGTH_M / 2;
  const dLat = (Math.cos(azimuth) * half) / METERS_PER_DEGREE_LAT;
  const dLng = (Math.sin(azimuth) * half) / (METERS_PER_DEGREE_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 0.05));
  return [
    [round7(lng - dLng), round7(lat - dLat)],
    [round7(lng + dLng), round7(lat + dLat)],
  ];
}

/**
 * The key of a geometry exactly as speed_limit_geometry_key() computes it in the database (migration 0007, docs/schema.md):
 * vertices as integer 1e-7 degrees, joined, the smaller of forward and reversed (C collation = plain code-unit order),
 * sha256, first 32 hex characters.
 */
export function geometryKeyOf(coordinates: readonly (readonly [number, number])[]): string {
  const points = coordinates.map(([lng, lat]) => `${Math.round(lng * 1e7)},${Math.round(lat * 1e7)}`);
  const forward = points.join(";");
  const reverse = [...points].reverse().join(";");
  return createHash("sha256").update(forward < reverse ? forward : reverse).digest("hex").slice(0, 32);
}

export interface GapGeometry extends GapPlace {
  ref: string;
  segmentKey: string;
  coordinates: [[number, number], [number, number]];
}

export function gapGeometry(place: GapPlace): GapGeometry {
  const coordinates = gapCoordinates(place);
  return { ...place, ref: gapRef(place), coordinates, segmentKey: geometryKeyOf(coordinates) };
}

export function gapGeoJson(g: Pick<GapGeometry, "coordinates">): { type: "LineString"; coordinates: [number, number][] } {
  return { type: "LineString", coordinates: [...g.coordinates] };
}
