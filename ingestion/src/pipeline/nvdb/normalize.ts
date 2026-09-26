import type { NormalizedRow } from "../worker.js";
import { mapSignCode, type SignMapping } from "./mapping.js";

/**
 * NVDB Norway (Statens vegvesen, "NVDB API Les V4"), object type 96 "Skiltplate" (one sign plate). Written against live
 * responses fetched 2026-09-26; the shapes below are what the real API returned.
 *
 *  - Position: `geometri.wkt`, requested with `srid=4326`. The API writes WGS 84 in **latitude, longitude** order
 *    (`POINT(59.98008659 10.92784282)`, or `POINT Z (lat lon height)` with a height of -999999 when unknown) — the reverse of
 *    GeoJSON. Nothing is converted; the axis order is read as documented and then sanity-checked against Norway's extent, where
 *    latitudes (57–82) and longitudes (3–35) cannot be mistaken for each other, so a future change of order is caught, not imported.
 *  - Code: property 5530 "Skiltnummer" is a text enum. The object carries the enum's `verdi` ("362.50 - Fartsgrense 50 km/t") and
 *    its `enum_id`. The code is the first word of `verdi`. The enum's own `kortnavn` is NOT used: for two entries it is truncated
 *    ("711.V13" for "711.V135").
 */

export const SKILTNUMMER_PROPERTY_ID = 5530;
export const SIGN_PLATE_TYPE_ID = 96;

export interface NvdbProperty {
  id?: number;
  navn?: string;
  verdi?: unknown;
  enum_id?: number;
}

export interface NvdbObject {
  id?: number;
  geometri?: { wkt?: unknown; srid?: unknown };
  egenskaper?: NvdbProperty[];
}

const POINT_WKT = /^POINT(?:\s+Z)?\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+-?\d+(?:\.\d+)?)?\s*\)$/i;

// Norway including Svalbard and Jan Mayen. Latitude and longitude ranges do not overlap, which is what makes the check meaningful.
const LAT_RANGE: [number, number] = [57, 82];
const LNG_RANGE: [number, number] = [3, 35];

/** `verdi` of a Skiltnummer entry → its code: "362.50 - Fartsgrense 50 km/t" → "362.50"; "U999 -" → "U999". */
export function codeOfVerdi(verdi: string): string | undefined {
  const code = /^(\S+)/.exec(verdi.trim())?.[1];
  return code && code !== "-" ? code : undefined;
}

export type PointResult = { lat: number; lng: number } | { problem: string };

export function parseNvdbPoint(wkt: unknown): PointResult {
  if (typeof wkt !== "string") return { problem: "no geometry" };
  const match = POINT_WKT.exec(wkt.trim());
  if (!match) return { problem: "geometry is not a POINT" };
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (lat < LAT_RANGE[0] || lat > LAT_RANGE[1] || lng < LNG_RANGE[0] || lng > LNG_RANGE[1]) return { problem: "coordinates outside the plausible range for Norway (axis order changed?)" };
  return { lat, lng };
}

export interface NormalizeContext {
  mapping: SignMapping;
  /** enum id of property 5530 → code, from the object type definition (the `verdi` of the object is the fallback). */
  enumCodes: Map<number, string>;
}

export type NormalizeResult = { row: NormalizedRow; passedThrough: boolean } | { skip: string };

export function normalizeNvdbSign(object: NvdbObject, context: NormalizeContext): NormalizeResult {
  if (typeof object.id !== "number" || !Number.isSafeInteger(object.id)) return { skip: "object without a numeric id" };

  const property = object.egenskaper?.find((p) => p.id === SKILTNUMMER_PROPERTY_ID);
  const code = (typeof property?.enum_id === "number" ? context.enumCodes.get(property.enum_id) : undefined) ?? (typeof property?.verdi === "string" ? codeOfVerdi(property.verdi) : undefined);
  if (!code) return { skip: "no Skiltnummer" };

  const mapped = mapSignCode(code, context.mapping);
  if ("skip" in mapped) return { skip: mapped.skip };

  const point = parseNvdbPoint(object.geometri?.wkt);
  if ("problem" in point) return { skip: point.problem };

  return {
    passedThrough: mapped.passedThrough,
    row: {
      kind: "static-sign",
      key: `static-sign:${context.mapping.source}/${SIGN_PLATE_TYPE_ID}/${object.id}`,
      row: { lat: point.lat, lng: point.lng, signType: mapped.signType, source: context.mapping.source, sourceLicense: context.mapping.sourceLicense },
    },
  };
}
