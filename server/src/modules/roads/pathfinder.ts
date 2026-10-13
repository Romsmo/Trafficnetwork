import { haversineMeters, lineLengthMeters, projectOnSegment, type Position } from "./geo.js";

/**
 * Finds the stretch of road two picked points name (docs/road-network.md, "An interval along a road").
 *
 * The inputs are candidate ways - pieces of the road network as the database or a lookup provider has them - and the two points.
 * The answer is the line from the first point's projection onto the road to the second point's projection, following the road
 * through the vertices in between, even across several ways (a road is split into ways at every junction and wherever its
 * tags change). Pure and deterministic: the same ways and points give the same line on every node.
 *
 * The road is "the one nearest to the points and running between them": for each of the nearest few edges at either point the
 * shortest way along the network is tried, and the pair with the smallest picking error (plus a small length term) wins.
 * Ways with the same name or reference as the start are preferred over a shortcut through other roads.
 */
export interface RoadWay {
  /** Id of the road piece in its store (road_ways.id or speed_limit_segments.id). */
  id: string;
  kind: "road_way" | "segment";
  coordinates: readonly Position[];
  highway: string | null;
  name: string | null;
  ref: string | null;
}

export interface PathOptions {
  /** How far a picked point may be from a road and still name it. */
  toleranceM: number;
  /** The longest interval accepted. */
  maxLengthM: number;
  /** The path may be at most this many times the straight distance (plus 80 m): "along the road", not around the block. */
  maxDetourFactor?: number;
  /** How many nearest edges at each point are tried as the road. */
  candidatesPerPoint?: number;
}

export interface ResolvedPath {
  /** [lng, lat] vertices, the first and the last being the projections of the two points. */
  coordinates: [number, number][];
  lengthM: number;
  /** The road pieces the line runs along, in order, each once. */
  wayIds: string[];
  kinds: ("road_way" | "segment")[];
  name: string | null;
  ref: string | null;
  highway: string | null;
  /** How far the two picked points were from the line (m). */
  fromDistanceM: number;
  toDistanceM: number;
}

export type PathFailure = "no_road" | "no_road_between" | "too_long" | "too_short";

export const MIN_INTERVAL_M = 10;

interface Edge {
  u: number;
  v: number;
  length: number;
  way: number;
}

interface Snap {
  edge: number;
  point: [number, number];
  distanceM: number;
  /** meters from the point's projection to edge.u and edge.v */
  toU: number;
  toV: number;
}

const key = (p: Position) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;

class MinHeap {
  private readonly items: [number, number][] = [];
  get size() {
    return this.items.length;
  }
  push(priority: number, value: number) {
    const a = this.items;
    a.push([priority, value]);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent]![0] <= a[i]![0]) break;
      [a[parent], a[i]] = [a[i]!, a[parent]!];
      i = parent;
    }
  }
  pop(): [number, number] | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

