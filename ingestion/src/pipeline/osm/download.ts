import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { backoffDelayMs } from "../../batching/backoff.js";
import type { Region } from "../../config/regions.js";
import type { Logger } from "../../logging.js";

export interface DownloadOptions {
  /**
   * On resume, this many bytes are cut off the end of the `.part` file and fetched again. After a
   * crash the tail of a file can be zero-filled or half-written even though its size looks right,
   * and such a seam would only show up in the final checksum — after hours, as a full re-download.
   */
  resumeSafetyTailBytes?: number;
  /** Consecutive attempts without any progress before giving up. Default 20. */
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Abort a connection that delivers no data for this long. Default 60 s. */
  idleTimeoutMs?: number;
  progressIntervalMs?: number;
}

export interface DownloadedExtract {
  filePath: string;
  md5: string;
  sizeBytes: number;
  url: string;
  /** `Last-Modified` of the file as served, when known (unknown for a cached file without a verification marker). */
  lastModified?: string;
}

interface PartMeta {
  url: string;
  expectedMd5: string;
  totalBytes?: number;
  lastModified?: string;
}

interface VerifiedMarker {
  md5: string;
  sizeBytes: number;
  mtimeMs: number;
  lastModified?: string;
}

const DEFAULT_TAIL = 64 * 1024 * 1024;

/**
 * Downloads (or reuses a cached, checksum-verified) Geofabrik `.osm.pbf`
 * extract for `region` into `downloadDir/<regionId>.osm.pbf`.
 *
 * - The (tiny) `.md5` sidecar is always fetched fresh and checked before a file is ever handed to
 *   osmium — an unverified extract is never processed, cached or not.
 * - Resumable: a `.part` file is continued with an HTTP `Range` request, also automatically after a
 *   dropped connection or a stalled one (35 GB at 8 MB/s is over an hour; a network blip must not
 *   restart it). A `.part.meta.json` pins the edition (URL + expected md5 + Last-Modified): a
 *   partial file is never continued against a different edition.
 * - The whole file is hashed once at the end, so the checksum covers resume seams too.
 * - A verified file gets a `.verified` marker (md5, size, mtime), so re-running does not re-hash 35 GB.
 */
export async function downloadExtract(regionId: string, region: Region, downloadDir: string, logger: Logger, options: DownloadOptions = {}): Promise<DownloadedExtract> {
  await fs.mkdir(downloadDir, { recursive: true });
  const filePath = path.join(downloadDir, `${regionId}.osm.pbf`);
  const tmpPath = `${filePath}.part`;
  const partMetaPath = `${tmpPath}.meta.json`;
  const markerPath = `${filePath}.verified`;
  const url = region.geofabrikExtractUrl;

  const expectedChecksum = await fetchExpectedChecksum(region.geofabrikChecksumUrl);

  if (existsSync(filePath)) {
    const stat = await fs.stat(filePath);
    const marker = await readJson<VerifiedMarker>(markerPath);
    if (marker && marker.md5 === expectedChecksum && marker.sizeBytes === stat.size && marker.mtimeMs === stat.mtimeMs) {
      logger.info({ regionId, filePath }, "cached extract already verified against the published checksum — skipping download");
      return { filePath, md5: marker.md5, sizeBytes: stat.size, url, lastModified: marker.lastModified };
    }
    logger.info({ regionId, filePath, sizeBytes: stat.size }, "verifying cached extract (hashing the whole file — minutes for a continent)");
    const actual = await md5OfFile(filePath);
    if (actual === expectedChecksum) {
      await writeJson(markerPath, { md5: actual, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, lastModified: marker?.lastModified } satisfies VerifiedMarker);
      logger.info({ regionId, filePath }, "cached extract checksum matches — skipping download");
      return { filePath, md5: actual, sizeBytes: stat.size, url, lastModified: marker?.lastModified };
    }
    logger.warn({ regionId, filePath, cached: actual, expected: expectedChecksum }, "cached extract checksum stale/mismatched — re-downloading (Geofabrik's -latest edition moved on since it was cached)");
    await fs.unlink(filePath);
    await fs.rm(markerPath, { force: true });
  }

  const meta = await fetchIntoPart({ url, tmpPath, partMetaPath, expectedChecksum, regionId, logger, options });

  logger.info({ regionId, sizeBytes: (await fs.stat(tmpPath)).size }, "download complete — verifying checksum over the whole file");
  const actualChecksum = await md5OfFile(tmpPath);
  if (actualChecksum !== expectedChecksum) {
    await fs.unlink(tmpPath).catch(() => {});
    await fs.rm(partMetaPath, { force: true });
    throw new Error(
      `Downloaded extract for "${regionId}" failed checksum verification (expected ${expectedChecksum}, got ${actualChecksum}) — deleted the partial/corrupt file, not processing it. Try again; if this repeats, the download may be getting corrupted in transit.`,
    );
  }

  await fs.rename(tmpPath, filePath);
  await fs.rm(partMetaPath, { force: true });
  const stat = await fs.stat(filePath);
  await writeJson(markerPath, { md5: actualChecksum, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, lastModified: meta.lastModified } satisfies VerifiedMarker);
  logger.info({ regionId, filePath, checksum: actualChecksum, sizeBytes: stat.size }, "download verified");
  return { filePath, md5: actualChecksum, sizeBytes: stat.size, url, lastModified: meta.lastModified };
}

