import { gapRef, type GapGeometry } from "./gap.js";
import type { ResolvedInterval } from "../roads/resolve.js";

/**
 * A stretch of road the community proposes a speed limit for (docs/road-network.md). Two origins, one shape:
 *
 *  - an *interval*: two points a visitor picked on a road, resolved to that road's own shape between them (reference `ivl:...`),
 *  - a legacy *place* (docs/speed-limit-corrections.md D13 as first released): a synthetic 120 m line through a position along a
 *    direction bucket (reference `gap:...`). Existing rows and votes keep working; nothing creates new ones.
 *
 * Whatever its origin, `segmentKey` is the content key of `coordinates`, which is what every vote and the community segment
 * written when a value is applied are keyed by.
 */
export interface CommunityStretch {
  segmentKey: string;
  ref: string;
  coordinates: [number, number][];
  lengthM: number | null;
  roadName: string | null;
  roadRef: string | null;
  roadClass: string | null;
  /** Legacy places only. */
  cell: string | null;
  axis: number | null;
}

export function stretchOfInterval(r: ResolvedInterval): CommunityStretch {
  return {
    segmentKey: r.segmentKey,
    ref: r.ref,
    coordinates: r.coordinates,
    lengthM: r.lengthM,
    roadName: r.roadName,
    roadRef: r.roadRef,
    roadClass: r.roadClass,
    cell: null,
    axis: null,
  };
}

export function stretchOfGap(g: GapGeometry): CommunityStretch {
  return {
    segmentKey: g.segmentKey,
    ref: gapRef(g),
    coordinates: [...g.coordinates],
    lengthM: null,
    roadName: null,
    roadRef: null,
    roadClass: null,
    cell: g.cell,
    axis: g.axis,
  };
}

export function stretchGeoJson(s: Pick<CommunityStretch, "coordinates">): { type: "LineString"; coordinates: [number, number][] } {
  return { type: "LineString", coordinates: s.coordinates.map(([lng, lat]) => [lng, lat] as [number, number]) };
}
