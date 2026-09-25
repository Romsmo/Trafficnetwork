import { randomBytes } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Database, Transaction } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { tileSpeedLimitSegmentsQuery } from "../../db/queries/speed-limit-segments.js";
import { tileStaticSignsQuery } from "../../db/queries/static-signs.js";
import { tileFixedSpeedCamerasQuery } from "../../db/queries/fixed-speed-cameras.js";
import {
  acquireBuildLease,
  countDirtyTiles,
  currentStaticDataVersion,
  findPackageRow,
  getPackageState,
  hasStaticDataIn,
  listDirtyTiles,
  listKnownTiles,
  markAllKnownTilesDirty,
  markTilesDirty,
  recordTileBuilt,
  releaseBuildLease,
  setPackageState,
  type BuiltCounts,
} from "../../db/queries/static-packages.js";
import type { PackageStore, WrittenPackage } from "./package-store.js";
import { childTiles, pointTileOf, pruningEnvelopes, rootTiles, segmentTilesOf, tileEnvelopes } from "./tiles.js";

/**
 * Builds the disk-backed static-data packages (add-on E-B, docs/europe-scale.md).
 *
 * One tile at a time, memory bounded: the tile's rows are read through a
 * server-side cursor (`declare … cursor`, `fetch` in pages of
 * STATIC_PACKAGES_PAGE_ROWS) inside one read-only REPEATABLE READ transaction —
 * so every tile is internally consistent and knows the static-data version it
 * corresponds to — and written straight into gzip/brotli files while the sha256
 * is computed on the way. The bytes are exactly what
 * `JSON.stringify(PartitionContent)` produced in the old in-memory builder, so a
 * package hash means the same thing it always has; rows are ordered by id, so
 * the hash is also *stable* (the old builder's order was whatever the heap
 * happened to give it).
 */