interface FetchIntoPartArgs {
  url: string;
  tmpPath: string;
  partMetaPath: string;
  expectedChecksum: string;
  regionId: string;
  logger: Logger;
  options: DownloadOptions;
}

/** Fills `tmpPath` to the full remote size, resuming across failures. Returns what was learned about the remote file. */
async function fetchIntoPart(args: FetchIntoPartArgs): Promise<PartMeta> {
  const { url, tmpPath, partMetaPath, expectedChecksum, regionId, logger, options } = args;
  const tail = options.resumeSafetyTailBytes ?? DEFAULT_TAIL;
  const maxAttempts = options.maxAttempts ?? 20;
  const backoff = { baseMs: options.retryBaseMs ?? 2000, maxMs: options.retryMaxMs ?? 60_000, maxRetries: maxAttempts };
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const progressIntervalMs = options.progressIntervalMs ?? 30_000;

  let meta: PartMeta = { url, expectedMd5: expectedChecksum };

  // Pin the edition: continue an existing .part only if it belongs to exactly this URL + checksum.
  const previous = await readJson<PartMeta>(partMetaPath);
  let start = await sizeOf(tmpPath);
  if (start > 0 && (!previous || previous.url !== url || previous.expectedMd5 !== expectedChecksum)) {
    logger.warn({ regionId, partialBytes: start }, "partial download belongs to a different edition (URL/checksum changed) — discarding it, starting over");
    await fs.rm(tmpPath, { force: true });
    start = 0;
  } else if (previous) {
    meta = previous;
  }
  if (start > 0) {
    const keep = Math.max(0, start - tail);
    await fs.truncate(tmpPath, keep);
    start = keep;
    logger.info({ regionId, resumeFromBytes: start, discardedTailBytes: tail }, "resuming partial download");
  }
  await writeJson(partMetaPath, meta);

  let failures = 0;
  for (;;) {
    start = await sizeOf(tmpPath);
    if (meta.totalBytes !== undefined && start === meta.totalBytes) return meta;

    const controller = new AbortController();
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error(`no data for ${idleTimeoutMs} ms`)), idleTimeoutMs);
    };
    const startedAtBytes = start;
    try {
      armIdle();
      const res = await fetch(url, { headers: start > 0 ? { range: `bytes=${start}-` } : {}, signal: controller.signal });

      if (res.status === 416) {
        const total = Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1]);
        await res.body?.cancel().catch(() => {});
        if (Number.isFinite(total) && total === start) return { ...meta, totalBytes: total };
        logger.warn({ regionId, start, total }, "server rejected the resume offset (416) — starting over");
        await fs.truncate(tmpPath, 0);
        continue;
      }
      if (!res.ok || !res.body) {
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        await res.body?.cancel().catch(() => {});
        if (!retryable) throw new NonRetryableError(`Failed to download ${url}: HTTP ${res.status}`);
        throw new Error(`HTTP ${res.status}`);
      }

      const lastModified = res.headers.get("last-modified") ?? undefined;
      let append = false;
      if (res.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get("content-range") ?? "");
        if (!range || Number(range[1]) !== start) throw new Error(`unexpected Content-Range "${res.headers.get("content-range")}" for a request starting at ${start}`);
        if (range[3] !== "*") meta = { ...meta, totalBytes: Number(range[3]) };
        if (meta.lastModified && lastModified && meta.lastModified !== lastModified) {
          await res.body.cancel().catch(() => {});
          logger.warn({ regionId, was: meta.lastModified, now: lastModified }, "remote file changed during the download — discarding the partial file, starting over");
          await fs.truncate(tmpPath, 0);
          meta = { url, expectedMd5: expectedChecksum };
          await writeJson(partMetaPath, meta);
          continue;
        }
        append = true;
      } else {
        // 200: the server delivers the whole file (no/ignored Range) — start from scratch.
        const length = Number(res.headers.get("content-length"));
        meta = { url, expectedMd5: expectedChecksum, totalBytes: Number.isFinite(length) && length > 0 ? length : undefined };
        if (start > 0) logger.warn({ regionId, start }, "server ignored the Range request — restarting the download from the beginning");
      }
      meta = { ...meta, lastModified: lastModified ?? meta.lastModified };
      await writeJson(partMetaPath, meta);

      const handle = await fs.open(tmpPath, append ? "a" : "w");
      let written = append ? start : 0;
      let lastLogAt = Date.now();
      let lastLogBytes = written;
      try {
        for await (const chunk of Readable.fromWeb(res.body as import("node:stream/web").ReadableStream)) {
          armIdle();
          await handle.write(chunk as Buffer);
          written += (chunk as Buffer).length;
          const now = Date.now();
          if (now - lastLogAt >= progressIntervalMs) {
            const mbPerS = (written - lastLogBytes) / 1e6 / ((now - lastLogAt) / 1000);
            const etaMin = meta.totalBytes && mbPerS > 0 ? Math.round((meta.totalBytes - written) / 1e6 / mbPerS / 60) : undefined;
            logger.info({ regionId, downloadedGB: +(written / 1e9).toFixed(2), totalGB: meta.totalBytes ? +(meta.totalBytes / 1e9).toFixed(2) : undefined, mbPerS: +mbPerS.toFixed(1), etaMinutes: etaMin }, "download progress");
            lastLogAt = now;
            lastLogBytes = written;
          }
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      clearTimeout(idleTimer);

      const finalSize = await sizeOf(tmpPath);
      if (meta.totalBytes !== undefined && finalSize < meta.totalBytes) throw new Error(`connection closed early at ${finalSize} of ${meta.totalBytes} bytes`);
      return meta;
    } catch (err) {
      clearTimeout(idleTimer);
      if (err instanceof NonRetryableError) throw err;
      const progressed = (await sizeOf(tmpPath)) > startedAtBytes;
      failures = progressed ? 1 : failures + 1;
      if (failures > maxAttempts) throw new Error(`Download of ${url} failed ${failures} times in a row without progress: ${err instanceof Error ? err.message : String(err)}`);
      const delayMs = backoffDelayMs(failures, backoff);
      logger.warn({ regionId, attempt: failures, delayMs, error: err instanceof Error ? err.message : String(err) }, "download interrupted — will resume from the current offset");
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

class NonRetryableError extends Error {}

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
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function sizeOf(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}
