import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { Region } from "../../config/regions.js";
import type { Logger } from "../../logging.js";

/**
 * Downloads (or reuses a cached, checksum-verified) Geofabrik `.osm.pbf`
 * extract for `region` into `downloadDir/<regionId>.osm.pbf`. Always fetches
 * the (tiny) `.md5` sidecar fresh and checks it before ever handing a file to
 * osmium — an unverified extract is never processed, cached or not.
 */
export async function downloadExtract(regionId: string, region: Region, downloadDir: string, logger: Logger): Promise<string> {
  await fs.mkdir(downloadDir, { recursive: true });
  const filePath = path.join(downloadDir, `${regionId}.osm.pbf`);

  const expectedChecksum = await fetchExpectedChecksum(region.geofabrikChecksumUrl);

  if (existsSync(filePath)) {
    const actual = await md5OfFile(filePath);
    if (actual === expectedChecksum) {
      logger.info({ regionId, filePath }, "cached extract checksum matches — skipping download");
      return filePath;
    }
    logger.warn({ regionId, filePath, cached: actual, expected: expectedChecksum }, "cached extract checksum stale/mismatched — re-downloading (Geofabrik's -latest edition moved on since it was cached)");
  }

  logger.info({ regionId, url: region.geofabrikExtractUrl }, "downloading extract");
  const tmpPath = `${filePath}.part`;
  const res = await fetch(region.geofabrikExtractUrl);
  if (!res.ok || !res.body) throw new Error(`Failed to download ${region.geofabrikExtractUrl}: HTTP ${res.status}`);

  const hash = createHash("md5");
  const writeStream = createWriteStream(tmpPath);
  const reader = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  reader.on("data", (chunk: Buffer) => hash.update(chunk));
  reader.pipe(writeStream);
  await finished(writeStream);

  const actualChecksum = hash.digest("hex");
  if (actualChecksum !== expectedChecksum) {
    await fs.unlink(tmpPath).catch(() => {});
    throw new Error(
      `Downloaded extract for "${regionId}" failed checksum verification (expected ${expectedChecksum}, got ${actualChecksum}) — deleted the partial/corrupt file, not processing it. Try again; if this repeats, the download may be getting corrupted in transit.`,
    );
  }

  await fs.rename(tmpPath, filePath);
  logger.info({ regionId, filePath, checksum: actualChecksum }, "download verified");
  return filePath;
}

async function fetchExpectedChecksum(checksumUrl: string): Promise<string> {
  const res = await fetch(checksumUrl);
  if (!res.ok) throw new Error(`Failed to fetch checksum from ${checksumUrl}: HTTP ${res.status}`);
  const text = await res.text();
  // Geofabrik's .md5 files look like: "<hex>  <filename>\n" (standard md5sum(1) output).
  const match = text.trim().match(/^([0-9a-f]{32})/i);
  if (!match) throw new Error(`Could not parse checksum from ${checksumUrl}: unexpected format "${text.slice(0, 100)}"`);
  return match[1]!.toLowerCase();
}

async function md5OfFile(filePath: string): Promise<string> {
  const hash = createHash("md5");
  const stream = (await fs.open(filePath)).createReadStream();
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
