import { loadWaysInBox } from "../../db/queries/roads.js";
import { haversineMeters, lineLengthMeters, projectOnSegment, type LatLng, type Position } from "../roads/geo.js";
import { boxOf } from "../roads/overpass.js";
import { ensureCoverage, resolveInterval, RoadResolveError, type ResolveDeps } from "../roads/resolve.js";
import type { Direction } from "./descriptor.js";

/**
 * Turns what a person picked on the map into the stretch of a context sign (docs/context-signs.md D1):
 *
 *  - two points -> the road between them, exactly as for a speed-limit interval (roads/resolve.ts), in the order picked, so
 *    "first point to second point" is the direction of travel the sign applies in;
 *  - one point (only for signs that stand at one place) -> a few metres of the road at that point, in the direction of travel
 *    given by the heading (or, for a sign that applies both ways, in the way's own direction).
 *
 * Either way the shape is the road's own shape, never the picked points: nothing off a road can become a sign.
 */

/** The length of the shape of a sign that stands at one place (metres). */
export const POINT_STRETCH_M = 8;

export interface ResolvedStretch {
  /** [lng, lat] vertices, in the direction of travel. */
  coordinates: [number, number][];
  lengthM: number;
  road: { name: string | null; ref: string | null; class: string | null };
}

function bearing(a: Position, b: Position): number {
  const φ1 = (a[1] * Math.PI) / 180;
  const φ2 = (b[1] * Math.PI) / 180;
  const dλ = ((b[0] - a[0]) * Math.PI) / 180;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** The two-point case: the road between the points, oriented from the first pick towards the second. */
export async function resolveTwoPoints(deps: ResolveDeps, first: LatLng, second: LatLng): Promise<ResolvedStretch> {
  const interval = await resolveInterval(deps, first, second);
  let coordinates = interval.coordinates;
  const toStart = haversineMeters([first.lng, first.lat], coordinates[0]!);
  const toEnd = haversineMeters([first.lng, first.lat], coordinates.at(-1)!);
  if (toEnd < toStart) coordinates = [...coordinates].reverse();
  return { coordinates, lengthM: Math.round(lineLengthMeters(coordinates)), road: { name: interval.roadName, ref: interval.roadRef, class: interval.roadClass } };
}

/** The one-point case: a short piece of the nearest road, in the direction `heading` (degrees) points to. */
export async function resolveOnePoint(deps: ResolveDeps, at: LatLng, direction: Direction, heading: number | null): Promise<ResolvedStretch> {
  const box = boxOf([[at.lng, at.lat]], 0.0035);
  await ensureCoverage(deps, box, [at]);
  const ways = await loadWaysInBox(deps.db, box);
  if (ways.length === 0) throw new RoadResolveError("NO_ROAD_DATA", "This node has no road data for that area and cannot look it up");

  const p: Position = [at.lng, at.lat];
  let best: { way: (typeof ways)[number]; index: number; t: number; distanceM: number } | null = null;
  for (const way of ways) {
    for (let i = 0; i + 1 < way.coordinates.length; i++) {
      const projection = projectOnSegment(p, way.coordinates[i]!, way.coordinates[i + 1]!);
      if (!best || projection.distanceM < best.distanceM) best = { way, index: i, t: projection.t, distanceM: projection.distanceM };
    }
  }
  if (!best || best.distanceM > deps.env.ROAD_PICK_TOLERANCE_M) {
    throw new RoadResolveError("NO_ROAD_FOUND", "No road was found near the point", { toleranceMeters: deps.env.ROAD_PICK_TOLERANCE_M });
  }

  const coords = best.way.coordinates.map((c) => [c[0], c[1]] as [number, number]);
  const a = coords[best.index]!;
  const b = coords[best.index + 1]!;
  const edgeBearing = bearing(a, b);
  const forward = heading === null || direction === "both" ? true : angleDiff(edgeBearing, heading) <= 90;

  // Walk POINT_STRETCH_M along the way from the projected point in the chosen orientation; if the way ends first, start earlier.
  const start: [number, number] = [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t];
  const walk = (orientation: boolean, from: [number, number], index: number): [number, number][] => {
    const out: [number, number][] = [from];
    let remaining = POINT_STRETCH_M;
    let current = from;
    let i = orientation ? index + 1 : index;
    while (remaining > 0 && i >= 0 && i < coords.length) {
      const next = coords[i]!;
      const d = haversineMeters(current, next);
      if (d >= remaining) {
        const f = remaining / d;
        out.push([current[0] + (next[0] - current[0]) * f, current[1] + (next[1] - current[1]) * f]);
        remaining = 0;
      } else {
        if (d > 0) out.push([next[0], next[1]]);
        remaining -= d;
        current = next;
        i += orientation ? 1 : -1;
      }
    }
    return out;
  };

  let shape = walk(forward, start, best.index);
  if (lineLengthMeters(shape) < POINT_STRETCH_M * 0.5) {
    // the way ends right here: take the stretch that ends at the point instead
    shape = walk(!forward, start, best.index).reverse();
  }
  const coordinates = shape.map(([lng, lat]) => [Math.round(lng * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7] as [number, number]);
  return {
    coordinates,
    lengthM: Math.round(lineLengthMeters(coordinates)),
    road: { name: best.way.name, ref: best.way.ref, class: best.way.highway },
  };
}

/**
 * Does the shape lie on roads this node knows? Checked for a proposal sent to this node's own API: its first, last and middle
 * vertex must each be within the pick tolerance of a known way. Without road data the proposal is refused (NO_ROAD_DATA).
 */
export async function shapeLiesOnRoad(deps: ResolveDeps, geometry: readonly [number, number][]): Promise<"ok" | "no_road_data" | "off_road"> {
  const samples = [geometry[0]!, geometry[Math.floor(geometry.length / 2)]!, geometry.at(-1)!];
  const box = boxOf(samples as [number, number][], 0.0035);
  const ways = await loadWaysInBox(deps.db, box);
  if (ways.length === 0) return "no_road_data";
  for (const sample of samples) {
    let nearest = Infinity;
    for (const way of ways) {
      for (let i = 0; i + 1 < way.coordinates.length; i++) {
        nearest = Math.min(nearest, projectOnSegment(sample, way.coordinates[i]!, way.coordinates[i + 1]!).distanceM);
      }
    }
    if (nearest > 5) return "off_road";
  }
  return "ok";
}
