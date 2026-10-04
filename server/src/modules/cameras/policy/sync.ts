import { sql, type SQL } from "drizzle-orm";
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
 * affected tiles stale. Only the tiles that hold cameras of a country whose level changed are marked, not the whole set -
 * restricting one country must not make every client download everything again. The state the packages correspond to is
 * stored in `static_data_state.camera_policy`, so a change made while the node was down (the signed file was replaced, then
 * the node started) is found at start-up exactly like a change made while it runs.
 */

export interface StoredCameraPolicy {
  defaultLevel: CameraLevel;
  unknownLevel: CameraLevel;
  /** Effective levels of the countries that differ from `defaultLevel`. */
  byCountry: Record<string, CameraLevel>;
  zoneResolution: number;
}

/** What a change touches: named countries, every country (the default level or the zone size changed), and/or cameras without a known country. */
interface Scope {
  countries: string[];
  all: boolean;
  unknown: boolean;
}

export interface PolicySyncResult {
  changedCountries: string[];
  /** The default level (of every country not named) or the level of cameras without a known country changed. */
  defaultChanged: boolean;
  tilesMarked: number;
  /**
   * Of those, the tiles whose built package may hold camera data that is no longer deliverable (a level got stricter): they are
   * marked `policy_stale` and not served until rebuilt (docs/camera-country-policy.md, section 7).
   */
  staleTiles: number;
}

function toStored(policy: EffectiveCameraPolicy): StoredCameraPolicy {
  return { defaultLevel: policy.defaultLevel, unknownLevel: policy.unknownLevel, byCountry: { ...policy.byCountry }, zoneResolution: policy.zoneResolution };
}

function parseStored(value: unknown): StoredCameraPolicy | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Record<keyof StoredCameraPolicy, unknown>>;
  if (!isCameraLevel(raw.defaultLevel) || !isCameraLevel(raw.unknownLevel) || typeof raw.zoneResolution !== "number") return null;
  if (!raw.byCountry || typeof raw.byCountry !== "object") return null;
  const byCountry: Record<string, CameraLevel> = {};
  for (const [country, level] of Object.entries(raw.byCountry as Record<string, unknown>)) if (isCameraLevel(level)) byCountry[country] = level;
  return { defaultLevel: raw.defaultLevel, unknownLevel: raw.unknownLevel, byCountry, zoneResolution: raw.zoneResolution };
}

export async function readStoredCameraPolicy(db: Queryable): Promise<StoredCameraPolicy | null> {
  const rows = await db.execute<{ camera_policy: unknown } & Record<string, unknown>>(sql`select camera_policy from static_data_state where id = 1`);
  return parseStored(rows[0]?.camera_policy);
}

const levelIn = (policy: StoredCameraPolicy, country: string): CameraLevel => policy.byCountry[country] ?? policy.defaultLevel;
const isStricter = (to: CameraLevel, from: CameraLevel): boolean => from !== to && stricter(from, to) === to;

/** What got stricter and what got more generous between two policies. */
export function diffPolicies(before: StoredCameraPolicy, after: StoredCameraPolicy): { tightened: Scope; loosened: Scope } {
  const tightened: Scope = { countries: [], all: false, unknown: false };
  const loosened: Scope = { countries: [], all: false, unknown: false };

  // A different zone size changes what every zone is: all of it is stale.
  if (before.zoneResolution !== after.zoneResolution) tightened.all = true;

  if (before.defaultLevel !== after.defaultLevel) (isStricter(after.defaultLevel, before.defaultLevel) ? tightened : loosened).all = true;
  if (before.unknownLevel !== after.unknownLevel) (isStricter(after.unknownLevel, before.unknownLevel) ? tightened : loosened).unknown = true;

  for (const country of new Set([...Object.keys(before.byCountry), ...Object.keys(after.byCountry)])) {
    const from = levelIn(before, country);
    const to = levelIn(after, country);
    if (from !== to) (isStricter(to, from) ? tightened : loosened).countries.push(country);
  }
  tightened.countries.sort();
  loosened.countries.sort();
  return { tightened, loosened };
}

