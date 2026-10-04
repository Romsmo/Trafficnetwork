import { sql } from "drizzle-orm";
import { CAMERA_NAMESPACE_TYPES } from "../../../config/constants.js";
import type { Queryable } from "../../../db/client.js";
import { pgArray } from "../../../db/pg-array.js";
import { markTilesDirty } from "../../../db/queries/static-packages.js";
import { bumpStaticDataVersion } from "../../../db/queries/sync-state.js";
import { cameraPackageTiles } from "./cells.js";

/**
 * Country boundaries and the country sets computed from them (docs/camera-country-policy.md, section 3). The server ships no
 * geodata: the operator loads a GeoJSON file of countries (npm run cameras -- load-boundaries), and every camera's country
 * set - the countries within CAMERA_POLICY_BORDER_MARGIN_M of it - is computed from that table by the SQL function
 * camera_countries(). Used by scripts/cameras.mts and by the tests.
 */

const PROPERTY_CANDIDATES = ["ISO_A2_EH", "ISO_A2", "iso_a2", "ISO3166-1-Alpha-2", "cc"];
const SUBDIVIDE_MAX_VERTICES = 256;
const BATCH = 5000;

export interface GeoFeature {
  type: "Feature";
  properties?: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}

export function isoOf(feature: GeoFeature, property: string | undefined): string | null {
  const props = feature.properties ?? {};
  for (const name of property ? [property] : PROPERTY_CANDIDATES) {
    const value = props[name];
    if (typeof value === "string" && /^[A-Za-z]{2}$/.test(value.trim())) return value.trim().toUpperCase();
  }
  return null;
}

export interface UsableFeature {
  iso2: string;
  geometry: string;
}

export interface ParsedBoundaries {
  usable: UsableFeature[];
  /** Features that cannot be used, described for the operator. A dataset with any of these is refused as a whole. */
  unusable: string[];
}

/** Reads a GeoJSON FeatureCollection of countries. Never partly: the caller refuses the dataset if anything is unusable. */
export function parseBoundaryCollection(raw: Buffer | string, property?: string): ParsedBoundaries {
  const collection = JSON.parse(raw.toString()) as { type?: string; features?: GeoFeature[] };
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error("The file is not a GeoJSON FeatureCollection");
  }
  const usable: UsableFeature[] = [];
  const unusable: string[] = [];
  for (const feature of collection.features) {
    const label = JSON.stringify(feature.properties ?? {}).slice(0, 120);
    const iso2 = isoOf(feature, property);
    if (!feature.geometry || !["Polygon", "MultiPolygon"].includes(feature.geometry.type)) {
      unusable.push(`no polygon geometry: ${label}`);
    } else if (!iso2) {
      unusable.push(`no two-letter country code (try --property): ${label}`);
    } else {
      usable.push({ iso2, geometry: JSON.stringify(feature.geometry) });
    }
  }
  return { usable, unusable };
}