export function findPath(
  ways: readonly RoadWay[],
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  options: PathOptions,
): { ok: true; path: ResolvedPath } | { ok: false; failure: PathFailure } {
  const detour = options.maxDetourFactor ?? 3;
  const perPoint = options.candidatesPerPoint ?? 4;
  const pFrom: Position = [from.lng, from.lat];
  const pTo: Position = [to.lng, to.lat];
  const straight = haversineMeters(pFrom, pTo);
  if (straight < MIN_INTERVAL_M) return { ok: false, failure: "too_short" };
  if (straight > options.maxLengthM) return { ok: false, failure: "too_long" };

  // ---- graph over the vertices of every way
  const nodeIndex = new Map<string, number>();
  const nodes: Position[] = [];
  const nodeOf = (p: Position): number => {
    const k = key(p);
    let i = nodeIndex.get(k);
    if (i === undefined) {
      i = nodes.length;
      nodes.push(p);
      nodeIndex.set(k, i);
    }
    return i;
  };
  const edges: Edge[] = [];
  ways.forEach((way, wayIndex) => {
    for (let i = 0; i + 1 < way.coordinates.length; i += 1) {
      const a = way.coordinates[i]!;
      const b = way.coordinates[i + 1]!;
      const u = nodeOf(a);
      const v = nodeOf(b);
      if (u === v) continue;
      edges.push({ u, v, length: haversineMeters(a, b), way: wayIndex });
    }
  });
  if (edges.length === 0) return { ok: false, failure: "no_road" };
  const adjacency: number[][] = nodes.map(() => []);
  edges.forEach((e, i) => {
    adjacency[e.u]!.push(i);
    adjacency[e.v]!.push(i);
  });

  // ---- the nearest edges at a point
  const nearest = (p: Position): Snap[] => {
    const found: Snap[] = [];
    edges.forEach((e, i) => {
      const proj = projectOnSegment(p, nodes[e.u]!, nodes[e.v]!);
      if (proj.distanceM > options.toleranceM) return;
      const cut = proj.t * e.length;
      found.push({ edge: i, point: proj.point, distanceM: proj.distanceM, toU: cut, toV: e.length - cut });
    });
    found.sort((a, b) => a.distanceM - b.distanceM || a.edge - b.edge);
    return found.slice(0, perPoint);
  };
  const fromSnaps = nearest(pFrom);
  const toSnaps = nearest(pTo);
  if (fromSnaps.length === 0 || toSnaps.length === 0) return { ok: false, failure: "no_road" };

  const nameOf = (edge: Edge): string | null => ways[edge.way]!.ref ?? ways[edge.way]!.name;

  let best: { score: number; path: ResolvedPath } | null = null;
  let anyConnected = false;
  let anyShortEnough = false;

  for (const fs of fromSnaps) {
    const startEdge = edges[fs.edge]!;
    const startName = nameOf(startEdge);
    const dist = new Float64Array(nodes.length).fill(Number.POSITIVE_INFINITY);
    const prev = new Int32Array(nodes.length).fill(-1);
    const prevEdge = new Int32Array(nodes.length).fill(-1);
    const heap = new MinHeap();
    dist[startEdge.u] = fs.toU;
    dist[startEdge.v] = Math.min(dist[startEdge.v]!, fs.toV);
    heap.push(dist[startEdge.u]!, startEdge.u);
    heap.push(dist[startEdge.v]!, startEdge.v);
    const limit = Math.max(options.maxLengthM, straight * detour + 80);
    for (let top = heap.pop(); top; top = heap.pop()) {
      const [d, n] = top;
      if (d > dist[n]!) continue;
      if (d > limit) break;
      for (const ei of adjacency[n]!) {
        const e = edges[ei]!;
        const other = e.u === n ? e.v : e.u;
        const name = nameOf(e);
        // a soft preference for staying on the road that was picked: a different known name costs more
        const factor = startName !== null && name !== null && name !== startName ? 1.6 : 1;
        const nd = d + e.length * factor;
        if (nd < dist[other]!) {
          dist[other] = nd;
          prev[other] = n;
          prevEdge[other] = ei;
          heap.push(nd, other);
        }
      }
    }

    for (const ts of toSnaps) {
      const targetEdge = edges[ts.edge]!;
      const sameEdge = ts.edge === fs.edge;
      const coords: [number, number][] = [];
      const viaEdges: number[] = [];
      let lengthM: number;
      if (sameEdge) {
        lengthM = haversineMeters(fs.point, ts.point);
        coords.push(fs.point, ts.point);
        viaEdges.push(fs.edge);
      } else {
        // enter the target edge through whichever end is cheaper
        const viaU = dist[targetEdge.u]! + ts.toU;
        const viaV = dist[targetEdge.v]! + ts.toV;
        const endNode = viaU <= viaV ? targetEdge.u : targetEdge.v;
        const cost = Math.min(viaU, viaV);
        if (!Number.isFinite(cost)) continue;
        anyConnected = true;
        // walk back to a start end
        const chain: number[] = [];
        let n = endNode;
        const used: number[] = [];
        while (n !== startEdge.u && n !== startEdge.v) {
          chain.push(n);
          used.push(prevEdge[n]!);
          n = prev[n]!;
          if (n < 0) break;
        }
        if (n < 0) continue;
        chain.push(n);
        chain.reverse();
        used.reverse();
        coords.push(fs.point);
        for (const node of chain) coords.push([nodes[node]![0], nodes[node]![1]]);
        coords.push(ts.point);
        viaEdges.push(fs.edge, ...used, ts.edge);
        lengthM = lineLengthMeters(coords);
      }
      if (lengthM > options.maxLengthM) continue;
      if (lengthM > straight * detour + 80) continue;
      anyShortEnough = true;
      if (lengthM < MIN_INTERVAL_M) continue;
      const score = fs.distanceM + ts.distanceM + 0.02 * lengthM;
      if (best && best.score <= score) continue;

      // metadata: the way that carries most of the line
      const perWay = new Map<number, number>();
      const order: number[] = [];
      for (let i = 0; i + 1 < coords.length; i += 1) {
        const segLen = haversineMeters(coords[i]!, coords[i + 1]!);
        const edgeIdx = viaEdges[Math.min(i, viaEdges.length - 1)]!;
        const wayIdx = edges[edgeIdx]!.way;
        if (!perWay.has(wayIdx)) order.push(wayIdx);
        perWay.set(wayIdx, (perWay.get(wayIdx) ?? 0) + segLen);
      }
      const main = [...perWay.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? edges[fs.edge]!.way;
      const mainWay = ways[main]!;
      // drop vertices closer than 5 cm to the one before
      const clean: [number, number][] = [];
      for (const c of coords) {
        const last = clean[clean.length - 1];
        if (!last || haversineMeters(last, c) > 0.05) clean.push(c);
      }
      best = {
        score,
        path: {
          coordinates: clean,
          lengthM: lineLengthMeters(clean),
          wayIds: order.map((i) => ways[i]!.id),
          kinds: order.map((i) => ways[i]!.kind),
          name: mainWay.name,
          ref: mainWay.ref,
          highway: mainWay.highway,
          fromDistanceM: fs.distanceM,
          toDistanceM: ts.distanceM,
        },
      };
    }
  }

  if (best) return { ok: true, path: best.path };
  if (anyConnected && !anyShortEnough) return { ok: false, failure: "no_road_between" };
  return { ok: false, failure: anyConnected || fromSnaps.some((f) => toSnaps.some((t) => t.edge === f.edge)) ? "too_short" : "no_road_between" };
}
