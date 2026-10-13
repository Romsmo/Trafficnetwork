import path from "node:path";
import { ApiClient } from "./api/client.js";
import type { Env } from "./config/env.js";
import type { Region } from "./config/regions.js";
import type { Logger } from "./logging.js";
import { downloadExtract } from "./pipeline/osm/download.js";
import { exportRoads } from "./pipeline/osm/osmium.js";
import { importRoads, type RoadImportReport } from "./pipeline/osm/roads.js";

/**
 * `npm run ingest -- --roads --region <id> [--dry-run]`: the road network of the region's OSM extract (docs/roads.md).
 *
 * Download (resumable, checksum-verified: the same file the speed import uses), osmium tags-filter for the drivable ways,
 * streamed export, one idempotent POST per batch, then the areas the extract holds completely. Nothing is kept locally: the
 * server upserts per OSM way id, so the run can simply be repeated.
 */
export async function runRoadsCommand(env: Env, logger: Logger, options: { regionId: string; region: Region; dryRun: boolean }): Promise<RoadImportReport> {
  const { regionId, region, dryRun } = options;
  if (!region.geofabrikExtractUrl || !region.geofabrikChecksumUrl) {
    throw new Error(`Region "${regionId}" has no Geofabrik extract (geofabrikExtractUrl / geofabrikChecksumUrl in config/regions.json) - the road network cannot be imported for it`);
  }
  const apiClient = new ApiClient(env, logger);
  if (!dryRun) {
    logger.info({ serverUrl: env.SERVER_URL }, "authenticating against server");
    await apiClient.authenticate();
  }
  const download = await downloadExtract(regionId, region, env.DOWNLOAD_DIR, logger);
  const workDir = path.join(env.DOWNLOAD_DIR, `${regionId}-roads-work`);
  const report = await exportRoads(download.filePath, workDir, { indexDir: env.OSMIUM_INDEX_DIR }, logger, (features) => importRoads(features, apiClient, { dryRun, logger }));
  logger.info({ region: region.name, ...report, dryRun }, "road network import report");
  return report;
}
