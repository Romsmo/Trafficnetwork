import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import type { Envelope } from "../../lib/geo-bbox.js";
import { envelopeOverlap } from "../../lib/geo-bbox.js";
import { pgArray } from "../pg-array.js";

/**
 * Persistence for the disk-backed static-data packages (add-on E-B,
 * docs/europe-scale.md): the per-tile state the manifest is served from, the
 * dirty marks every static-data writer sets, the lease that keeps two processes
 * from building at once, and the probes used to find populated tiles.
 */

export interface PackageStateRow {
  fingerprint: string | null;
  ready: boolean;
  builtVersion: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  updatedAt: string;
}

export async function getPackageState(db: Queryable): Promise<PackageStateRow> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select fingerprint, ready, built_version, lease_owner, lease_until, updated_at from static_package_state where id = 1
  `);
  const r = rows[0];
  if (!r) throw new Error("static_package_state row missing (id=1) — run the migrations");
  return {
    fingerprint: (r["fingerprint"] as string | null) ?? null,
    ready: r["ready"] as boolean,
    builtVersion: r["built_version"] as number,
    leaseOwner: (r["lease_owner"] as string | null) ?? null,
    leaseUntil: (r["lease_until"] as string | null) ?? null,
    updatedAt: r["updated_at"] as string,
  };
}

export async function setPackageState(db: Queryable, patch: { fingerprint?: string | null; ready?: boolean; builtVersion?: number }): Promise<void> {
  await db.execute(sql`
    update static_package_state set
      fingerprint = ${patch.fingerprint === undefined ? sql`fingerprint` : patch.fingerprint},
      ready = ${patch.ready === undefined ? sql`ready` : patch.ready},
      built_version = ${patch.builtVersion === undefined ? sql`built_version` : patch.builtVersion},
      updated_at = now()
    where id = 1
  `);
}

/** Takes (or renews) the builder lease; false if another live owner holds it. */
export async function acquireBuildLease(db: Queryable, owner: string, ttlSeconds: number): Promise<boolean> {
  const rows = await db.execute<{ id: number } & Record<string, unknown>>(sql`
    update static_package_state
    set lease_owner = ${owner}, lease_until = now() + make_interval(secs => ${ttlSeconds})
    where id = 1 and (lease_owner is null or lease_owner = ${owner} or lease_until is null or lease_until < now())
    returning id
  `);
  return rows.length > 0;
}

export async function releaseBuildLease(db: Queryable, owner: string): Promise<void> {
  await db.execute(sql`update static_package_state set lease_owner = null, lease_until = null where id = 1 and lease_owner = ${owner}`);
}

/**
 * Marks tiles as needing a rebuild. Must run in the same transaction as — and
 * after — the write that bumped static_data_state.version, because the version
 * it reads here (its own, uncommitted bump) is what the builder compares
 * against: it clears the mark only if it built from a snapshot at or after it.
 */
export async function markTilesDirty(tx: Queryable, tiles: readonly string[]): Promise<void> {
  if (tiles.length === 0) return;
  await tx.execute(sql`
    insert into static_packages (tile, dirty, dirty_version, dirty_marked_at)
    select t, true, (select version from static_data_state where id = 1), now()
    from unnest(${pgArray(tiles)}::text[]) as t
    on conflict (tile) do update set dirty = true, dirty_version = excluded.dirty_version, dirty_marked_at = now()
  `);
}

/** Every known tile becomes dirty (the build fingerprint changed, or an operator asked for a full rebuild). */
export async function markAllKnownTilesDirty(db: Queryable): Promise<number> {
  const rows = await db.execute<{ tile: string } & Record<string, unknown>>(sql`
    update static_packages
    set dirty = true, dirty_version = (select version from static_data_state where id = 1), dirty_marked_at = now()
    returning tile
  `);
  return rows.length;
}

export async function countDirtyTiles(db: Queryable): Promise<{ dirty: number; oldestMarkedAt: string | null; newestMarkedAt: string | null }> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select count(*)::int as dirty, min(dirty_marked_at) as oldest, max(dirty_marked_at) as newest from static_packages where dirty
  `);
  const r = rows[0]!;
  return { dirty: r["dirty"] as number, oldestMarkedAt: (r["oldest"] as string | null) ?? null, newestMarkedAt: (r["newest"] as string | null) ?? null };
}

/** Every tile the package table has ever heard of (built, dirty or tombstoned). */
export async function listKnownTiles(db: Queryable): Promise<Set<string>> {
  const rows = await db.execute<{ tile: string } & Record<string, unknown>>(sql`select tile from static_packages`);
  return new Set(rows.map((r) => r.tile));
}

export async function listDirtyTiles(db: Queryable, limit: number): Promise<string[]> {
  const rows = await db.execute<{ tile: string } & Record<string, unknown>>(sql`
    select tile from static_packages where dirty order by dirty_marked_at, tile limit ${limit}
  `);
  return rows.map((r) => r.tile);
}

export interface PackageRow {
  tile: string;
  hash: string | null;
  sizeBytes: number | null;
  gzipBytes: number | null;
  brotliBytes: number | null;
  segmentCount: number | null;
  signCount: number | null;
  cameraCount: number | null;
  builtForVersion: number | null;
  dirty: boolean;
}

function toPackageRow(r: Record<string, unknown>): PackageRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    tile: r["tile"] as string,
    hash: (r["hash"] as string | null) ?? null,
    sizeBytes: num(r["size_bytes"]),
    gzipBytes: num(r["gzip_bytes"]),
    brotliBytes: num(r["brotli_bytes"]),
    segmentCount: num(r["segment_count"]),
    signCount: num(r["sign_count"]),
    cameraCount: num(r["camera_count"]),
    builtForVersion: num(r["built_for_version"]),
    dirty: r["dirty"] as boolean,
  };
}

