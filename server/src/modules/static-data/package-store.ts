import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { once } from "node:events";
import { constants as zlibConstants, createBrotliCompress, createGzip, createGunzip, type BrotliCompress, type Gzip } from "node:zlib";

/**
 * On-disk store of pre-built static-data packages (add-on E-B,
 * docs/europe-scale.md). Files are content-addressed —
 * `<dir>/<tile>/<sha256 of the uncompressed JSON>.json.{gz,br}` — so a URL that
 * names a hash never changes meaning (immutable caching), a rebuild that yields
 * the same bytes leaves the files alone, and old versions can be kept for a
 * grace period while clients are still mid-download.
 *
 * Only the compressed forms are stored (≈ 4× smaller than the JSON, so a
 * Europe-sized set is a few GB instead of ten-plus); a client that does not
 * accept gzip or brotli gets the gzip file decompressed on the fly.
 */

export type PackageEncoding = "br" | "gzip" | "identity";

export interface WrittenPackage {
  hash: string;
  sizeBytes: number;
  gzipBytes: number;
  brotliBytes: number;
}

export interface StoreOptions {
  brotliQuality: number;
  gzipLevel: number;
}

const EXT = { gzip: "json.gz", br: "json.br" } as const;

function endStream(stream: Gzip | BrotliCompress): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.once("finish", resolve);
    stream.end();
  });
}

export class PackageWriter {
  private readonly hash = createHash("sha256");
  private size = 0;
  private readonly gzip: Gzip;
  private readonly brotli: BrotliCompress;
  private readonly gzipOut: WriteStream;
  private readonly brotliOut: WriteStream;

  constructor(
    private readonly tileDir: string,
    private readonly tmpBase: string,
    opts: StoreOptions,
  ) {
    this.gzip = createGzip({ level: opts.gzipLevel });
    this.brotli = createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: opts.brotliQuality } });
    this.gzipOut = createWriteStream(`${tmpBase}.gz`);
    this.brotliOut = createWriteStream(`${tmpBase}.br`);
    this.gzip.pipe(this.gzipOut);
    this.brotli.pipe(this.brotliOut);
    // A failure in any pipe must surface at finish(), not as an unhandled event.
    const swallow = () => undefined;
    this.gzip.on("error", swallow);
    this.brotli.on("error", swallow);
    this.gzipOut.on("error", swallow);
    this.brotliOut.on("error", swallow);
  }

  /** Appends text (JSON is UTF-8); waits for the compressors when they are behind, so memory stays bounded. */
  async write(text: string): Promise<void> {
    const buf = Buffer.from(text, "utf8");
    this.hash.update(buf);
    this.size += buf.length;
    // Both listeners must be attached *before* the first await: a stream that drains while we are
    // still waiting for the other one has already emitted its 'drain', and waiting for it afterwards
    // would hang forever (found the hard way on the first 10M-row build).
    const waits: Promise<unknown>[] = [];
    if (!this.gzip.write(buf)) waits.push(once(this.gzip, "drain"));
    if (!this.brotli.write(buf)) waits.push(once(this.brotli, "drain"));
    if (waits.length > 0) await Promise.all(waits);
  }

  /** Closes both files, then moves them to their content-addressed names. */
  async finish(): Promise<WrittenPackage> {
    await Promise.all([endStream(this.gzip), endStream(this.brotli)]);
    await Promise.all([finished(this.gzipOut), finished(this.brotliOut)]);
    const hash = this.hash.digest("hex");
    const gzipBytes = (await stat(`${this.tmpBase}.gz`)).size;
    const brotliBytes = (await stat(`${this.tmpBase}.br`)).size;
    await rename(`${this.tmpBase}.gz`, path.join(this.tileDir, `${hash}.${EXT.gzip}`));
    await rename(`${this.tmpBase}.br`, path.join(this.tileDir, `${hash}.${EXT.br}`));
    return { hash, sizeBytes: this.size, gzipBytes, brotliBytes };
  }

  async abort(): Promise<void> {
    this.gzip.destroy();
    this.brotli.destroy();
    this.gzipOut.destroy();
    this.brotliOut.destroy();
    await Promise.all([rm(`${this.tmpBase}.gz`, { force: true }), rm(`${this.tmpBase}.br`, { force: true })]);
  }
}