const isEmpty = (scope: Scope) => scope.countries.length === 0 && !scope.all && !scope.unknown;

/**
 * Compares the policy in force with the one the packages were last synced to; if they differ, marks the package tiles of the
 * affected cameras dirty (stale where something got stricter), bumps the static-data version once, and records the new
 * state - one transaction. Idempotent: nothing changed, nothing written.
 */
export async function syncCameraPolicy(db: Database["db"], env: Env, policy: EffectiveCameraPolicy): Promise<PolicySyncResult> {
  const next = toStored(policy);
  return db.transaction(async (tx) => {
    // Lock the row: two nodes of one database (or a restart racing a reload) must not both sync from the same "before".
    const rows = await tx.execute<{ camera_policy: unknown } & Record<string, unknown>>(sql`select camera_policy from static_data_state where id = 1 for update`);
    const stored = parseStored(rows[0]?.camera_policy);
    // Never synced before = nothing was delivered under a policy (the version before the country policy delivered no cameras unless its
    // switch was on, and a package set built with it on is rebuilt anyway - see isCurrentFingerprint): whatever is delivered now is new.
    const before: StoredCameraPolicy = stored ?? { defaultLevel: "off", unknownLevel: "off", byCountry: {}, zoneResolution: next.zoneResolution };
    const { tightened, loosened } = diffPolicies(before, next);
    const result: PolicySyncResult = {
      changedCountries: [...new Set([...tightened.countries, ...loosened.countries])].sort(),
      defaultChanged: tightened.all || loosened.all || tightened.unknown || loosened.unknown,
      tilesMarked: 0,
      staleTiles: 0,
    };
    if (isEmpty(tightened) && isEmpty(loosened) && stored !== null) return result;

    const stale = await tilesOf(tx, env, tightened, policy.zoneResolution);
    const staleSet = new Set(stale);
    const fresh = (await tilesOf(tx, env, loosened, policy.zoneResolution)).filter((tile) => !staleSet.has(tile));
    if (!isEmpty(tightened) || !isEmpty(loosened)) await bumpStaticDataVersion(tx);
    for (let i = 0; i < stale.length; i += 2000) await markTilesDirty(tx, stale.slice(i, i + 2000), { policyStale: true });
    for (let i = 0; i < fresh.length; i += 2000) await markTilesDirty(tx, fresh.slice(i, i + 2000));
    await tx.execute(sql`update static_data_state set camera_policy = ${JSON.stringify(next)}::jsonb where id = 1`);
    return { ...result, tilesMarked: stale.length + fresh.length, staleTiles: stale.length };
  });
}

/** Package tiles that contain (or carry the zone of) an active persistent device in the scope of a change. */
async function tilesOf(db: Queryable, env: Env, scope: Scope, zoneResolution: number): Promise<string[]> {
  if (isEmpty(scope)) return [];
  const conditions: SQL[] = [];
  if (scope.countries.length > 0) conditions.push(sql`countries && ${pgArray(scope.countries)}::text[]`);
  if (scope.unknown) conditions.push(sql`countries is null or cardinality(countries) = 0`);
  const where = scope.all ? sql`true` : sql`(${sql.join(conditions, sql` or `)})`;
  const rows = await db.execute<{ lat: number; lng: number } & Record<string, unknown>>(sql`
    select ST_Y(position) as lat, ST_X(position) as lng
    from fixed_speed_cameras
    where status = 'active' and ${where}
  `);
  const tiles = new Set<string>();
  for (const row of rows) {
    for (const tile of cameraPackageTiles(Number(row.lat), Number(row.lng), env.STATIC_DATA_PARTITION_H3_RESOLUTION, zoneResolution)) tiles.add(tile);
  }
  return [...tiles];
}
