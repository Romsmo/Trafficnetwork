import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Region } from "../../src/config/regions.js";
import { downloadExtract } from "../../src/pipeline/osm/download.js";

const silentLogger = pino({ level: "silent" });

function md5(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

function region(): Region {
  return {
    name: "Test Region",
    geofabrikExtractUrl: "https://example.invalid/test-region-latest.osm.pbf",
    geofabrikChecksumUrl: "https://example.invalid/test-region-latest.osm.pbf.md5",
    bbox: [0, 0, 1, 1],
  };
}

describe("downloadExtract", () => {
  let downloadDir: string;

  beforeEach(() => {
    downloadDir = mkdtempSync(path.join(tmpdir(), "ingestion-download-test-"));
  });

  afterEach(() => {
    rmSync(downloadDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("downloads a fresh extract and verifies its checksum", async () => {
    const content = "fake pbf bytes";
    const checksum = md5(content);
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.endsWith(".md5")) return new Response(`${checksum}  test-region-latest.osm.pbf\n`, { status: 200 });
      return new Response(content, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { filePath, md5: downloadedMd5, sizeBytes } = await downloadExtract("test-region", region(), downloadDir, silentLogger);

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(content);
    expect(downloadedMd5).toBe(checksum);
    expect(sizeBytes).toBe(content.length);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws and deletes the partial file when the downloaded content doesn't match the published checksum", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.endsWith(".md5")) return new Response(`deadbeefdeadbeefdeadbeefdeadbeef  test-region-latest.osm.pbf\n`, { status: 200 });
      return new Response("some other content entirely", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadExtract("test-region", region(), downloadDir, silentLogger)).rejects.toThrow(/checksum verification/);

    const finalPath = path.join(downloadDir, "test-region.osm.pbf");
    expect(existsSync(finalPath)).toBe(false);
    expect(existsSync(`${finalPath}.part`)).toBe(false);
  });

  it("reuses a cached file whose checksum still matches, without re-downloading the body", async () => {
    const content = "cached pbf bytes";
    const checksum = md5(content);
    const finalPath = path.join(downloadDir, "test-region.osm.pbf");
    writeFileSync(finalPath, content);

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.endsWith(".md5")) return new Response(`${checksum}  test-region-latest.osm.pbf\n`, { status: 200 });
      throw new Error("should not fetch the extract body when the cache is valid");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { filePath } = await downloadExtract("test-region", region(), downloadDir, silentLogger);

    expect(filePath).toBe(finalPath);
    expect(readFileSync(filePath, "utf8")).toBe(content);
    expect(fetchMock).toHaveBeenCalledTimes(1); // checksum only
  });

  it("re-downloads when the cached file's checksum no longer matches (e.g. Geofabrik's -latest moved on)", async () => {
    const staleContent = "stale cached bytes";
    const freshContent = "fresh pbf bytes";
    const freshChecksum = md5(freshContent);
    const finalPath = path.join(downloadDir, "test-region.osm.pbf");
    writeFileSync(finalPath, staleContent);

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.endsWith(".md5")) return new Response(`${freshChecksum}  test-region-latest.osm.pbf\n`, { status: 200 });
      return new Response(freshContent, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { filePath } = await downloadExtract("test-region", region(), downloadDir, silentLogger);

    expect(readFileSync(filePath, "utf8")).toBe(freshContent);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
