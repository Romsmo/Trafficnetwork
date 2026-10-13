import { cellToBoundary, gridDisk, latLngToCell, polygonToCells } from "h3-js";
import type { Queryable } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { coveredTiles, loadWaysInBox, markCovered, upsertRoadWays } from "../../db/queries/roads.js";
import { geometryKeyOf } from "../speed-limit-corrections/gap.js";
import { haversineMeters, intervalRef, parseIntervalRef, type LatLng } from "./geo.js";
import { boxOf, fetchRoads, type BoundingBox, type Fetcher } from "./overpass.js";
import { findPath, MIN_INTERVAL_M, type PathFailure } from "./pathfinder.js";

/**
 * Which road a stretch is on (docs/road-network.md, "An interval along a road"): two picked points in, the stretch of the
 * road's own shape between them out - found among the ways this node has, after making sure the area has been looked up.
 */
export const COVERAGE_RESOLUTION = 8;
const COVERAGE_MAX_AGE_DAYS = 120;
/** A lookup box is never larger than this (km2): a longer ask is split by the cap on the interval's length anyway. */
const MAX_LOOKUP_BOX_KM2 = 60;

export type ResolveErrorCode = "NO_ROAD_DATA" | "NO_ROAD_FOUND" | "NO_ROAD_BETWEEN_POINTS" | "INTERVAL_TOO_LONG" | "INTERVAL_TOO_SHORT";

