import { randomBytes } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Database, Transaction } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { tileSpeedLimitSegmentsQuery } from "../../db/queries/speed-limit-segments.js";
import { tileStaticSignsQuery } from "../../db/queries/static-signs.js";
import { findDeviceRecordsInEnvelopes, tileDeviceRecordsQuery } from "../../db/queries/fixed-speed-cameras.js";
import {
  acquireBuildLease,
  countDirtyTiles,
  currentStaticDataVersion,
  findPackageRow,
  getPackageState,
  hasStaticDataIn,
  listDirtyTiles,
  listKnownTiles,
  listPolicyStaleTiles,
  markAllKnownTilesDirty,
  markTilesDirty,
  recordTileBuilt,
  releaseBuildLease,
  setPackageState,
  type BuiltCounts,
} from "../../db/queries/static-packages.js";
import type { PackageStore, WrittenPackage } from "./package-store.js";
import { childTiles, pointTileOf, pruningEnvelopes, rootTiles, segmentTilesOf, tileEnvelopes } from "./tiles.js";
import type { EffectiveCameraPolicy } from "../cameras/policy/policy.js";
import { zoneCellsOfPackageTile } from "../cameras/policy/cells.js";
import { zonesForCells } from "../cameras/policy/projection.js";

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
  /** The camera policy in force (docs/camera-country-policy.md). Asked once per tile, inside the tile's snapshot. */
  policy: () => EffectiveCameraPolicy;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

/**
 * Anything that changes *what a package contains* is part of the fingerprint; a different fingerprint makes every package stale.
 * The camera policy is deliberately not in it: it changes per country, and the tiles it makes stale are marked individually
 * (modules/cameras/policy/sync.ts) instead of rebuilding everything.
 */
export function packageFingerprint(env: Env): string {
  return [
    // v3: country camera policy — tiles may carry a `cameraZones` array. (v2: add-on D — `cameraType`, `enforcementDevices`.)
    "v3",
    `res=${env.STATIC_DATA_PARTITION_H3_RESOLUTION}`,
    `zoneRes=${env.CAMERA_ZONE_H3_RESOLUTION}`,
    `overlay=${env.COMMUNITY_CORRECTIONS_ENABLED}`,
  ].join("|");
}

/**
 * Is a stored fingerprint the one in force? A set built by the previous version with the camera namespace off
 * (`cameras=false`, the default) holds exactly what this version builds while no country is released, so it is not stale -
 * rebuilding a Europe-sized set only to change a label would take the packages offline for hours.
 */
export function isCurrentFingerprint(stored: string | null, env: Env): boolean {
  if (stored === packageFingerprint(env)) return true;
  return stored === `v2|res=${env.STATIC_DATA_PARTITION_H3_RESOLUTION}|cameras=false|overlay=${env.COMMUNITY_CORRECTIONS_ENABLED}`;
}

const LEASE_SECONDS = 120;
const FLUSH_BYTES = 1 << 20;

interface TileResult {
  written: WrittenPackage | null;
  counts: BuiltCounts;
  version: number;
}

let cursorCounter = 0;

/**
 * Streams one entity kind of a tile into the writer as a JSON array body; returns how many rows were kept.
 * With `wrap`, nothing at all is written for zero rows, and otherwise `open`/`close` surround the body — the
 * way an optional key is emitted only when it has content.
 */
