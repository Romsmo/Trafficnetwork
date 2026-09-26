import { createHash } from "node:crypto";
import { latLngToCell } from "h3-js";
import type { SpeedLimitSegmentApi } from "../../db/queries/speed-limit-segments.js";
import type { StaticSignApi } from "../../db/queries/static-signs.js";
import type { FixedSpeedCameraApi } from "../../db/queries/fixed-speed-cameras.js";

interface GeoJsonPoint {
  type: "Point";
  coordinates: [number, number];
}

interface GeoJsonLineString {
  type: "LineString";
  coordinates: [number, number][];
}

function pointTile(geojson: unknown, resolution: number): string {
  const { coordinates } = geojson as GeoJsonPoint;
  const [lng, lat] = coordinates;
  return latLngToCell(lat, lng, resolution);
}

/**
 * A LineString almost always stays within one coarse partition cell — these
 * are short local road segments against ~86,800 km² (res 2) cells — but a
 * segment that happens to straddle a boundary is included in every partition
 * touched by any of its vertices, rather than picking one arbitrarily. A
 * client only ever needs to fetch the partitions its own position falls
 * into, so this modest duplication at boundaries is preferable to a segment
 * silently missing from the one partition a nearby client actually loads.
 */
function lineStringTiles(geojson: unknown, resolution: number): Set<string> {
  const { coordinates } = geojson as GeoJsonLineString;
  const tiles = new Set<string>();
  for (const [lng, lat] of coordinates) {
    tiles.add(latLngToCell(lat, lng, resolution));
  }
  return tiles;
}

export interface PartitionContent {
  tile: string;
  speedLimitSegments: SpeedLimitSegmentApi[];
  staticSigns: StaticSignApi[];
  /** The classic speed cameras only — what this key has always meant. */
  fixedSpeedCameras: FixedSpeedCameraApi[];
  /**
   * Add-on D: every persistent enforcement device of the tile, speed cameras included, each with
   * `cameraType`. Present only when the tile has at least one — a tile without keeps the bytes (and so
   * the hash) it had before the key existed, so clients do not re-download it for nothing.
   */
  enforcementDevices?: FixedSpeedCameraApi[];
}

export interface StaticDataForPartitioning {
  speedLimitSegments: SpeedLimitSegmentApi[];
  staticSigns: StaticSignApi[];
  fixedSpeedCameras: FixedSpeedCameraApi[];
  enforcementDevices?: FixedSpeedCameraApi[];
}

/**
 * Groups a full static-data dump into per-partition packages, computed in
 * application code (H3 is never a Postgres extension here, per
 * docs/concept.md section 3.4) from the same GeoJSON geometry the snapshot
 * endpoint already fetches — no separate spatial query or stored region-tile
 * column needed for these three tables.
 */
export function buildPartitions(data: StaticDataForPartitioning, resolution: number): Map<string, PartitionContent> {
  const partitions = new Map<string, PartitionContent>();
  const partitionFor = (tile: string): PartitionContent => {
    let existing = partitions.get(tile);
    if (!existing) {
      existing = { tile, speedLimitSegments: [], staticSigns: [], fixedSpeedCameras: [] };
      partitions.set(tile, existing);
    }
    return existing;
  };

  for (const segment of data.speedLimitSegments) {
    for (const tile of lineStringTiles(segment.geometry, resolution)) {
      partitionFor(tile).speedLimitSegments.push(segment);
    }
  }
  for (const sign of data.staticSigns) {
    partitionFor(pointTile(sign.position, resolution)).staticSigns.push(sign);
  }
  for (const camera of data.fixedSpeedCameras) {
    partitionFor(pointTile(camera.position, resolution)).fixedSpeedCameras.push(camera);
  }
  for (const device of data.enforcementDevices ?? []) {
    const partition = partitionFor(pointTile(device.position, resolution));
    (partition.enforcementDevices ??= []).push(device);
  }
  return partitions;
}

export interface SerializedPartition {
  json: string;
  hash: string;
  sizeBytes: number;
}

/** Content hash, not a separate version counter — a client just compares hashes to know what changed. */
export function serializePartition(content: PartitionContent): SerializedPartition {
  const json = JSON.stringify(content);
  const hash = createHash("sha256").update(json).digest("hex");
  return { json, hash, sizeBytes: Buffer.byteLength(json) };
}