export class RoadResolveError extends Error {
  readonly code: ResolveErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ResolveErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface ResolveDeps {
  db: Queryable;
  env: Pick<Env, "ROAD_LOOKUP_URL" | "ROAD_LOOKUP_TIMEOUT_MS" | "ROAD_PICK_TOLERANCE_M" | "ROAD_INTERVAL_MAX_M" | "PROJECT_REPO_URL">;
  /** Replaced by tests; the real `fetch` otherwise. */
  fetcher?: Fetcher;
  /** What to log when a lookup fails (the resolution goes on with the ways it has). */
  warn?: (message: string, detail?: unknown) => void;
  userAgentVersion?: string;
}

export interface ResolvedInterval {
  ref: string;
  segmentKey: string;
  /** [lng, lat] vertices at 1e-7 degrees: the first and the last are the picked points on the road. */
  coordinates: [number, number][];
  lengthM: number;
  roadName: string | null;
  roadRef: string | null;
  roadClass: string | null;
  wayIds: string[];
  from: LatLng;
  to: LatLng;
}

const round7 = (n: number) => Math.round(n * 1e7) / 1e7;

// One lookup at a time: a public service is asked politely, and two visitors picking in the same area share the answer.
let lookupQueue: Promise<unknown> = Promise.resolve();

function boxAreaKm2(box: BoundingBox): number {
  const midLat = (box.north + box.south) / 2;
  const h = (box.north - box.south) * 111.32;
  const w = (box.east - box.west) * 111.32 * Math.cos((midLat * Math.PI) / 180);
  return Math.abs(h * w);
}

/** The coverage cells a resolution needs: the cells over the box and around both points. */
export function coverageCells(box: BoundingBox, points: readonly LatLng[]): string[] {
  const cells = new Set<string>();
  const ring: [number, number][] = [
    [box.south, box.west],
    [box.south, box.east],
    [box.north, box.east],
    [box.north, box.west],
  ];
  if (boxAreaKm2(box) <= MAX_LOOKUP_BOX_KM2) {
    for (const c of polygonToCells(ring, COVERAGE_RESOLUTION)) cells.add(c);
  }
  for (const p of points) for (const c of gridDisk(latLngToCell(p.lat, p.lng, COVERAGE_RESOLUTION), 1)) cells.add(c);
  return [...cells];
}

/**
 * Makes sure the roads around `points` are in the database: asks the lookup service for the areas not covered yet (one request
 * for all of them) and stores the answer. Never throws - a service that is down or off just means resolution uses what exists.
 */
export async function ensureCoverage(deps: ResolveDeps, box: BoundingBox, points: readonly LatLng[]): Promise<{ asked: boolean; failed: boolean }> {
  const url = deps.env.ROAD_LOOKUP_URL;
  if (url === "") return { asked: false, failed: false };
  const cells = coverageCells(box, points);
  const have = await coveredTiles(deps.db, cells, COVERAGE_MAX_AGE_DAYS);
  const missing = cells.filter((c) => !have.has(c));
  if (missing.length === 0) return { asked: false, failed: false };

  const corners: [number, number][] = [];
  for (const cell of missing) for (const [lat, lng] of cellToBoundary(cell)) corners.push([lng, lat]);
  let askBox = boxOf(corners);
  if (boxAreaKm2(askBox) > MAX_LOOKUP_BOX_KM2) askBox = boxOf(points.map((p) => [p.lng, p.lat] as [number, number]), 0.006);

  const run = async (): Promise<{ asked: boolean; failed: boolean }> => {
    try {
      const ways = await fetchRoads(url, askBox, {
        timeoutMs: deps.env.ROAD_LOOKUP_TIMEOUT_MS,
        userAgent: `trafficnetwork-node/${deps.userAgentVersion ?? "1"} (+${deps.env.PROJECT_REPO_URL})`,
        ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
      });
      await upsertRoadWays(deps.db, "osm", ways);
      // only cells whose whole outline lies inside what was asked for are complete now
      const complete = missing.filter((cell) =>
        cellToBoundary(cell).every(([lat, lng]) => lat >= askBox.south && lat <= askBox.north && lng >= askBox.west && lng <= askBox.east),
      );
      await markCovered(deps.db, complete, "lookup");
      return { asked: true, failed: false };
    } catch (error) {
      deps.warn?.("road lookup failed", error instanceof Error ? error.message : error);
      return { asked: true, failed: true };
    }
  };
  const result = lookupQueue.then(run, run);
  lookupQueue = result.catch(() => undefined);
  return result;
}

const FAILURE_TO_CODE: Record<PathFailure, ResolveErrorCode> = {
  no_road: "NO_ROAD_FOUND",
  no_road_between: "NO_ROAD_BETWEEN_POINTS",
  too_long: "INTERVAL_TOO_LONG",
  too_short: "INTERVAL_TOO_SHORT",
};

const MESSAGES: Record<ResolveErrorCode, string> = {
  NO_ROAD_DATA: "This node has no road data for that area and cannot look it up",
  NO_ROAD_FOUND: "No road was found near one of the two points",
  NO_ROAD_BETWEEN_POINTS: "The two points are not on one road that runs between them",
  INTERVAL_TOO_LONG: "The two points are too far apart for one stretch",
  INTERVAL_TOO_SHORT: "The two points are too close together for a stretch",
};

/** The stretch of road between two picked points, or a RoadResolveError that says why there is none. */
export async function resolveInterval(deps: ResolveDeps, a: LatLng, b: LatLng): Promise<ResolvedInterval> {
  const straight = haversineMeters([a.lng, a.lat], [b.lng, b.lat]);
  if (straight < MIN_INTERVAL_M) throw new RoadResolveError("INTERVAL_TOO_SHORT", MESSAGES.INTERVAL_TOO_SHORT, { minMeters: MIN_INTERVAL_M });
  if (straight > deps.env.ROAD_INTERVAL_MAX_M) {
    throw new RoadResolveError("INTERVAL_TOO_LONG", MESSAGES.INTERVAL_TOO_LONG, { maxMeters: deps.env.ROAD_INTERVAL_MAX_M });
  }
  // the order of the two points is not part of the identity of a stretch
  const ref = intervalRef(a, b);
  const named = parseIntervalRef(ref)!;
  const margin = 0.0045; // ~500 m
  const box = boxOf(
    [
      [named.from.lng, named.from.lat],
      [named.to.lng, named.to.lat],
    ],
    margin,
  );
  await ensureCoverage(deps, box, [named.from, named.to]);
  const ways = await loadWaysInBox(deps.db, box);
  if (ways.length === 0) throw new RoadResolveError("NO_ROAD_DATA", MESSAGES.NO_ROAD_DATA);

  const found = findPath(ways, named.from, named.to, {
    toleranceM: deps.env.ROAD_PICK_TOLERANCE_M,
    maxLengthM: deps.env.ROAD_INTERVAL_MAX_M,
  });
  if (!found.ok) {
    const code = FAILURE_TO_CODE[found.failure];
    throw new RoadResolveError(code, MESSAGES[code], { toleranceMeters: deps.env.ROAD_PICK_TOLERANCE_M });
  }
  const p = found.path;
  const coordinates = p.coordinates.map(([lng, lat]) => [round7(lng), round7(lat)] as [number, number]);
  return {
    ref,
    segmentKey: geometryKeyOf(coordinates),
    coordinates,
    lengthM: Math.round(p.lengthM),
    roadName: p.name,
    roadRef: p.ref,
    roadClass: p.highway,
    wayIds: p.wayIds,
    from: named.from,
    to: named.to,
  };
}

export async function resolveIntervalRef(deps: ResolveDeps, ref: string): Promise<ResolvedInterval> {
  const places = parseIntervalRef(ref);
  if (!places) throw new RoadResolveError("NO_ROAD_FOUND", "Not a valid interval reference");
  return resolveInterval(deps, places.from, places.to);
}
