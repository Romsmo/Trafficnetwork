import type { Position } from "./geo.js";

/**
 * Asks an Overpass-compatible service (https://wiki.openstreetmap.org/wiki/Overpass_API; data © OpenStreetMap contributors,
 * ODbL) for the drivable ways in a bounding box. The node does this once per area and keeps the answer in `road_ways`
 * (docs/road-network.md, "Where the roads come from"). The request carries a box, never a visitor.
 */
export const DRIVABLE_HIGHWAYS = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "road",
  "track",
] as const;

const DRIVABLE = new Set<string>(DRIVABLE_HIGHWAYS);

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface FetchedWay {
  externalId: string;
  coordinates: [number, number][];
  highway: string;
  name: string | null;
  ref: string | null;
}

interface OverpassElement {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

export function overpassQuery(box: BoundingBox, timeoutSeconds: number): string {
  const classes = DRIVABLE_HIGHWAYS.join("|");
  const bbox = [box.south, box.west, box.north, box.east].map((n) => n.toFixed(6)).join(",");
  return `[out:json][timeout:${timeoutSeconds}];way["highway"~"^(${classes})$"](${bbox});out geom tags;`;
}

/** The ways of an Overpass answer that are usable roads: a drivable class, at least two vertices, not marked as a non-road. */
export function parseOverpassAnswer(body: unknown): FetchedWay[] {
  const elements = (body as { elements?: OverpassElement[] } | null)?.elements;
  if (!Array.isArray(elements)) throw new Error("the answer has no elements list");
  const ways: FetchedWay[] = [];
  for (const el of elements) {
    if (el.type !== "way" || typeof el.id !== "number" || !Array.isArray(el.geometry)) continue;
    const highway = el.tags?.highway;
    if (typeof highway !== "string" || !DRIVABLE.has(highway)) continue;
    if (el.tags?.area === "yes") continue;
    const coordinates: [number, number][] = el.geometry
      .filter((p) => typeof p?.lat === "number" && typeof p?.lon === "number")
      .map((p) => [p.lon, p.lat]);
    if (coordinates.length < 2) continue;
    ways.push({
      externalId: String(el.id),
      coordinates,
      highway,
      name: el.tags?.name ?? null,
      ref: el.tags?.ref ?? null,
    });
  }
  return ways;
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export async function fetchRoads(
  serviceUrl: string,
  box: BoundingBox,
  options: { timeoutMs: number; userAgent: string; fetcher?: Fetcher },
): Promise<FetchedWay[]> {
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetcher(serviceUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": options.userAgent, accept: "application/json" },
      body: `data=${encodeURIComponent(overpassQuery(box, Math.max(5, Math.floor(options.timeoutMs / 1000) - 2)))}`,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`the road service answered HTTP ${response.status}`);
    return parseOverpassAnswer(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

/** [lng, lat] corners of a box, for a quick containment test. */
export function boxOf(positions: readonly Position[], marginDegrees = 0): BoundingBox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of positions) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return { west: west - marginDegrees, south: south - marginDegrees, east: east + marginDegrees, north: north + marginDegrees };
}
