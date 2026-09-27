import { polygonToCells } from "h3-js";
import type { ApiClient } from "../api/client.js";
import type { BulkImportKind } from "../api/types.js";
import type { Region } from "../config/regions.js";
import type { Logger } from "../logging.js";

const H3_MANIFEST_RESOLUTION = 2; // matches server's STATIC_DATA_PARTITION_H3_RESOLUTION default (server/docs/api.md)

export interface SpotCheckResult {
  lat: number;
  lng: number;
  expectedKmh: number;
  found: boolean;
  actualKmh?: number;
}

export interface VerificationResult {
  /** The run's own bookkeeping — exact, always available, the headline number. */
  insertedByKind: Record<BulkImportKind, number>;
  spotChecks: SpotCheckResult[];
  /** Approximate cross-check via the static-data manifest/partitions — see the doc comment below for why it's approximate. */
  manifestCounts: { speedLimitSegments: number; staticSigns: number; fixedSpeedCameras: number };
}

/**
 * Post-run verification (Arbeitspaket 4): confirms what actually landed on
 * the server, from the outside, over the same public API any other client
 * uses — no privileged read path. Three layers of decreasing certainty:
 *
 * 1. The run's own `insertedByKind` counts — exact, but only proves "the
 *    server accepted N rows this run," not that they're still there or
 *    queryable correctly.
 * 2. Spot-checks against `region.verificationPoints` (operator-supplied,
 *    never invented — see config/regions.ts) via the real nearby-lookup API.
 * 3. An approximate manifest/partition cross-check: sums every static entity
 *    in the H3 partitions covering the region's bbox. Approximate because a
 *    LineString segment straddling a partition boundary is counted in every
 *    partition one of its vertices falls into (server/docs/api.md), and this
 *    also picks up anything already in those partitions from prior runs or
 *    overlapping regions — a sanity net, not a second source of truth.
 */
export async function verifyRun(
  apiClient: ApiClient,
  region: Region,
  insertedByKind: Record<BulkImportKind, number>,
  logger: Logger,
): Promise<VerificationResult> {
  const spotChecks: SpotCheckResult[] = [];
  for (const point of region.verificationPoints ?? []) {
    const nearby = await apiClient.getNearbySpeedLimitSegments(point.lat, point.lng, 200);
    const match = nearby.find((s) => s.speedLimit === point.expectedKmh);
    spotChecks.push({ lat: point.lat, lng: point.lng, expectedKmh: point.expectedKmh, found: Boolean(match), actualKmh: match?.speedLimit ?? nearby[0]?.speedLimit });
    if (!match) logger.warn({ point }, "verification spot-check did not find the expected speed limit nearby");
  }

  const manifestCounts = { speedLimitSegments: 0, staticSigns: 0, fixedSpeedCameras: 0 };
  if (region.skipManifestCrossCheck) {
    logger.info(
      { insertedByKind, spotChecks },
      "verification complete — manifest cross-check skipped for this region (it would download the whole static dataset); count the rows in the database instead",
    );
    return { insertedByKind, spotChecks, manifestCounts };
  }

  const [minLng, minLat, maxLng, maxLat] = region.bbox;
  const polygon = [
    [minLng, minLat],
    [maxLng, minLat],
    [maxLng, maxLat],
    [minLng, maxLat],
    [minLng, minLat],
  ];
  const relevantTiles = new Set(polygonToCells(polygon, H3_MANIFEST_RESOLUTION, true));

  const manifest = await apiClient.getStaticDataManifest();
  for (const partitionMeta of manifest.partitions) {
    if (!relevantTiles.has(partitionMeta.tile)) continue;
    const partition = await apiClient.getStaticDataPartition(partitionMeta.tile);
    manifestCounts.speedLimitSegments += partition.speedLimitSegments.length;
    manifestCounts.staticSigns += partition.staticSigns.length;
    manifestCounts.fixedSpeedCameras += partition.fixedSpeedCameras.length;
  }

  logger.info({ insertedByKind, spotChecks, manifestCounts }, "verification complete (manifestCounts is an approximate cross-check, not the authoritative number — see this run's insertedByKind for that)");
  return { insertedByKind, spotChecks, manifestCounts };
}
