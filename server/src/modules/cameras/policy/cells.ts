import { createHash } from "node:crypto";
import {
  UNITS,
  cellToBoundary,
  cellToChildren,
  cellToParent,
  getHexagonEdgeLengthAvg,
  getResolution,
  gridDisk,
  latLngToCell,
} from "h3-js";

/**
 * Geometry of camera zones (docs/camera-country-policy.md, section 6). A zone is an H3 cell of a fixed resolution.
 * Everything here works on *cells*, never on a camera's own position beyond "which cell is it in": whether a zone is
 * delivered is decided by the cell against the query area, which is what keeps repeated queries from narrowing it down.
 */

export interface GeoJsonPolygon {
  type: "Polygon";
  coordinates: [number, number][][];
}

export function zoneCellOf(lat: number, lng: number, resolution: number): string {
  return latLngToCell(lat, lng, resolution);
}

/**
 * A zone's public id: a UUID derived from the cell alone (so every node names the same cell the same way, and no camera
 * id or random value is involved). Version/variant bits set so it parses as a UUID anywhere an entity id is expected.
 */
export function zoneId(cell: string): string {
  const bytes = createHash("sha256").update(`trafficnetwork:camera-zone:${cell}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The cell as a closed GeoJSON ring ([lng, lat]). */
export function cellPolygon(cell: string): GeoJsonPolygon {
  return { type: "Polygon", coordinates: [cellToBoundary(cell, true) as [number, number][]] };
}

const METERS_PER_DEGREE_LAT = 111_320;

/** Planar offset in metres of (lat, lng) from an origin — accurate enough for the tens of kilometres a query covers. */
function toLocalMeters(originLat: number, originLng: number, lat: number, lng: number): [number, number] {
  const cosLat = Math.cos((originLat * Math.PI) / 180);
  let dLng = lng - originLng;
  if (dLng > 180) dLng -= 360;
  if (dLng < -180) dLng += 360;
  return [dLng * cosLat * METERS_PER_DEGREE_LAT, (lat - originLat) * METERS_PER_DEGREE_LAT];
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Does the cell's polygon intersect the circle? (The circle's centre inside the cell counts.) */
export function cellIntersectsCircle(cell: string, lat: number, lng: number, radiusM: number): boolean {
  const ring = (cellToBoundary(cell, true) as [number, number][]).map(([cellLng, cellLat]) => toLocalMeters(lat, lng, cellLat, cellLng));
  // Even-odd point-in-polygon for the origin (the circle's centre).
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) inside = !inside;
  }
  if (inside) return true;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[i + 1]!;
    if (distanceToSegment(0, 0, ax, ay, bx, by) <= radiusM) return true;
  }
  return false;
}

/** Every cell of `resolution` whose polygon intersects the circle. */
export function zoneCellsIntersectingCircle(lat: number, lng: number, radiusM: number, resolution: number): string[] {
  const edge = getHexagonEdgeLengthAvg(resolution, UNITS.m);
  // Adjacent cell centres are sqrt(3)·edge apart; the nearest ring-k cells lie 1.5·edge·k away, and a cell reaches up to
  // one edge beyond its centre — so everything whose centre is within radius + 1.5·edge is inside ring k. One spare ring.
  const k = Math.ceil((radiusM + 1.5 * edge) / (1.5 * edge)) + 1;
  const center = latLngToCell(lat, lng, resolution);
  return gridDisk(center, k).filter((cell) => cellIntersectsCircle(cell, lat, lng, radiusM));
}

/**
 * The zone cells that a set of requested tiles (any resolution) speaks for: a zone qualifies through the cells it is
 * *parent* of, or child of — a relation between cells, never between a tile and a camera.
 */
export function zoneCellsForTiles(tiles: readonly string[], zoneResolution: number, maxCells = Number.POSITIVE_INFINITY): string[] | null {
  const out = new Set<string>();
  for (const tile of tiles) {
    const tileResolution = getResolution(tile);
    if (tileResolution === zoneResolution) out.add(tile);
    else if (tileResolution > zoneResolution) out.add(cellToParent(tile, zoneResolution));
    else {
      if (out.size + 7 ** (zoneResolution - tileResolution) > maxCells) return null; // far coarser than a zone: refuse, never truncate
      for (const child of cellToChildren(tile, zoneResolution)) out.add(child);
    }
    if (out.size > maxCells) return null;
  }
  return [...out].sort();
}

/** The same relation seen from one pair: does `tile` (any resolution) speak for the zone cell `cell`? Both must be valid cells. */
export function tileSpeaksForCell(tile: string, cell: string): boolean {
  const tileResolution = getResolution(tile);
  const cellResolution = getResolution(cell);
  if (tileResolution === cellResolution) return tile === cell;
  if (tileResolution > cellResolution) return cellToParent(tile, cellResolution) === cell;
  return cellToParent(cell, tileResolution) === tile;
}

/** The tiles of `resolution` that speak for a zone cell — whom a pushed zone event is for. */
export function tilesSpeakingForCell(cell: string, resolution: number): string[] {
  const cellResolution = getResolution(cell);
  if (resolution === cellResolution) return [cell];
  if (resolution < cellResolution) return [cellToParent(cell, resolution)];
  return cellToChildren(cell, resolution);
}

/** The zone cells carried by one static package tile (tile resolution <= zone resolution). */
export function zoneCellsOfPackageTile(tile: string, zoneResolution: number): string[] {
  return getResolution(tile) === zoneResolution ? [tile] : cellToChildren(tile, zoneResolution);
}

/** The package tile that carries a zone cell: its H3 parent at the partition resolution. */
export function packageTileOfZoneCell(cell: string, partitionResolution: number): string {
  return getResolution(cell) === partitionResolution ? cell : cellToParent(cell, partitionResolution);
}

/**
 * Package tiles to mark dirty when a camera at (lat, lng) appears, disappears or changes level: the tile the camera is in
 * (an individual camera lives there) and the tile that carries its zone (which may be a neighbour).
 */
export function cameraPackageTiles(lat: number, lng: number, partitionResolution: number, zoneResolution: number): string[] {
  return [
    ...new Set([
      latLngToCell(lat, lng, partitionResolution),
      packageTileOfZoneCell(latLngToCell(lat, lng, zoneResolution), partitionResolution),
    ]),
  ];
}