async function streamEntities<T>(
  tx: Transaction,
  source: { query: SQL; map: (row: Record<string, unknown>) => T },
  keep: (item: T) => boolean,
  write: (text: string) => Promise<void>,
  pageRows: number,
  wrap?: { open: string; close: string },
  /** What goes into the file for a kept item (default: the item itself). */
  render: (item: T) => unknown = (item) => item,
): Promise<number> {
  const cursor = `pkg_cur_${++cursorCounter}`;
  await tx.execute(sql`declare ${sql.raw(cursor)} no scroll cursor for ${source.query}`);
  let kept = 0;
  let buffer: string[] = [];
  let bufferBytes = 0;
  let first = true;
  const flush = async () => {
    if (buffer.length === 0) return;
    await write((first ? (wrap?.open ?? "") : ",") + buffer.join(","));
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
      const json = JSON.stringify(render(item));
      buffer.push(json);
      bufferBytes += json.length;
      kept++;
    }
    if (bufferBytes >= FLUSH_BYTES) await flush();
  }
  await flush();
  if (wrap && kept > 0) await write(wrap.close);
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
      // After the version, never before: a policy change swaps the policy first and bumps the version second, so a build
      // that saw the new version has certainly seen the new policy (and one that saw the old version is marked dirty again).
      const policy = deps.policy();
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
        // Persistent devices go in only where the policy delivers the individual device (level full of every country it is in).
        const deliverable = (record: { countries: string[] | null; lat: number; lng: number; item: { position: unknown } }) =>
          policy.levelOf(record.countries) === "full" && pointTileOf(record.item.position, resolution) === tile;
        if (policy.anyFull) {
          await streamEntities(
            tx,
            tileDeviceRecordsQuery(envelopes),
            (record) => record.item.cameraType === "fixedSpeedCamera" && deliverable(record),
            (text) => writer.write(text),
            pageRows,
            undefined,
            (record) => record.item,
          );
        }
        await writer.write("]");
        if (policy.anyFull) {
          // Every persistent device of every kind (speed cameras included) — the count that decides whether the tile is empty.
          counts.cameras = await streamEntities(
            tx,
            tileDeviceRecordsQuery(envelopes),
            deliverable,
            (text) => writer.write(text),
            pageRows,
            { open: `,"enforcementDevices":[`, close: "]" },
            (record) => record.item,
          );
        }
        if (policy.anyZones) {
          // Zones of the persistent devices in countries at level `zones`: carried by the tile that is the parent of the zone cell,
          // whichever tile the device itself is in. The key is omitted when there are none, so a tile without zones keeps its bytes.
          const cells = zoneCellsOfPackageTile(tile, policy.zoneResolution);
          const records = await findDeviceRecordsInEnvelopes(tx, cells.flatMap((cell) => tileEnvelopes(cell)));
          const zones = zonesForCells(policy, records, new Set(cells));
          if (zones.length > 0) {
            await writer.write(`,"cameraZones":${JSON.stringify(zones)}`);
            counts.cameras += zones.length;
          }
        }
        await writer.write("}");

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
  const policy = deps.policy();
  let frontier = rootTiles();
  for (let res = 0; res <= target; res++) {
    const populated: string[] = [];
    for (const tile of frontier) {
      const envelopes = res === target ? tileEnvelopes(tile) : pruningEnvelopes(tile);
      // A tile also carries the zones of the cells below it, which may reach a little over its border.
      const cameraEnvelopes = !policy.deliversAnything
        ? null
        : res === target && policy.anyZones
          ? [...envelopes, ...zoneCellsOfPackageTile(tile, policy.zoneResolution).flatMap((cell) => tileEnvelopes(cell))]
          : envelopes;
      if (await hasStaticDataIn(db, envelopes, cameraEnvelopes)) populated.push(tile);
    }
    onLevel?.(res, populated.length);
    if (res === target) return populated;
    frontier = populated.flatMap((tile) => childTiles(tile));
  }
  return [];
}

/**
 * Builds one tile, records it, and collects the files it supersedes. A tile that was stale under the camera policy (it may hold
 * camera data no longer deliverable) keeps none of its old files: unlike an ordinary replacement they are not retained for downloads
 * that are already running, because the content-addressed URL of the old bytes would otherwise keep serving what was withdrawn.
 */
