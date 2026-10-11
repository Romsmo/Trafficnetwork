import { cellToBoundary, cellToLatLng, cellToParent, getResolution } from "h3-js";

/**
 * Offline regions: the static-data packages (one per H3 tile at STATIC_DATA_PARTITION_H3_RESOLUTION) grouped into things
 * a person can choose — "France: 410 MB" — with what choosing them costs (docs/operating.md, "Offline regions").
 *
 * A tile belongs to **one** region: the country its centre lies in (country boundaries are the ones the camera policy
 * loads, `npm run cameras -- load-boundaries`), or — where no boundary data is loaded or the tile is out at sea — a coarse
 * H3 cell (`h3:<res-2 parent>`) with `country: null`. A tile on a border is counted once, for the country of its centre,
 * so the sizes of neighbouring regions add up to the whole without double counting.
 */

/** Coarse fallback grouping: resolution 2 cells are ≈ 86,000 km² (a few hundred kilometres across). */
export const FALLBACK_REGION_RESOLUTION = 2;

export interface RegionTileInput {
  tile: string;
  /** Uncompressed size of the package. */
  sizeBytes: number;
  gzipBytes: number | null;
  brotliBytes: number | null;
}

export interface Region {
  /** The ISO 3166-1 alpha-2 code of the country, or `h3:<cell>` for a coarse area without a known country. */
  id: string;
  country: string | null;
  tileCount: number;
  /** Uncompressed (what the device stores as JSON before it is parsed) and as sent — the unpacked and packed size of the choice. */
  sizeBytes: number;
  gzipBytes: number;
  brotliBytes: number;
  /** False while some tile has no compressed copy yet: `gzipBytes` / `brotliBytes` are then lower bounds. */
  complete: boolean;
  /** [west, south, east, north] in degrees, the box around all its tiles. */
  bbox: [number, number, number, number];
  /** The partition tile ids of the region: what a client selects to fetch exactly this region. */
  tiles: string[];
}

export interface TileCentre {
  tile: string;
  lat: number;
  lng: number;
}

export function tileCentres(tiles: readonly string[]): TileCentre[] {
  return tiles.map((tile) => {
    const [lat, lng] = cellToLatLng(tile);
    return { tile, lat, lng };
  });
}

function tileBox(tile: string): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lat, lng] of cellToBoundary(tile)) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

function fallbackId(tile: string): string {
  const resolution = getResolution(tile);
  return `h3:${resolution > FALLBACK_REGION_RESOLUTION ? cellToParent(tile, FALLBACK_REGION_RESOLUTION) : tile}`;
}

/** Pure: the same packages and the same country assignment always give the same regions, in the same order. */
export function groupRegions(tiles: readonly RegionTileInput[], countryOfTile: ReadonlyMap<string, string | null>): Region[] {
  const byId = new Map<string, Region>();
  for (const t of tiles) {
    const country = countryOfTile.get(t.tile) ?? null;
    const id = country ?? fallbackId(t.tile);
    const box = tileBox(t.tile);
    let region = byId.get(id);
    if (!region) {
      region = { id, country, tileCount: 0, sizeBytes: 0, gzipBytes: 0, brotliBytes: 0, complete: true, bbox: box, tiles: [] };
      byId.set(id, region);
    } else {
      region.bbox = [
        Math.min(region.bbox[0], box[0]),
        Math.min(region.bbox[1], box[1]),
        Math.max(region.bbox[2], box[2]),
        Math.max(region.bbox[3], box[3]),
      ];
    }
    region.tileCount += 1;
    region.sizeBytes += t.sizeBytes;
    region.gzipBytes += t.gzipBytes ?? 0;
    region.brotliBytes += t.brotliBytes ?? 0;
    if (t.gzipBytes === null || t.brotliBytes === null) region.complete = false;
    region.tiles.push(t.tile);
  }
  for (const region of byId.values()) region.tiles.sort();
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
