import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Region } from "../../src/config/regions.js";
import { downloadExtract } from "../../src/pipeline/osm/download.js";

const silentLogger = pino({ level: "silent" });
const md5 = (data: Buffer): string => createHash("md5").update(data).digest("hex");

interface RangeServer {
  base: string;
  requests: { range?: string; url: string }[];
  close: () => Promise<void>;
}

interface ServerBehaviour {
  /** Destroy the connection after this many body bytes on the FIRST body request. */
  dropFirstAfterBytes?: number;
  ignoreRange?: boolean;
  status?: number;
  lastModified?: string;
}

async function startRangeServer(content: Buffer, behaviour: ServerBehaviour = {}): Promise<RangeServer> {
  const requests: RangeServer["requests"] = [];
  let bodyRequests = 0;
  const server: Server = createServer((req: IncomingMessage, res) => {
    requests.push({ range: req.headers.range, url: req.url ?? "" });
    if (req.url?.endsWith(".md5")) {
      res.writeHead(200).end(`${md5(content)}  file.osm.pbf\n`);
      return;
    }
    if (behaviour.status) {
      res.writeHead(behaviour.status).end();
      return;
    }
    bodyRequests++;
    const headers: Record<string, string | number> = { "accept-ranges": "bytes", "last-modified": behaviour.lastModified ?? "Thu, 24 Sep 2026 22:17:39 GMT" };
    const match = !behaviour.ignoreRange && req.headers.range ? /^bytes=(\d+)-$/.exec(req.headers.range) : null;
    const start = match ? Number(match[1]) : 0;
    if (match) {
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${content.length - 1}/${content.length}`, "content-length": content.length - start });
    } else {
      res.writeHead(200, { ...headers, "content-length": content.length });
    }
    const body = content.subarray(start);
    if (behaviour.dropFirstAfterBytes !== undefined && bodyRequests === 1) {
      res.write(body.subarray(0, behaviour.dropFirstAfterBytes), () => setTimeout(() => res.destroy(), 20));
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { base: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function regionFor(base: string): Region {
  return { name: "Test", geofabrikExtractUrl: `${base}/file.osm.pbf`, geofabrikChecksumUrl: `${base}/file.osm.pbf.md5`, bbox: [0, 0, 1, 1] };
}

const fast = { retryBaseMs: 1, retryMaxMs: 5, progressIntervalMs: 60_000 };

describe("downloadExtract — resume", () => {
  let dir: string;
  let content: Buffer;
  let server: RangeServer | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ingestion-download-resume-"));
    content = randomBytes(60_000);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const partPath = () => path.join(dir, "r.osm.pbf.part");
  const writePart = (bytes: Buffer, meta: object) => {
    writeFileSync(partPath(), bytes);
    writeFileSync(`${partPath()}.meta.json`, JSON.stringify(meta));
  };

  it("continues a partial file with a Range request and produces the identical file", async () => {
    server = await startRangeServer(content);
    const region = regionFor(server.base);
    writePart(content.subarray(0, 25_000), { url: region.geofabrikExtractUrl, expectedMd5: md5(content), totalBytes: content.length });

    const result = await downloadExtract("r", region, dir, silentLogger, { ...fast, resumeSafetyTailBytes: 1000 });

    expect(readFileSync(result.filePath).equals(content)).toBe(true);
    expect(result.md5).toBe(md5(content));
    expect(result.sizeBytes).toBe(content.length);
    // the last 1000 bytes of the partial file were re-fetched: resume offset = 25000 - 1000
    expect(server.requests.find((r) => r.range)?.range).toBe("bytes=24000-");
    expect(existsSync(partPath())).toBe(false);
  });

  it("recovers from a connection dropped mid-body by resuming from the current offset", async () => {
    server = await startRangeServer(content, { dropFirstAfterBytes: 20_000 });
    const result = await downloadExtract("r", regionFor(server.base), dir, silentLogger, { ...fast, resumeSafetyTailBytes: 0 });

    expect(readFileSync(result.filePath).equals(content)).toBe(true);
    const bodyRequests = server.requests.filter((r) => !r.url.endsWith(".md5"));
    expect(bodyRequests.length).toBeGreaterThanOrEqual(2);
    expect(bodyRequests[0]!.range).toBeUndefined();
    expect(bodyRequests[1]!.range).toMatch(/^bytes=\d+-$/);
  });

  it("restarts from the beginning when the server ignores the Range header", async () => {
    server = await startRangeServer(content, { ignoreRange: true });
    const region = regionFor(server.base);
    writePart(content.subarray(0, 10_000), { url: region.geofabrikExtractUrl, expectedMd5: md5(content), totalBytes: content.length });

    const result = await downloadExtract("r", region, dir, silentLogger, { ...fast, resumeSafetyTailBytes: 0 });
    expect(readFileSync(result.filePath).equals(content)).toBe(true);
  });

  it("never continues a partial file of a different edition (checksum changed): it starts over", async () => {
    server = await startRangeServer(content);
    const region = regionFor(server.base);
    writePart(randomBytes(30_000), { url: region.geofabrikExtractUrl, expectedMd5: "00000000000000000000000000000000", totalBytes: 99_999 });

    const result = await downloadExtract("r", region, dir, silentLogger, { ...fast, resumeSafetyTailBytes: 0 });
    expect(readFileSync(result.filePath).equals(content)).toBe(true);
    expect(server.requests.some((r) => r.range)).toBe(false); // no Range: the old partial was thrown away
  });

  it("detects a corrupted seam through the whole-file checksum, deletes the partial and fails", async () => {
    server = await startRangeServer(content);
    const region = regionFor(server.base);
    const corrupted = Buffer.from(content.subarray(0, 25_000));
    corrupted[100] = corrupted[100]! ^ 0xff; // damage in the part that is kept (before the discarded tail)
    writePart(corrupted, { url: region.geofabrikExtractUrl, expectedMd5: md5(content), totalBytes: content.length });

    await expect(downloadExtract("r", region, dir, silentLogger, { ...fast, resumeSafetyTailBytes: 1000 })).rejects.toThrow(/checksum verification/);
    expect(existsSync(partPath())).toBe(false);
    expect(existsSync(path.join(dir, "r.osm.pbf"))).toBe(false);
  });

  it("does not re-download or re-hash a file it already verified", async () => {
    server = await startRangeServer(content);
    const region = regionFor(server.base);
    await downloadExtract("r", region, dir, silentLogger, fast);
    const before = server.requests.filter((r) => !r.url.endsWith(".md5")).length;

    const again = await downloadExtract("r", region, dir, silentLogger, fast);
    expect(again.md5).toBe(md5(content));
    expect(again.lastModified).toBe("Thu, 24 Sep 2026 22:17:39 GMT");
    expect(server.requests.filter((r) => !r.url.endsWith(".md5")).length).toBe(before);
  });

  it("gives up immediately on a permanent HTTP error", async () => {
    server = await startRangeServer(content, { status: 404 });
    await expect(downloadExtract("r", regionFor(server.base), dir, silentLogger, fast)).rejects.toThrow(/HTTP 404/);
    expect(server.requests.filter((r) => !r.url.endsWith(".md5"))).toHaveLength(1);
  });
});
