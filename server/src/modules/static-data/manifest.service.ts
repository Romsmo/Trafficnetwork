import type { Queryable } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { findAllSpeedLimitSegments } from "../../db/queries/speed-limit-segments.js";
import { findAllStaticSigns } from "../../db/queries/static-signs.js";
import { findAllActiveFixedSpeedCameras } from "../../db/queries/fixed-speed-cameras.js";
import { getStaticDataVersion } from "../../db/queries/sync-state.js";
import { buildPartitions, serializePartition } from "./partitions.js";

export interface PartitionSummary {
  tile: string;
  hash: string;
  sizeBytes: number;
}

export interface StaticDataManifest {
  staticDataVersion: number;
  generatedAt: string;
  partitions: PartitionSummary[];
}

interface Cache {
  version: number;
  manifest: StaticDataManifest;
  partitionJson: Map<string, string>;
}

/**
 * In-process cache keyed by static_data_state.version (see
 * db/queries/sync-state.ts) — regenerated only when a write actually bumped
 * that counter, not on a timer. Same "single-instance, in-memory state" scope
 * as modules/realtime/registry.ts; horizontal scaling would need this shared
 * across instances too. Held per database handle (not one module-level slot) so
 * several servers in one process — the multi-node federation tests — never
 * serve each other's packages just because their version counters coincide.
 */
const caches = new WeakMap<object, Cache>();

async function ensureCache(db: Queryable, env: Env): Promise<Cache> {
  const version = await getStaticDataVersion(db);
  const cache = caches.get(db);
  if (cache && cache.version === version) return cache;

  const [speedLimitSegments, staticSigns, fixedSpeedCameras] = await Promise.all([
    findAllSpeedLimitSegments(db, env.COMMUNITY_CORRECTIONS_ENABLED),
    findAllStaticSigns(db),
    env.SPEED_CAMERA_NAMESPACE_ENABLED ? findAllActiveFixedSpeedCameras(db) : Promise.resolve([]),
  ]);

  const partitions = buildPartitions({ speedLimitSegments, staticSigns, fixedSpeedCameras }, env.STATIC_DATA_PARTITION_H3_RESOLUTION);

  const partitionJson = new Map<string, string>();
  const summaries: PartitionSummary[] = [];
  for (const [tile, content] of partitions) {
    const { json, hash, sizeBytes } = serializePartition(content);
    partitionJson.set(tile, json);
    summaries.push({ tile, hash, sizeBytes });
  }
  summaries.sort((a, b) => a.tile.localeCompare(b.tile));

  const fresh: Cache = {
    version,
    manifest: { staticDataVersion: version, generatedAt: new Date().toISOString(), partitions: summaries },
    partitionJson,
  };
  caches.set(db, fresh);
  return fresh;
}

export async function getStaticDataManifest(db: Queryable, env: Env): Promise<StaticDataManifest> {
  return (await ensureCache(db, env)).manifest;
}

/** Pre-serialized JSON string for the tile, or null if it has no static data (not listed in the manifest). */
export async function getStaticDataPartitionJson(db: Queryable, env: Env, tile: string): Promise<string | null> {
  return (await ensureCache(db, env)).partitionJson.get(tile) ?? null;
}