const PACKAGE_COLUMNS = sql`tile, hash, size_bytes, gzip_bytes, brotli_bytes, segment_count, sign_count, camera_count, built_for_version, dirty`;

/** Rows for the manifest: with `since`, only tiles built after that version (including tombstones, so a client learns a tile went away). */
export async function listPackageRows(db: Queryable, since?: number): Promise<PackageRow[]> {
  const rows = await db.execute<Record<string, unknown>>(
    since === undefined
      ? sql`select ${PACKAGE_COLUMNS} from static_packages where hash is not null order by tile`
      : sql`select ${PACKAGE_COLUMNS} from static_packages where built_for_version > ${since} order by tile`,
  );
  return rows.map(toPackageRow);
}

export async function findPackageRow(db: Queryable, tile: string): Promise<PackageRow | null> {
  const rows = await db.execute<Record<string, unknown>>(sql`select ${PACKAGE_COLUMNS} from static_packages where tile = ${tile}`);
  return rows[0] ? toPackageRow(rows[0]) : null;
}

export interface BuiltCounts {
  segments: number;
  signs: number;
  cameras: number;
}

/**
 * Records a finished build of one tile. `written` null means the tile came out
 * empty (kept as a tombstone). The dirty mark is cleared only if the build's
 * snapshot version covers it — a write that landed after the snapshot keeps the
 * tile dirty for the next round.
 */
export async function recordTileBuilt(
  tx: Queryable,
  tile: string,
  written: { hash: string; sizeBytes: number; gzipBytes: number; brotliBytes: number } | null,
  counts: BuiltCounts,
  builtForVersion: number,
): Promise<void> {
  await tx.execute(sql`
    insert into static_packages
      (tile, hash, size_bytes, gzip_bytes, brotli_bytes, segment_count, sign_count, camera_count, built_for_version, built_at, dirty, dirty_version)
    values (
      ${tile}, ${written?.hash ?? null}, ${written?.sizeBytes ?? null}, ${written?.gzipBytes ?? null}, ${written?.brotliBytes ?? null},
      ${counts.segments}, ${counts.signs}, ${counts.cameras}, ${builtForVersion}, now(), false, null
    )
    on conflict (tile) do update set
      hash = excluded.hash, size_bytes = excluded.size_bytes, gzip_bytes = excluded.gzip_bytes, brotli_bytes = excluded.brotli_bytes,
      segment_count = excluded.segment_count, sign_count = excluded.sign_count, camera_count = excluded.camera_count,
      built_for_version = excluded.built_for_version, built_at = now(),
      dirty = (static_packages.dirty and coalesce(static_packages.dirty_version, 0) > ${builtForVersion}),
      dirty_version = case when static_packages.dirty and coalesce(static_packages.dirty_version, 0) > ${builtForVersion}
                           then static_packages.dirty_version else null end
  `);
}

export async function currentStaticDataVersion(db: Queryable): Promise<number> {
  const rows = await db.execute<{ version: number } & Record<string, unknown>>(sql`select version from static_data_state where id = 1`);
  return rows[0]?.version ?? 1;
}

/**
 * Cheap bound on the size of the static dataset: counts up to `cap + 1` rows
 * per table, so it never scans a Europe-sized table. Used to decide between an
 * inline package build and the background worker, and to protect /v1/snapshot.
 */
export async function staticRowsAtLeast(db: Queryable, cap: number): Promise<number> {
  const rows = await db.execute<{ n: number } & Record<string, unknown>>(sql`
    select (
      (select count(*) from (select 1 from speed_limit_segments limit ${cap + 1}) a) +
      (select count(*) from (select 1 from static_signs limit ${cap + 1}) b) +
      (select count(*) from (select 1 from fixed_speed_cameras limit ${cap + 1}) c)
    )::int as n
  `);
  return rows[0]?.n ?? 0;
}

/**
 * Row count of the static tables from the planner's statistics — free, and good
 * enough for "is this dataset huge?" (autovacuum refreshes it after every large
 * import). A table Postgres has never analysed reports -1; then the bounded exact
 * count above decides, which is cheap precisely because such a table is small.
 */
export async function estimateStaticRows(db: Queryable, cap: number): Promise<number> {
  const rows = await db.execute<{ n: string; unanalyzed: boolean | null } & Record<string, unknown>>(sql`
    select coalesce(sum(greatest(c.reltuples, 0)), 0)::bigint as n, coalesce(bool_or(c.reltuples < 0), false) as unanalyzed
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = current_schema() and c.relkind = 'r'
      and c.relname in ('speed_limit_segments', 'static_signs', 'fixed_speed_cameras')
  `);
  const r = rows[0];
  if (!r || r.unanalyzed) return staticRowsAtLeast(db, cap);
  return Number(r.n);
}

/** True if any static data (segment, sign, or — when they are packaged — an active camera) overlaps the envelopes. Used to prune the tile enumeration. */
export async function hasStaticDataIn(db: Queryable, envelopes: readonly Envelope[], includeCameras: boolean): Promise<boolean> {
  const rows = await db.execute<{ found: boolean } & Record<string, unknown>>(sql`
    select (
      exists (select 1 from speed_limit_segments s where ${envelopeOverlap(sql`s.geometry`, envelopes)})
      or exists (select 1 from static_signs g where ${envelopeOverlap(sql`g.position`, envelopes)})
      ${includeCameras ? sql`or exists (select 1 from fixed_speed_cameras c where c.status = 'active' and ${envelopeOverlap(sql`c.position`, envelopes)})` : sql``}
    ) as found
  `);
  return rows[0]?.found === true;
}
