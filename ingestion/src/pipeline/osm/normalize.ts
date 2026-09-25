import type { Logger } from "../../logging.js";
import type { NormalizedRow } from "../worker.js";
import { IMPLICIT_MAXSPEED, MPH_COUNTRIES } from "./implicit-speeds.generated.js";

export interface OsmFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}

const SOURCE = "osm";
const SOURCE_LICENSE = "ODbL";

interface ResolvedSpeed {
  value: number;
  unit: "kmh" | "mph";
}

/**
 * Implicit speed limits (`maxspeed:type`, fallback `source:maxspeed`), e.g. `DE:urban`.
 * Policy (docs/europe-feasibility.md §6): resolve only what is evidenced and unambiguous, skip and
 * count everything else — never invent a number.
 *  - `CC:urban` / `CC:rural`: the generated table (implicit-speeds.generated.ts, from the OSM wiki's
 *    "Default speed limits"), which already omits countries where a sub-type would make one number wrong
 *    (FR:rural, ES:urban, …).
 *  - `CC:zoneNN`: the number is part of the tag itself (a signed "NN zone"); read as km/h, never in mph
 *    countries, and only for plausible zone values.
 *  - `motorway`, `living_street`, `nsl_*` and anything else: unresolved.
 */
const ZONE_PATTERN = /^([A-Z]{2}(?:-[A-Z0-9]{1,3})?):zone(\d{1,3})$/;

function resolveImplicit(implicitType: string): ResolvedSpeed | undefined {
  const tabled = IMPLICIT_MAXSPEED[implicitType];
  if (tabled) return tabled;
  const zone = ZONE_PATTERN.exec(implicitType);
  if (zone && !MPH_COUNTRIES.has(zone[1]!)) {
    const value = Number(zone[2]);
    if (value >= 5 && value <= 60 && value % 5 === 0) return { value, unit: "kmh" };
  }
  return undefined;
}

/** Returns the resolved speed, or a skip reason (never invents a number). */
function resolveMaxspeed(tags: Record<string, unknown>): ResolvedSpeed | { skip: string } {
  const explicit = typeof tags.maxspeed === "string" ? tags.maxspeed.trim() : undefined;
  if (explicit !== undefined) {
    const mphMatch = explicit.match(/^(\d+(?:\.\d+)?)\s*mph$/i);
    const kmhMatch = explicit.match(/^(\d+(?:\.\d+)?)$/);
    const numeric = mphMatch ? Number(mphMatch[1]) : kmhMatch ? Number(kmhMatch[1]) : undefined;
    // The server's bulk-import schema requires speedLimit > 0 and rejects the whole batch otherwise;
    // real OSM data has a stray "maxspeed=0" (e.g. way 1526008141 in the Bayern extract).
    if (numeric !== undefined && numeric <= 0) return { skip: `non-positive maxspeed value "${explicit}"` };
    if (mphMatch) return { value: Number(mphMatch[1]), unit: "mph" };
    if (kmhMatch) return { value: Number(kmhMatch[1]), unit: "kmh" };
    // Primary source is present but non-numeric (e.g. "signals", "variable", "none", "walk") — per
    // OSM's own guidance maxspeed is the authoritative numeric source, so a non-numeric value here
    // means "no fixed numeric limit", not "go look elsewhere". Skip rather than guess.
    return { skip: `non-numeric maxspeed value "${explicit}"` };
  }

  const implicitType = typeof tags["maxspeed:type"] === "string" ? tags["maxspeed:type"] : typeof tags["source:maxspeed"] === "string" ? tags["source:maxspeed"] : undefined;
  if (implicitType === undefined) return { skip: "no maxspeed or maxspeed:type/source:maxspeed tag" };

  const implicit = resolveImplicit(implicitType);
  if (implicit === undefined) return { skip: `unresolved implicit maxspeed:type "${implicitType}" (no unambiguous evidenced value — see docs/europe-feasibility.md §6)` };
  return implicit;
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
