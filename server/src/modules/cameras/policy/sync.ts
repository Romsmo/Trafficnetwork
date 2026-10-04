import { sql } from "drizzle-orm";
import type { Database, Queryable } from "../../../db/client.js";
import type { Env } from "../../../config/env.js";
import { bumpStaticDataVersion } from "../../../db/queries/sync-state.js";
import { markTilesDirty } from "../../../db/queries/static-packages.js";
import { pgArray } from "../../../db/pg-array.js";
import { cameraPackageTiles } from "./cells.js";
import { isCameraLevel, stricter, type CameraLevel } from "./levels.js";
import type { EffectiveCameraPolicy } from "./policy.js";

/**
 * Brings the static-data packages in line with the camera policy (docs/camera-country-policy.md, section 7).
 *
 * The packages are built from the policy that was in force when each tile was built, so a policy change has to make the
 * affected tiles stale. Only the tiles that hold cameras of a country whose level changed are marked, not the whole set —
 * withdrawing a policy for one country must not make every client download everything again. The state the packages
 * correspond to is stored in `static_data_state.camera_policy`, so a change made while the node was down (the signed file
 * was replaced, then the node started) is found at start-up exactly like a change made while it runs.
 */

export interface StoredCameraPolicy {
  /** Effective levels above `off` at the time of the last sync; every other country was `off`. */
  byCountry: Record<string, CameraLevel>;
  zoneResolution: number;
}

export interface PolicySyncResult {
  changedCountries: string[];
  tilesMarked: number;
  /**
   * Of those, the tiles whose built package may hold camera data that is no longer deliverable (a country got stricter): they are
   * marked `policy_stale` and not served until rebuilt (docs/camera-country-policy.md, section 7).
   */
  staleTiles: number;
}

/** Did the level of this country go down (off < zones < full)? */
function tightened(before: StoredCameraPolicy, after: StoredCameraPolicy, country: string): boolean {
  const from = before.byCountry[country] ?? "off";
  const to = after.byCountry[country] ?? "off";
  return from !== to && stricter(from, to) === to;
}

function toStored(policy: EffectiveCameraPolicy): StoredCameraPolicy {
  const byCountry: Record<string, CameraLevel> = {};
  for (const [country, level] of Object.entries(policy.byCountry)) if (level !== "off") byCountry[country] = level;
  return { byCountry, zoneResolution: policy.zoneResolution };
}

function parseStored(value: unknown): StoredCameraPolicy | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { byCountry?: unknown; zoneResolution?: unknown };
  if (!raw.byCountry || typeof raw.byCountry !== "object" || typeof raw.zoneResolution !== "number") return null;
  const byCountry: Record<string, CameraLevel> = {};
  for (const [country, level] of Object.entries(raw.byCountry as Record<string, unknown>)) {
    if (isCameraLevel(level) && level !== "off") byCountry[country] = level;
  }
  return { byCountry, zoneResolution: raw.zoneResolution };
}

export async function readStoredCameraPolicy(db: Queryable): Promise<StoredCameraPolicy | null> {
  const rows = await db.execute<{ camera_policy: unknown } & Record<string, unknown>>(sql`select camera_policy from static_data_state where id = 1`);
  return parseStored(rows[0]?.camera_policy);
}

/** Countries whose effective level differs between two policies. */
export function changedCountries(before: StoredCameraPolicy | null, after: StoredCameraPolicy): string[] {
  const a = before?.byCountry ?? {};
  const countries = new Set([...Object.keys(a), ...Object.keys(after.byCountry)]);
  return [...countries].filter((country) => (a[country] ?? "off") !== (after.byCountry[country] ?? "off")).sort();
}

/**
 * Compares the policy in force with the one the packages were last synced to; if they differ, marks the package tiles of the
 * changed countries' cameras dirty, bumps the static-data version once, and records the new state — one transaction.
 * Idempotent: nothing changed, nothing written.
 */
export async function syncCameraPolicy(db: Database["db"], env: Env, policy: EffectiveCameraPolicy): Promise<PolicySyncResult> {
  const next = toStored(policy);
  return db.transaction(async (tx) => {
    // Lock the row: two nodes of one database (or a restart racing a reload) must not both sync from the same "before".
    const rows = await tx.execute<{ camera_policy: unknown } & Record<string, unknown>>(sql`select camera_policy from static_data_state where id = 1 for update`);
    const stored = parseStored(rows[0]?.camera_policy);
    // Never synced before = "nothing was delivered under a policy" = the empty policy: whatever the signed file lists now is new.
    const before = stored ?? { byCountry: {}, zoneResolution: next.zoneResolution };
    const resolutionChanged = before.zoneResolution !== next.zoneResolution;
    const changed = resolutionChanged ? [...new Set([...Object.keys(before.byCountry), ...Object.keys(next.byCountry)])].sort() : changedCountries(before, next);
    if (changed.length === 0 && stored !== null) return { changedCountries: [], tilesMarked: 0, staleTiles: 0 };

    let stale: string[] = [];
    let fresh: string[] = [];
    if (changed.length > 0) {
      // A zone resolution change alters what every zone is: all of it is stale. Otherwise only a country that got stricter is.
      const tightenedCountries = changed.filter((country) => resolutionChanged || tightened(before, next, country));
      stale = await tilesOfCountries(tx, env, tightenedCountries, policy.zoneResolution);
      const staleSet = new Set(stale);
      fresh = (await tilesOfCountries(tx, env, changed.filter((c) => !tightenedCountries.includes(c)), policy.zoneResolution)).filter((t) => !staleSet.has(t));
      await bumpStaticDataVersion(tx);
      for (let i = 0; i < stale.length; i += 2000) await markTilesDirty(tx, stale.slice(i, i + 2000), { policyStale: true });
      for (let i = 0; i < fresh.length; i += 2000) await markTilesDirty(tx, fresh.slice(i, i + 2000));
    }
    await tx.execute(sql`update static_data_state set camera_policy = ${JSON.stringify(next)}::jsonb where id = 1`);
    return { changedCountries: changed, tilesMarked: stale.length + fresh.length, staleTiles: stale.length };
  });
}

/** Package tiles that contain (or carry the zone of) an active persistent device of one of these countries. */
async function tilesOfCountries(db: Queryable, env: Env, countries: string[], zoneResolution: number): Promise<string[]> {
  if (countries.length === 0) return [];
  const rows = await db.execute<{ lat: number; lng: number } & Record<string, unknown>>(sql`
    select ST_Y(position) as lat, ST_X(position) as lng
    from fixed_speed_cameras
    where status = 'active' and countries && ${pgArray(countries)}::text[]
  `);
  const tiles = new Set<string>();
  for (const row of rows) {
    for (const tile of cameraPackageTiles(Number(row.lat), Number(row.lng), env.STATIC_DATA_PARTITION_H3_RESOLUTION, zoneResolution)) tiles.add(tile);
  }
  return [...tiles];
}
