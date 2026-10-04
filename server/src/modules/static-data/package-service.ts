import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Database } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import {
  countDirtyTiles,
  countPolicyStale,
  findPackageRow,
  getPackageState,
  listPackageRows,
  markTilesDirty,
  staticRowsAtLeast,
  type PackageRow,
} from "../../db/queries/static-packages.js";
import { PackageStore } from "./package-store.js";
import { isCurrentFingerprint, rebuildPolicyStale, runBuild, type BuilderDeps } from "./package-builder.js";
import { buildEffectivePolicy, type EffectiveCameraPolicy } from "../cameras/policy/policy.js";

/**
 * What the static-data endpoints talk to (add-on E-B, docs/europe-scale.md):
 * decides whether a complete, current package set exists, builds it on demand
 * for small datasets, and renders the manifest from the per-tile state — never
 * from the data itself, so a manifest request costs a couple of small queries
 * however large the dataset is.
 */

export interface ManifestPartition {
  tile: string;
  /** sha256 (hex) of the uncompressed JSON — the identity of the package's content. */
  hash: string;
  /** Uncompressed size. */
  sizeBytes: number;
  gzipBytes: number | null;
  brotliBytes: number | null;
  /** Content-addressed, immutable location of exactly this content. */
  path: string;
}

export interface ManifestBody {
  staticDataVersion: number;
  /**
   * The H3 resolution the tile ids are at. Every node of a network must use the
   * same one; a client that holds packages at another resolution must not mix them
   * with these (the tile ids would not correspond) — it re-bootstraps instead.
   */
  partitionResolution: number;
  generatedAt: string;
  partitions: ManifestPartition[];
  /** Only with `?since=`: tiles that had a package and no longer have one. */
  removed?: string[];
  since?: number;
}

export interface RenderedManifest {
  json: string;
  gzip: Buffer;
  etag: string;
}

export type ManifestResult =
  | { status: "ready"; manifest: RenderedManifest }
  | { status: "building"; reason: string };

function toPartition(row: PackageRow): ManifestPartition {
  return {
    tile: row.tile,
    hash: row.hash!,
    sizeBytes: row.sizeBytes ?? 0,
    gzipBytes: row.gzipBytes,
    brotliBytes: row.brotliBytes,
    path: `/v1/static-data/packages/${row.tile}/${row.hash}`,
  };
}

function render(body: ManifestBody): RenderedManifest {
  const json = JSON.stringify(body);
  return { json, gzip: gzipSync(json), etag: `"${createHash("sha256").update(json).digest("hex").slice(0, 32)}"` };
}

export class StaticPackageService {
  store: PackageStore;
  private inflight: Promise<unknown> | null = null;
  private policyRebuild: Promise<unknown> | null = null;
  private cache: { key: string; manifest: RenderedManifest } | null = null;
  /** The camera policy in force; until an app or a CLI hands one in, nothing camera-related is packaged. */
  private policy: (() => EffectiveCameraPolicy) | null = null;

  constructor(
    private readonly db: Database["db"],
    private env: Env,
    private log?: BuilderDeps["log"],
  ) {
    this.store = StaticPackageService.storeFor(env);
  }

  private static storeFor(env: Env): PackageStore {
    return new PackageStore(env.STATIC_PACKAGES_DIR, {
      brotliQuality: env.STATIC_PACKAGES_BROTLI_QUALITY,
      gzipLevel: env.STATIC_PACKAGES_GZIP_LEVEL,
    });
  }

  /** Several apps in one process (the tests) may share a database handle with different settings; a request always runs with its own app's. */
  use(env: Env, log?: BuilderDeps["log"], policy?: () => EffectiveCameraPolicy): this {
    if (policy) this.policy = policy;
    if (env !== this.env) {
      if (env.STATIC_PACKAGES_DIR !== this.env.STATIC_PACKAGES_DIR) this.store = StaticPackageService.storeFor(env);
      this.env = env;
      this.cache = null;
    }
    if (log) this.log = log;
    return this;
  }

  get builderDeps(): BuilderDeps {
    const env = this.env;
    return { db: this.db, env, store: this.store, log: this.log, policy: this.policy ?? (() => buildEffectivePolicy(env, null)) };
  }