/** Resolves once the file is fully flushed and closed (its 'close' may already have been emitted). */
async function finished(stream: WriteStream): Promise<void> {
  if (stream.closed) return;
  await once(stream, "close");
}

export interface OpenedPackage {
  stream: Readable;
  /** Bytes the stream will deliver (known for gzip/br; unknown when gunzipping on the fly). */
  contentLength: number | null;
}

export class PackageStore {
  constructor(
    readonly dir: string,
    readonly options: StoreOptions,
  ) {}

  tileDir(tile: string): string {
    return path.join(this.dir, tile);
  }

  filePath(tile: string, hash: string, encoding: "gzip" | "br"): string {
    return path.join(this.tileDir(tile), `${hash}.${EXT[encoding]}`);
  }

  async createWriter(tile: string): Promise<PackageWriter> {
    const dir = this.tileDir(tile);
    await mkdir(dir, { recursive: true });
    return new PackageWriter(dir, path.join(dir, `.tmp-${randomBytes(6).toString("hex")}`), this.options);
  }

  async has(tile: string, hash: string): Promise<boolean> {
    try {
      await stat(this.filePath(tile, hash, "gzip"));
      return true;
    } catch {
      return false;
    }
  }

  /** Size of the stored file for one representation; null if it is missing. */
  async size(tile: string, hash: string, encoding: "gzip" | "br"): Promise<number | null> {
    try {
      return (await stat(this.filePath(tile, hash, encoding))).size;
    } catch {
      return null;
    }
  }

  /**
   * Opens a stored package for delivery. `range` is honoured only for the
   * stored (compressed) representations — the bytes of an identity response are
   * produced by decompressing on the fly and have no stable offsets.
   */
  async open(tile: string, hash: string, encoding: PackageEncoding, range?: { start: number; end: number }): Promise<OpenedPackage | null> {
    if (encoding === "identity") {
      const size = await this.size(tile, hash, "gzip");
      if (size === null) return null;
      return { stream: createReadStream(this.filePath(tile, hash, "gzip")).pipe(createGunzip()), contentLength: null };
    }
    const size = await this.size(tile, hash, encoding);
    if (size === null) return null;
    return {
      stream: createReadStream(this.filePath(tile, hash, encoding), range ? { start: range.start, end: range.end } : undefined),
      contentLength: range ? range.end - range.start + 1 : size,
    };
  }

  /** Removes files of a tile that are not in `keep`, unless younger than `graceMs` (a client may still be downloading them). */
  async collect(tile: string, keep: ReadonlySet<string>, graceMs: number): Promise<number> {
    let removed = 0;
    let names: string[];
    try {
      names = await readdir(this.tileDir(tile));
    } catch {
      return 0;
    }
    const now = Date.now();
    for (const name of names) {
      const hash = name.split(".")[0] ?? "";
      if (name.startsWith(".tmp-") || keep.has(hash)) continue;
      const file = path.join(this.tileDir(tile), name);
      try {
        if (now - (await stat(file)).mtimeMs < graceMs) continue;
        await rm(file, { force: true });
        removed++;
      } catch {
        /* raced with another collector — fine */
      }
    }
    return removed;
  }

  /** A tile that turned out to have no data leaves an empty directory behind; remove it (a no-op if anything is in it). */
  async pruneEmptyTileDir(tile: string): Promise<void> {
    try {
      await rmdir(this.tileDir(tile));
    } catch {
      /* not empty, or already gone */
    }
  }

  async removeTile(tile: string): Promise<void> {
    await rm(this.tileDir(tile), { recursive: true, force: true });
  }

  async removeAll(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
  }

  /** Total bytes of stored package files (for the operator's status view). */
  async diskUsage(): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    let tiles: string[];
    try {
      tiles = await readdir(this.dir);
    } catch {
      return { files, bytes };
    }
    for (const tile of tiles) {
      let names: string[] = [];
      try {
        names = await readdir(path.join(this.dir, tile));
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          bytes += (await stat(path.join(this.dir, tile, name))).size;
          files++;
        } catch {
          /* removed meanwhile */
        }
      }
    }
    return { files, bytes };
  }
}