async function buildAndRecordTile(deps: BuilderDeps, tile: string, result: Pick<BuildResult, "bytesWritten" | "tilesEmpty">): Promise<void> {
  const { db, env, store } = deps;
  const previous = await findPackageRow(db, tile);
  const built = await buildTile(deps, tile);
  await recordTileBuilt(db, tile, built.written, built.counts, built.version);
  const graceMs = previous?.policyStale ? 0 : env.STATIC_PACKAGES_KEEP_MINUTES * 60_000;
  if (built.written) {
    result.bytesWritten += built.written.gzipBytes + built.written.brotliBytes;
    const keep = new Set([built.written.hash]);
    if (previous?.hash && !previous.policyStale) keep.add(previous.hash);
    await store.collect(tile, keep, graceMs);
  } else {
    result.tilesEmpty++;
    await store.collect(tile, new Set(), graceMs);
    await store.pruneEmptyTileDir(tile);
  }
}

/**
 * Rebuilds just the tiles that are `policy_stale` - the ones whose packages may hold camera data a stricter policy withdrew - under the
 * builder lease, ahead of any other dirty tile. Until a tile is done its package is not served (modules/static-data/routes.ts), so this
 * runs as soon as the policy changes. A tile that fails stays stale and unserved: failing closed.
 */
export async function rebuildPolicyStale(deps: BuilderDeps): Promise<{ status: "built" | "busy"; tilesBuilt: number; tilesFailed: number }> {
  const { db } = deps;
  const owner = `policy-${process.pid}-${randomBytes(4).toString("hex")}`;
  const outcome = { status: "busy" as "built" | "busy", tilesBuilt: 0, tilesFailed: 0 };
  if (!(await acquireBuildLease(db, owner, LEASE_SECONDS))) return outcome;
  outcome.status = "built";
  const scratch = { bytesWritten: 0, tilesEmpty: 0 };
  const attempted = new Set<string>();
  try {
    for (;;) {
      const batch = (await listPolicyStaleTiles(db, 200)).filter((tile) => !attempted.has(tile));
      if (batch.length === 0) break;
      for (const tile of batch) {
        attempted.add(tile);
        await acquireBuildLease(db, owner, LEASE_SECONDS);
        try {
          await buildAndRecordTile(deps, tile, scratch);
          outcome.tilesBuilt++;
        } catch (err) {
          outcome.tilesFailed++;
          deps.log?.warn({ err, tile }, "static packages: rebuilding a policy-stale tile failed (it stays unserved and is retried)");
        }
      }
    }
  } finally {
    await releaseBuildLease(db, owner);
    // The manifest cache of every process is keyed by this row's timestamp: the packages just changed.
    if (outcome.tilesBuilt > 0) await setPackageState(db, {});
  }
  return outcome;
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
  const { db, env } = deps;
  const owner = `builder-${process.pid}-${randomBytes(4).toString("hex")}`;
  const started = Date.now();
  const result: BuildResult = { status: "busy", tilesBuilt: 0, tilesFailed: 0, tilesEmpty: 0, bytesWritten: 0, seconds: 0, ready: false };

  if (!(await acquireBuildLease(db, owner, LEASE_SECONDS))) return result;
  result.status = "built";
  try {
    const fingerprint = packageFingerprint(env);
    let state = await getPackageState(db);
    if (state.fingerprint !== fingerprint && isCurrentFingerprint(state.fingerprint, env)) {
      // Only the label changed (see isCurrentFingerprint): the set stays valid.
      await setPackageState(db, { fingerprint });
      state = { ...state, fingerprint };
    } else if (state.fingerprint !== fingerprint) {
      // A setting that shapes package content changed: every existing package is stale.
      if (state.fingerprint !== null) {
        deps.log?.warn(
          { from: state.fingerprint, to: fingerprint },
          "static packages: a setting that shapes the packages changed (partition resolution, camera zone resolution or corrections overlay) — every package is rebuilt, and clients holding the old ones must download everything again. All nodes of a network must use the same partition resolution.",
        );
      }
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
          await buildAndRecordTile(deps, tile, result);
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