  /** One build at a time per process; concurrent callers wait for the same one. */
  private singleflight<T>(work: () => Promise<T>): Promise<T> {
    if (!this.inflight) {
      this.inflight = work().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight as Promise<T>;
  }

  /**
   * Is a complete package set for the current settings available? Small
   * datasets are built right here (today's behaviour: the first request pays);
   * for a large one this only reports — the worker (or the CLI) builds, and a
   * set that exists but is a little behind is served as it is.
   */
  async ensureFresh(): Promise<{ ready: boolean; reason?: string }> {
    const state = await getPackageState(this.db);
    const current = state.ready && isCurrentFingerprint(state.fingerprint, this.env);
    const dirty = current ? (await countDirtyTiles(this.db)).dirty : 0;
    if (current && dirty === 0) return { ready: true };

    const inlineMax = this.env.STATIC_PACKAGES_INLINE_BUILD_MAX_ROWS;
    const small = (await staticRowsAtLeast(this.db, inlineMax)) <= inlineMax;
    if (small) {
      const result = await this.singleflight(() => runBuild(this.builderDeps));
      if (result.status === "busy") return { ready: current, reason: "another process is building the packages" };
      return { ready: result.ready || current };
    }
    if (current) return { ready: true };
    return { ready: false, reason: "the initial build of the static-data packages is still running" };
  }

  /**
   * Starts the rebuild of the policy-stale tiles (those whose packages may hold camera data a stricter policy withdrew) in the background,
   * unless one is already running. Their packages are not served until it has replaced them, so this is not left to the debounce of the
   * ordinary worker.
   */
  kickPolicyRebuild(): void {
    if (this.policyRebuild) return;
    this.policyRebuild = rebuildPolicyStale(this.builderDeps)
      .catch((err) => this.log?.warn({ err }, "static packages: rebuilding the policy-stale tiles failed"))
      .finally(() => {
        this.policyRebuild = null;
        this.cache = null; // the manifest it rendered lists packages that have just been replaced
      });
  }

  /** Resolves when the policy-stale rebuild that is running (if any) has finished - for tests and shutdown. */
  async idle(): Promise<void> {
    await this.policyRebuild;
  }

  /**
   * Gets the policy-stale tiles rebuilt and reports whether none is left. A small dataset is rebuilt right here (like every other build on
   * demand: the request pays); a large one is rebuilt in the background and the caller answers "building" meanwhile.
   */
  private async settlePolicyStale(): Promise<boolean> {
    if ((await countPolicyStale(this.db)) === 0) return true;
    this.kickPolicyRebuild();
    const inlineMax = this.env.STATIC_PACKAGES_INLINE_BUILD_MAX_ROWS;
    if ((await staticRowsAtLeast(this.db, inlineMax)) > inlineMax) return false;
    await this.policyRebuild;
    return (await countPolicyStale(this.db)) === 0;
  }

  /** Is this tile's package possibly outdated in a way that matters for the camera policy (see static_packages.policy_stale)? */
  async isPolicyStale(tile: string): Promise<boolean> {
    const row = await findPackageRow(this.db, tile);
    if (!row?.policyStale) return false;
    await this.settlePolicyStale();
    return (await findPackageRow(this.db, tile))?.policyStale === true;
  }

  async manifest(since?: number): Promise<ManifestResult> {
    const fresh = await this.ensureFresh();
    if (!fresh.ready) return { status: "building", reason: fresh.reason ?? "packages are being built" };
    // A manifest lists hashes; while any listed package may hold withdrawn camera data it is not offered at all (listing a tile as gone
    // would make a client drop its other data, so the whole answer waits for the rebuild).
    if (!(await this.settlePolicyStale())) {
      return { status: "building", reason: "a change of the camera policy is being applied to the packages" };
    }
    const state = await getPackageState(this.db);

    const key = `${state.updatedAt}|${since ?? ""}`;
    if (this.cache?.key === key) return { status: "ready", manifest: this.cache.manifest };

    const rows = await listPackageRows(this.db, since);
    const body: ManifestBody = {
      staticDataVersion: state.builtVersion,
      partitionResolution: this.env.STATIC_DATA_PARTITION_H3_RESOLUTION,
      generatedAt: new Date(state.updatedAt).toISOString(),
      partitions: rows.filter((r) => r.hash !== null).map(toPartition),
    };
    if (since !== undefined) {
      body.since = since;
      body.removed = rows.filter((r) => r.hash === null).map((r) => r.tile);
    }
    const manifest = render(body);
    if (since === undefined) this.cache = { key, manifest };
    return { status: "ready", manifest };
  }

  /** A package row exists but its file does not: have the builder recreate that tile. */
  async markMissing(tile: string): Promise<void> {
    await markTilesDirty(this.db, [tile]);
  }

  /** The current package of a tile, or null if the tile has none (or none yet). */
  async current(tile: string): Promise<PackageRow | null> {
    const row = await findPackageRow(this.db, tile);
    return row && row.hash ? row : null;
  }
}

const services = new WeakMap<object, StaticPackageService>();

/** One service per database handle (as the old manifest cache was) — so several servers in one process never share packages. */
export function getPackageService(
  db: Database["db"],
  env: Env,
  log?: BuilderDeps["log"],
  policy?: () => EffectiveCameraPolicy,
): StaticPackageService {
  let service = services.get(db);
  if (!service) {
    service = new StaticPackageService(db, env, log);
    services.set(db, service);
  }
  return service.use(env, log, policy);
}