/** Replaces the boundary table with these countries, stored subdivided (so camera_countries() is an index probe over small shapes). */
export async function storeBoundaries(db: Queryable, usable: readonly UsableFeature[], meta: { dataset: string; contentHash: string }): Promise<void> {
  if (usable.length === 0) throw new Error("The dataset holds no features.");
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from country_boundary_parts`);
    for (const { iso2, geometry } of usable) {
      await tx.execute(sql`
        insert into country_boundary_parts (iso2, geom)
        select ${iso2}, d.geom
        from (
          select (st_dump(st_subdivide(st_collectionextract(st_makevalid(st_setsrid(st_geomfromgeojson(${geometry}), 4326)), 3), ${SUBDIVIDE_MAX_VERTICES}))).geom as geom
        ) d
        where st_geometrytype(d.geom) = 'ST_Polygon' and not st_isempty(d.geom)
      `);
    }
    await tx.execute(sql`analyze country_boundary_parts`);
    await tx.execute(sql`
      insert into country_boundary_state (id, dataset, features, loaded_at, margin_m, content_hash)
      values (1, ${meta.dataset}, ${usable.length}, now(), null, ${meta.contentHash})
      on conflict (id) do update set dataset = excluded.dataset, features = excluded.features, loaded_at = excluded.loaded_at,
        margin_m = null, content_hash = excluded.content_hash
    `);
  });
}

export interface ResolveResult {
  devices: number;
  reports: number;
  events: number;
  /** Package tiles marked for rebuild. */
  tiles: number;
  /** Of those, tiles of cameras whose already-known country set changed: their packages may hold what is no longer deliverable, so they are not served until rebuilt. */
  staleTiles: number;
}

/** Computes the country sets that are missing (or all of them) and marks the packages of the cameras it touched. */
export async function resolveCountries(db: Queryable, marginM: number, opts: { all: boolean; partitionRes: number; zoneRes: number }): Promise<ResolveResult> {
  const tiles = new Set<string>();
  // A camera whose country set was already known and now differs may have been packaged under the old one (it could have been deliverable
  // and no longer be): its tiles are marked policy-stale. A camera that had no set yet was never deliverable, so its tiles are only dirty.
  const staleTiles = new Set<string>();
  const cameraTypes = pgArray([...CAMERA_NAMESPACE_TYPES]);
  const NIL_UUID = "00000000-0000-0000-0000-000000000000";

  // Keyset pagination by id, so --all makes progress even though the rows it has done still match.
  let devices = 0;
  for (let last = NIL_UUID; ; ) {
    const rows = await db.execute<{ id: string; lat: number; lng: number; previous: string[] | null; current: string[] | null } & Record<string, unknown>>(sql`
      with batch as (
        select id, countries as previous from fixed_speed_cameras
        where id > ${last}::uuid ${opts.all ? sql`` : sql`and countries is null`}
        order by id limit ${BATCH}
        for update
      )
      update fixed_speed_cameras c set countries = camera_countries(c.position, ${marginM}::float8)
      from batch where c.id = batch.id
      returning c.id, ST_Y(c.position) as lat, ST_X(c.position) as lng, batch.previous as previous, c.countries as current
    `);
    if (rows.length === 0) break;
    devices += rows.length;
    for (const row of rows) {
      const changedKnownSet = row.previous !== null && JSON.stringify(row.previous) !== JSON.stringify(row.current);
      for (const tile of cameraPackageTiles(Number(row.lat), Number(row.lng), opts.partitionRes, opts.zoneRes)) {
        tiles.add(tile);
        if (changedKnownSet) staleTiles.add(tile);
      }
      if (row.id > last) last = row.id;
    }
    if (rows.length < BATCH) break;
  }

  let reports = 0;
  for (let last = NIL_UUID; ; ) {
    const rows = await db.execute<{ id: string } & Record<string, unknown>>(sql`
      update hazard_reports h set countries = camera_countries(h.position, ${marginM}::float8)
      where h.id in (
        select id from hazard_reports
        where id > ${last}::uuid and type = any(${cameraTypes}::hazard_type[]) ${opts.all ? sql`` : sql`and countries is null`}
        order by id limit ${BATCH}
      )
      returning h.id
    `);
    if (rows.length === 0) break;
    reports += rows.length;
    for (const row of rows) if (row.id > last) last = row.id;
    if (rows.length < BATCH) break;
  }

  // Events of the retained log carry the country set of the entity they are about (event_log.camera_countries): copy it from the
  // entity, which was resolved above. An event whose entity is gone stays unresolved = never delivered.
  let events = 0;
  for (let after = 0; ; ) {
    const batch = await db.execute<{ sequence: number } & Record<string, unknown>>(sql`
      select sequence from event_log
      where sequence > ${after} and entity_type in ('fixedSpeedCamera', 'enforcementDevice', 'hazardReport') ${opts.all ? sql`` : sql`and camera_countries is null`}
      order by sequence limit ${BATCH}
    `);
    if (batch.length === 0) break;
    const sequences = batch.map((row) => Number(row.sequence));
    after = sequences[sequences.length - 1]!;
    const fromDevices = await db.execute<{ sequence: number } & Record<string, unknown>>(sql`
      update event_log e set camera_countries = c.countries
      from fixed_speed_cameras c
      where e.sequence = any(${pgArray(sequences.map(String))}::bigint[]) and e.entity_type in ('fixedSpeedCamera', 'enforcementDevice') and c.id = e.entity_id
      returning e.sequence
    `);
    const fromReports = await db.execute<{ sequence: number } & Record<string, unknown>>(sql`
      update event_log e set camera_countries = h.countries
      from hazard_reports h
      where e.sequence = any(${pgArray(sequences.map(String))}::bigint[]) and e.entity_type = 'hazardReport' and h.id = e.entity_id
        and h.type = any(${cameraTypes}::hazard_type[])
      returning e.sequence
    `);
    events += fromDevices.length + fromReports.length;
    if (batch.length < BATCH) break;
  }

  if (devices > 0) {
    await db.transaction(async (tx) => {
      await bumpStaticDataVersion(tx);
      const stale = [...staleTiles];
      const rest = [...tiles].filter((tile) => !staleTiles.has(tile));
      for (let i = 0; i < stale.length; i += 2000) await markTilesDirty(tx, stale.slice(i, i + 2000), { policyStale: true });
      for (let i = 0; i < rest.length; i += 2000) await markTilesDirty(tx, rest.slice(i, i + 2000));
    });
  }
  await db.execute(sql`update country_boundary_state set margin_m = ${marginM} where id = 1`);
  return { devices, reports, events, tiles: tiles.size, staleTiles: staleTiles.size };
}
