import type { Logger } from "../../logging.js";
import type { NormalizedRow } from "../worker.js";

export interface OsmFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}

const SOURCE = "osm";
const SOURCE_LICENSE = "ODbL";

/**
 * Documented OSM implicit-speed-limit defaults for `maxspeed:type` (fallback:
 * `source:maxspeed`) — see ingestion/docs/sources.md for the wiki citations.
 * `DE:motorway` (no blanket numeric limit) and `DE:living_street` (wiki
 * documents only the non-numeric "walk") are deliberately absent: skipped,
 * never given an invented number. Any value not in this table (including
 * non-German ones, e.g. a border-adjacent "AT:urban") is likewise skipped —
 * only what's actually evidenced gets resolved.
 */
const IMPLICIT_MAXSPEED_KMH: Record<string, number> = {
  "DE:urban": 50,
  "DE:rural": 100,
  "DE:zone30": 30,
  "DE:zone20": 20,
};

interface ResolvedSpeed {
  value: number;
  unit: "kmh" | "mph";
}

/** Returns the resolved speed, or a skip reason (never invents a number). */
function resolveMaxspeed(tags: Record<string, unknown>): ResolvedSpeed | { skip: string } {
  const explicit = typeof tags.maxspeed === "string" ? tags.maxspeed.trim() : undefined;
  if (explicit !== undefined) {
    const mphMatch = explicit.match(/^(\d+(?:\.\d+)?)\s*mph$/i);
    if (mphMatch) return { value: Number(mphMatch[1]), unit: "mph" };
    const kmhMatch = explicit.match(/^(\d+(?:\.\d+)?)$/);
    if (kmhMatch) return { value: Number(kmhMatch[1]), unit: "kmh" };
    // Primary source is present but non-numeric (e.g. "signals", "variable", "none", "walk") — per
    // OSM's own guidance maxspeed is the authoritative numeric source, so a non-numeric value here
    // means "no fixed numeric limit", not "go look elsewhere". Skip rather than guess.
    return { skip: `non-numeric maxspeed value "${explicit}"` };
  }

  const implicitType = typeof tags["maxspeed:type"] === "string" ? tags["maxspeed:type"] : typeof tags["source:maxspeed"] === "string" ? tags["source:maxspeed"] : undefined;
  if (implicitType === undefined) return { skip: "no maxspeed or maxspeed:type/source:maxspeed tag" };

  const implicitKmh = IMPLICIT_MAXSPEED_KMH[implicitType];
  if (implicitKmh === undefined) return { skip: `unresolved implicit maxspeed:type "${implicitType}" (not in the evidenced DE:* table — see docs/sources.md)` };
  return { value: implicitKmh, unit: "kmh" };
}

function pointToLatLng(coordinates: unknown): { lat: number; lng: number } | undefined {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return undefined;
  const [lng, lat] = coordinates as [number, number];
  if (typeof lng !== "number" || typeof lat !== "number") return undefined;
  return { lat, lng };
}

/**
 * Normalizes one osmium-exported GeoJSON Feature into zero or more rows.
 * A single OSM way can independently yield a speed-limit-segment (if
 * `maxspeed` resolves) AND one or more static-sign rows (if `traffic_sign`
 * is present) — these are checked separately, not mutually exclusive.
 */
export function normalizeFeature(feature: OsmFeature, logger: Logger): NormalizedRow[] {
  const tags = feature.properties;
  const osmType = tags["@type"];
  const osmId = tags["@id"];
  if (typeof osmType !== "string" || (osmType !== "node" && osmType !== "way" && osmType !== "relation") || (typeof osmId !== "number" && typeof osmId !== "string")) {
    logger.warn({ properties: tags }, "skipping feature with missing/unexpected @type or @id (osmium export -a type,id misconfigured?)");
    return [];
  }

  const rows: NormalizedRow[] = [];

  // --- speed-limit-segment: ways only, needs a LineString geometry and a resolvable maxspeed ---
  if (osmType === "way" && feature.geometry.type === "LineString" && typeof tags.highway === "string") {
    const coordinates = feature.geometry.coordinates;
    const resolved = resolveMaxspeed(tags);
    if ("skip" in resolved) {
      logger.debug({ osmType, osmId, reason: resolved.skip }, "skipped speed-limit-segment");
    } else if (!Array.isArray(coordinates) || coordinates.length < 2) {
      logger.warn({ osmType, osmId }, "way has highway tag but LineString has <2 coordinates — skipping segment");
    } else {
      // GeoJSON/osmium already emits [lng, lat] pairs, and the bulk-import API's
      // lineString field wants exactly that order — no swap here (see api/types.ts).
      rows.push({
        kind: "speed-limit-segment",
        key: `speed-limit-segment:${osmType}/${osmId}`,
        row: {
          lineString: coordinates as [number, number][],
          speedLimit: resolved.value,
          speedLimitUnit: resolved.unit,
          source: SOURCE,
          sourceLicense: SOURCE_LICENSE,
        },
      });
    }
  }

  // --- static-sign: nodes or ways tagged traffic_sign ---
  if (typeof tags.traffic_sign === "string") {
    // A way-level traffic_sign (mapper didn't place a separate sign node) has no
    // single point — use the way's first vertex as a representative position.
    // A node's own Point is used directly. Comma joins *separate* signs on the
    // same post (Key:traffic_sign wiki) — never split further within one segment.
    let position: { lat: number; lng: number } | undefined;
    if (osmType === "node" && feature.geometry.type === "Point") {
      position = pointToLatLng(feature.geometry.coordinates);
    } else if (osmType === "way" && feature.geometry.type === "LineString" && Array.isArray(feature.geometry.coordinates) && feature.geometry.coordinates.length > 0) {
      position = pointToLatLng((feature.geometry.coordinates as unknown[])[0]);
    }

    if (!position) {
      logger.warn({ osmType, osmId }, "traffic_sign tag present but no usable position — skipping sign(s)");
    } else {
      const signTypes = tags.traffic_sign
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      signTypes.forEach((signType, index) => {
        rows.push({
          kind: "static-sign",
          key: `static-sign:${osmType}/${osmId}${signTypes.length > 1 ? `#${index}` : ""}`,
          row: { lat: position.lat, lng: position.lng, signType, source: SOURCE, sourceLicense: SOURCE_LICENSE },
        });
      });
    }
  }

  // --- fixed-speed-camera: nodes tagged highway=speed_camera ---
  if (osmType === "node" && tags.highway === "speed_camera" && feature.geometry.type === "Point") {
    const position = pointToLatLng(feature.geometry.coordinates);
    if (!position) {
      logger.warn({ osmType, osmId }, "speed_camera node has unusable geometry — skipping");
    } else {
      rows.push({
        kind: "fixed-speed-camera",
        key: `fixed-speed-camera:${osmType}/${osmId}`,
        row: { lat: position.lat, lng: position.lng, source: SOURCE, sourceLicense: SOURCE_LICENSE },
      });
    }
  }

  return rows;
}
