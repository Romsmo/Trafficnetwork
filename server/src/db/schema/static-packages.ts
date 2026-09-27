import { bigint, boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Pre-built, disk-backed static-data packages (add-on E-B, docs/europe-scale.md).
 * One row per partition tile. The package *files* live in STATIC_PACKAGES_DIR
 * (content-addressed by `hash`); this table is what the manifest is served from
 * and what the builder works through, so neither a manifest request nor a restart
 * ever has to re-read the whole static dataset.
 */
export const staticPackages = pgTable(
  "static_packages",
  {
    tile: text("tile").primaryKey(),
    // sha256 (hex) of the package's uncompressed JSON bytes — the same value the
    // manifest has always exposed as `hash`. Null while the tile has never been
    // built, and for a tile that has become empty (a tombstone: kept so a
    // `?since=` manifest can tell a client to drop it).
    hash: text("hash"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    gzipBytes: bigint("gzip_bytes", { mode: "number" }),
    brotliBytes: bigint("brotli_bytes", { mode: "number" }),
    segmentCount: integer("segment_count"),
    signCount: integer("sign_count"),
    cameraCount: integer("camera_count"),
    // static_data_state.version the tile's content corresponds to (read in the
    // same snapshot as the rows) — what `?since=` filters on.
    builtForVersion: integer("built_for_version"),
    builtAt: timestamp("built_at", { withTimezone: true }),
    // Set by every writer of static data, in the transaction that also bumps
    // static_data_state.version; `dirty_version` is that bumped version. The
    // builder clears the flag only if the version it built for is at least
    // that high, so a write that lands during a build is never lost.
    dirty: boolean("dirty").notNull().default(false),
    dirtyVersion: integer("dirty_version"),
    dirtyMarkedAt: timestamp("dirty_marked_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("static_packages_dirty_idx").on(t.tile).where(sql`dirty`),
    index("static_packages_built_version_idx").on(t.builtForVersion),
  ],
);

/** Single row (id = 1). */
export const staticPackageState = pgTable("static_package_state", {
  id: integer("id").primaryKey(),
  // What the package set was built for (partition resolution, camera namespace,
  // corrections overlay). A different fingerprint means every package is stale.
  fingerprint: text("fingerprint"),
  // True once a full build for `fingerprint` has completed; until then the
  // manifest would be incomplete, so it isn't served.
  ready: boolean("ready").notNull().default(false),
  builtVersion: integer("built_version").notNull().default(0),
  // Lightweight lease so only one process builds at a time (the API process's
  // worker, or the CLI) — see modules/static-data/package-builder.ts.
  leaseOwner: text("lease_owner"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