export interface BuilderDeps {
  db: Database["db"];
  env: Env;
  store: PackageStore;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

/** Anything that changes *what a package contains* is part of the fingerprint; a different fingerprint makes every package stale. */
export function packageFingerprint(env: Env): string {
  return [
    "v1",
    `res=${env.STATIC_DATA_PARTITION_H3_RESOLUTION}`,
    `cameras=${env.SPEED_CAMERA_NAMESPACE_ENABLED}`,
    `overlay=${env.COMMUNITY_CORRECTIONS_ENABLED}`,
  ].join("|");
}

const LEASE_SECONDS = 120;
const FLUSH_BYTES = 1 << 20;

interface TileResult {
  written: WrittenPackage | null;
  counts: BuiltCounts;
  version: number;
}

let cursorCounter = 0;

/** Streams one entity kind of a tile into the writer as a JSON array body; returns how many rows were kept. */
async function streamEntities<T>(
  tx: Transaction,
  source: { query: SQL; map: (row: Record<string, unknown>) => T },
  keep: (item: T) => boolean,
  write: (text: string) => Promise<void>,
  pageRows: number,
): Promise<number> {
  const cursor = `pkg_cur_${++cursorCounter}`;
  await tx.execute(sql`declare ${sql.raw(cursor)} no scroll cursor for ${source.query}`);
  let kept = 0;
  let buffer: string[] = [];
  let bufferBytes = 0;
  let first = true;
  const flush = async () => {
    if (buffer.length === 0) return;
    await write((first ? "" : ",") + buffer.join(","));
    first = false;
    buffer = [];
    bufferBytes = 0;
  };
  for (;;) {
    const rows = await tx.execute<Record<string, unknown>>(sql`fetch forward ${sql.raw(String(pageRows))} from ${sql.raw(cursor)}`);
    if (rows.length === 0) break;
    for (const row of rows) {
      const item = source.map(row);
      if (!keep(item)) continue;
      const json = JSON.stringify(item);
      buffer.push(json);
      bufferBytes += json.length;
      kept++;
    }
    if (bufferBytes >= FLUSH_BYTES) await flush();
  }
  await flush();
  await tx.execute(sql`close ${sql.raw(cursor)}`);
  return kept;
}

export async function buildTile(deps: BuilderDeps, tile: string): Promise<TileResult> {
  const { db, env, store } = deps;
  const resolution = env.STATIC_DATA_PARTITION_H3_RESOLUTION;
  const envelopes = tileEnvelopes(tile);
  const pageRows = env.STATIC_PACKAGES_PAGE_ROWS;

  return db.transaction(
    async (tx) => {
      // First statement of the snapshot: the version this tile's content corresponds to.
      const version = await currentStaticDataVersion(tx);
      const writer = await store.createWriter(tile);
      try {
        const counts: BuiltCounts = { segments: 0, signs: 0, cameras: 0 };
        await writer.write(`{"tile":${JSON.stringify(tile)},"speedLimitSegments":[`);
        counts.segments = await streamEntities(
          tx,
          tileSpeedLimitSegmentsQuery(envelopes, env.COMMUNITY_CORRECTIONS_ENABLED),
          (segment) => segmentTilesOf(segment.geometry, resolution).has(tile),
          (text) => writer.write(text),
          pageRows,
        );
        await writer.write(`],"staticSigns":[`);
        counts.signs = await streamEntities(
          tx,
          tileStaticSignsQuery(envelopes),
          (sign) => pointTileOf(sign.position, resolution) === tile,
          (text) => writer.write(text),
          pageRows,
        );
        await writer.write(`],"fixedSpeedCameras":[`);
        counts.cameras = env.SPEED_CAMERA_NAMESPACE_ENABLED
          ? await streamEntities(
              tx,
              tileFixedSpeedCamerasQuery(envelopes),
              (camera) => pointTileOf(camera.position, resolution) === tile,
              (text) => writer.write(text),
              pageRows,
            )
          : 0;
        await writer.write("]}");

        if (counts.segments + counts.signs + counts.cameras === 0) {
          await writer.abort();
          return { written: null, counts, version };
        }
        return { written: await writer.finish(), counts, version };
      } catch (err) {
        await writer.abort();
        throw err;
      }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * Populated tiles at the partition resolution, found by descending the H3
 * hierarchy from the 122 base cells and probing each cell's bounding box through
 * the GiST indexes — no full scan, and it works for any data extent. Intermediate
 * levels use a generous envelope (an H3 child may overhang its parent), the last
 * level the tight one; false positives are harmless (they build to an empty tile).
 */
export async function enumerateTiles(deps: BuilderDeps, onLevel?: (resolution: number, cells: number) => void): Promise<string[]> {
  const { db, env } = deps;
  const target = env.STATIC_DATA_PARTITION_H3_RESOLUTION;
  let frontier = rootTiles();
  for (let res = 0; res <= target; res++) {
    const populated: string[] = [];
    for (const tile of frontier) {
      const envelopes = res === target ? tileEnvelopes(tile) : pruningEnvelopes(tile);
      if (await hasStaticDataIn(db, envelopes, env.SPEED_CAMERA_NAMESPACE_ENABLED)) populated.push(tile);
    }
    onLevel?.(res, populated.length);
    if (res === target) return populated;
    frontier = populated.flatMap((tile) => childTiles(tile));
  }
  return [];
}

export interface BuildOptions {
  /** Rebuild every tile, not just the dirty ones. */
  full?: boolean;
  /** Called after each tile. */
  onProgress?: (done: number, total: number, tile: string) => void;
  /** Stop after this many tiles (used by tests and by the worker to stay interruptible). */
  maxTiles?: number;
}

export interface BuildResult {
  status: "built" | "busy";
  tilesBuilt: number;
  tilesFailed: number;
  tilesEmpty: number;
  bytesWritten: number;
  seconds: number;
  ready: boolean;
}

/**
 * Runs a build under the builder lease: (re)establishes the tile set when the
 * fingerprint changed or nothing was ever built, then works through the dirty
 * tiles until none are left. Interruptible and resumable by construction — every
 * tile's state is in the database, so a stopped run simply continues.
 */
export async function runBuild(deps: BuilderDeps, opts: BuildOptions = {}): Promise<BuildResult> {
  const { db, env, store } = deps;
  const owner = `builder-${process.pid}-${randomBytes(4).toString("hex")}`;
  const started = Date.now();
  const result: BuildResult = { status: "busy", tilesBuilt: 0, tilesFailed: 0, tilesEmpty: 0, bytesWritten: 0, seconds: 0, ready: false };

  if (!(await acquireBuildLease(db, owner, LEASE_SECONDS))) return result;
  result.status = "built";
  try {
    const fingerprint = packageFingerprint(env);
    let state = await getPackageState(db);
    if (state.fingerprint !== fingerprint) {
      // A setting that shapes package content changed: every existing package is stale.
      await markAllKnownTilesDirty(db);
      await setPackageState(db, { fingerprint, ready: false });
      state = { ...state, fingerprint, ready: false };
    }
    if (!state.ready || opts.full) {
      const tiles = await enumerateTiles(deps);
      deps.log?.info({ tiles: tiles.length }, "static packages: enumerated populated tiles");
      // A full rebuild also revisits tiles that are no longer populated (they become tombstones).
      // An interrupted first build only adds the tiles it has never seen: the ones already built
      // (or still dirty) keep their state, which is what makes it resumable.
      if (opts.full) await markAllKnownTilesDirty(db);
      const known = await listKnownTiles(db);
      const fresh = tiles.filter((tile) => !known.has(tile));
      for (let i = 0; i < fresh.length; i += 2000) await markTilesDirty(db, fresh.slice(i, i + 2000));
      state = { ...state, ready: false };
    }

    const initial = await countDirtyTiles(db);
    const attempted = new Set<string>();
    let done = 0;
    let stoppedEarly = false;
    for (;;) {
      if (opts.maxTiles !== undefined && done >= opts.maxTiles) {
        stoppedEarly = (await listDirtyTiles(db, 1)).length > 0;
        break;
      }
      const batch = (await listDirtyTiles(db, 200)).filter((t) => !attempted.has(t));
      if (batch.length === 0) break;
      for (const tile of batch) {
        if (opts.maxTiles !== undefined && done >= opts.maxTiles) {
          stoppedEarly = true;
          break;
        }
        attempted.add(tile);
        await acquireBuildLease(db, owner, LEASE_SECONDS);
        try {
          const previous = await findPackageRow(db, tile);
          const built = await buildTile(deps, tile);
          await recordTileBuilt(db, tile, built.written, built.counts, built.version);
          if (built.written) {
            result.bytesWritten += built.written.gzipBytes + built.written.brotliBytes;
            const keep = new Set([built.written.hash]);
            if (previous?.hash) keep.add(previous.hash);
            await store.collect(tile, keep, env.STATIC_PACKAGES_KEEP_MINUTES * 60_000);
          } else {
            result.tilesEmpty++;
            await store.collect(tile, new Set(), env.STATIC_PACKAGES_KEEP_MINUTES * 60_000);
            await store.pruneEmptyTileDir(tile);
          }
          result.tilesBuilt++;
        } catch (err) {
          result.tilesFailed++;
          deps.log?.warn({ err, tile }, "static packages: building a tile failed (it stays dirty and is retried on the next run)");
        }
        done++;
        opts.onProgress?.(done, Math.max(initial.dirty, done), tile);
      }
    }

    // Ready = a complete set exists for this fingerprint: every tile that was dirty when the
    // run started has been built. Tiles marked by writes that landed *during* the run are
    // normal (the next run takes them) and do not make the set incomplete; a failed tile or a
    // run cut short by maxTiles does, unless a complete set already existed.
    const complete = result.tilesFailed === 0 && !stoppedEarly;
    if (state.ready || complete) {
      await setPackageState(db, { fingerprint, ready: true, builtVersion: await currentStaticDataVersion(db) });
      result.ready = true;
    }
  } finally {
    await releaseBuildLease(db, owner);
    result.seconds = (Date.now() - started) / 1000;
  }
  return result;
}
