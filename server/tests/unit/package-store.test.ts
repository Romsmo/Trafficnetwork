import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { PackageStore } from "../../src/modules/static-data/package-store.js";

const dir = mkdtempSync(path.join(tmpdir(), "package-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const store = new PackageStore(dir, { gzipLevel: 6, brotliQuality: 5 });
const TILE = "84001dfffffffff";

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("PackageStore", () => {
  it("writes content-addressed gzip and brotli files whose hash is the sha256 of the uncompressed bytes", async () => {
    const writer = await store.createWriter(TILE);
    const parts = ['{"tile":"x","a":[', '{"n":1},{"n":2}', "]}"];
    for (const p of parts) await writer.write(p);
    const written = await writer.finish();
    const text = parts.join("");
    expect(written.hash).toBe(createHash("sha256").update(text).digest("hex"));
    expect(written.sizeBytes).toBe(Buffer.byteLength(text));
    expect(gunzipSync(await readAll((await store.open(TILE, written.hash, "gzip"))!.stream)).toString()).toBe(text);
    expect(brotliDecompressSync(await readAll((await store.open(TILE, written.hash, "br"))!.stream)).toString()).toBe(text);
    expect((await readAll((await store.open(TILE, written.hash, "identity"))!.stream)).toString()).toBe(text);
    expect(written.gzipBytes).toBe(await store.size(TILE, written.hash, "gzip"));
  });

  it("keeps up with a producer far faster than its compressors (backpressure must not lose a drain — this hung once)", async () => {
    const writer = await store.createWriter("84002bfffffffff");
    // Incompressible, so the compressors really are slower than the writes; 40 MB in 1 MB chunks.
    const hash = createHash("sha256");
    let total = 0;
    for (let i = 0; i < 40; i++) {
      const chunk = randomBytes(1 << 19).toString("hex"); // 1 MB of text
      hash.update(chunk);
      total += Buffer.byteLength(chunk);
      await writer.write(chunk);
    }
    const written = await writer.finish();
    expect(written.hash).toBe(hash.digest("hex"));
    expect(written.sizeBytes).toBe(total);
  }, 60_000);

  it("serves byte ranges of the stored representation (resumable downloads)", async () => {
    const writer = await store.createWriter("84003dfffffffff");
    await writer.write("x".repeat(100_000) + randomBytes(2000).toString("hex"));
    const written = await writer.finish();
    const full = await readAll((await store.open("84003dfffffffff", written.hash, "gzip"))!.stream);
    const part = await readAll((await store.open("84003dfffffffff", written.hash, "gzip", { start: 10, end: 59 }))!.stream);
    expect(part.equals(full.subarray(10, 60))).toBe(true);
  });

  it("returns null for a package that is not there, and collects superseded files after the grace period", async () => {
    expect(await store.open(TILE, "0".repeat(64), "gzip")).toBeNull();
    expect(await store.has(TILE, "0".repeat(64))).toBe(false);

    const current = await store.createWriter("84004dfffffffff");
    await current.write("first");
    const first = await current.finish();
    const next = await store.createWriter("84004dfffffffff");
    await next.write("second");
    const second = await next.finish();

    // Within the grace period nothing goes; with a zero grace period only the kept hash stays.
    expect(await store.collect("84004dfffffffff", new Set([second.hash]), 60_000)).toBe(0);
    expect(await store.has("84004dfffffffff", first.hash)).toBe(true);
    expect(await store.collect("84004dfffffffff", new Set([second.hash]), 0)).toBe(2);
    expect(await store.has("84004dfffffffff", first.hash)).toBe(false);
    expect(await store.has("84004dfffffffff", second.hash)).toBe(true);
  });

  it("leaves nothing behind when a write is aborted", async () => {
    const writer = await store.createWriter("84005dfffffffff");
    await writer.write("half a package");
    await writer.abort();
    const usage = await store.diskUsage();
    expect(usage.files).toBeGreaterThan(0); // the other tests' files
    expect(await store.collect("84005dfffffffff", new Set(), 0)).toBe(0);
  });
});
