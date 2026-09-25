import { cellToBoundary, cellToChildren, getRes0Cells, getResolution, latLngToCell } from "h3-js";
import type { Envelope } from "../../lib/geo-bbox.js";

/**
 * Geometry helpers for the disk-backed static-data packages (add-on E-B,
 * docs/europe-scale.md). H3 lives in application code only (no Postgres
 * extension, docs/concept.md section 3.4), so a tile's rows are found with a
 * bounding-box query the GiST index can serve and then narrowed down here with
 * the exact same vertex rule the in-memory builder always used
 * (modules/static-data/partitions.ts): a segment belongs to every tile that
 * contains any of its vertices, a point to the tile it falls in.
 */

interface GeoJsonPoint {
  coordinates: [number, number];
}
interface GeoJsonLineString {
  coordinates: [number, number][];
}

export function pointTileOf(geojson: unknown, resolution: number): string {
  const [lng, lat] = (geojson as GeoJsonPoint).coordinates;
  return latLngToCell(lat, lng, resolution);
}

export function segmentTilesOf(geojson: unknown, resolution: number): Set<string> {
  const tiles = new Set<string>();
  for (const [lng, lat] of (geojson as GeoJsonLineString).coordinates) tiles.add(latLngToCell(lat, lng, resolution));
  return tiles;
}

export type { Envelope };

/**
 * H3 cell edges are great-circle arcs, which bow away from the straight
 * corner-to-corner line — slightly for a fine cell, enormously for a coarse cell
 * near a pole (a property test found a res-1 cell whose edge reaches 88.8° north
 * from corners at 79°). So the boundary is not taken from the corners: every edge
 * is sampled along its great circle, the box is fitted to those samples, and only
 * a small pad remains for the gap between samples. A too-small envelope would
 * silently drop rows from a package, so tests/unit/static-data-tiles.test.ts
 * checks it against hundreds of thousands of real points at every resolution.
 */
const CELL_PAD = 0.05;
const EDGE_SAMPLES = 16;

type Vec = [number, number, number];

function toVec(lat: number, lng: number): Vec {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lng * Math.PI) / 180;
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
}

function toLatLng(v: Vec): [number, number] {
  return [(Math.asin(Math.max(-1, Math.min(1, v[2]))) * 180) / Math.PI, (Math.atan2(v[1], v[0]) * 180) / Math.PI];
}

function slerp(a: Vec, b: Vec, t: number): Vec {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-12) return a;
  const s = Math.sin(omega);
  const wa = Math.sin((1 - t) * omega) / s;
  const wb = Math.sin(t * omega) / s;
  return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2]];
}

/** Longitude coverage of a set of longitudes: the complement of the largest gap on the circle; `wraps` when it crosses ±180. */
function lngCoverage(lngs: number[]): { west: number; east: number; wraps: boolean } {
  const sorted = [...lngs].sort((a, b) => a - b);
  let bestGap = sorted[0]! + 360 - sorted[sorted.length - 1]!;
  let bestIndex = -1; // -1: the widest gap is the one across ±180, so nothing wraps
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1]! - sorted[i]!;
    if (gap > bestGap) {
      bestGap = gap;
      bestIndex = i;
    }
  }
  if (bestIndex === -1) return { west: sorted[0]!, east: sorted[sorted.length - 1]!, wraps: false };
  return { west: sorted[bestIndex + 1]!, east: sorted[bestIndex]! + 360, wraps: true };
}

/**
 * Bounding envelope(s) of an H3 cell, as a superset. Normally one; two when the
 * cell straddles the antimeridian; a cell holding a pole spans all longitudes.
 */
export function tileEnvelopes(tile: string, pad = CELL_PAD): Envelope[] {
  const corners = cellToBoundary(tile);
  const lats: number[] = [];
  const lngs: number[] = [];
  for (let i = 0; i < corners.length; i++) {
    const [latA, lngA] = corners[i]!;
    const [latB, lngB] = corners[(i + 1) % corners.length]!;
    const a = toVec(latA, lngA);
    const b = toVec(latB, lngB);
    for (let s = 0; s < EDGE_SAMPLES; s++) {
      const [lat, lng] = toLatLng(slerp(a, b, s / EDGE_SAMPLES));
      lats.push(lat);
      lngs.push(lng);
    }
  }
  const res = getResolution(tile);
  let south = Math.min(...lats);
  let north = Math.max(...lats);
  const dLat = (north - south) * pad + 1e-6;
  south = Math.max(-90, south - dLat);
  north = Math.min(90, north + dLat);

  // A cell holding a pole covers every longitude and reaches the pole itself.
  if (latLngToCell(90, 0, res) === tile) return [{ west: -180, south, east: 180, north: 90 }];
  if (latLngToCell(-90, 0, res) === tile) return [{ west: -180, south: -90, east: 180, north }];

  const cover = lngCoverage(lngs);
  const dLng = (cover.east - cover.west) * pad + 1e-6;
  if (cover.wraps) {
    return [
      { west: Math.max(-180, cover.west - dLng), south, east: 180, north },
      { west: -180, south, east: Math.min(180, cover.east + dLng - 360), north },
    ];
  }
  return [{ west: Math.max(-180, cover.west - dLng), south, east: Math.min(180, cover.east + dLng), north }];
}

/** Generous envelope used only to *prune* the descent when enumerating populated tiles (children may overhang their parent). */
export function pruningEnvelopes(tile: string): Envelope[] {
  return tileEnvelopes(tile, 0.45);
}

export function isTileAtResolution(tile: string, resolution: number): boolean {
  try {
    return getResolution(tile) === resolution;
  } catch {
    return false;
  }
}

/** The res-0 cells to start a descent from. */
export function rootTiles(): string[] {
  return getRes0Cells();
}

export function childTiles(tile: string): string[] {
  return cellToChildren(tile, getResolution(tile) + 1);
}
