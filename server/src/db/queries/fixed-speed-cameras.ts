import { sql, type SQL } from "drizzle-orm";
import type { Queryable } from "../client.js";
import { envelopeOverlap, type Envelope } from "../../lib/geo-bbox.js";
import type { PersistentCameraType } from "../../config/constants.js";
import { toRecord, type CameraRecord } from "./camera-record.js";

/**
 * A permanently installed enforcement device (add-on D: the table holds speed cameras, red-light
 * and distance devices). The name predates the generalisation and is kept — see
 * docs/persistent-enforcement-devices.md, "What deliberately does not change".
 */
export interface FixedSpeedCameraApi {
  id: string;
  /** Equal to `cameraType` — a value of the hazard enum, so this shape matches the other
   *  camera-adjacent types when they're combined in modules/cameras/routes.ts, and so event
   *  payloads carry a "type" the generic delta type-filter can read. Every row that existed
   *  before the column is "fixedSpeedCamera". */
  type: PersistentCameraType;
  /** Which kind of device this is (stored column `camera_type`). */
  cameraType: PersistentCameraType;
  position: unknown; // GeoJSON Point
  status: "active" | "removed";
  removedAt: string | null;
  source: string;
  sourceLicense: string | null;
  importedAt: string;
  lastConfirmedAt: string | null;
  /**
   * Count only, not the raw per-reporter list — docs/concept.md's pseudocode shows
   * a `removalReports[]` field, but exposing every reporter's (pseudonymous) id to
   * every client is more exposure than the trust-signal use case needs; the count
   * already conveys it.
   */
  removalReportCount: number;
}

interface Row extends Record<string, unknown> {
  id: string;
  camera_type: PersistentCameraType;
  position_geojson: unknown;
  countries: string[] | null;
  status: "active" | "removed";
  removed_at: string | null;
  source: string;
  source_license: string | null;
  imported_at: string;
  last_confirmed_at: string | null;
  removal_report_count: number;
}

function toApi(row: Row): FixedSpeedCameraApi {
  return {
    id: row.id,
    type: row.camera_type,
    cameraType: row.camera_type,
    position: row.position_geojson,
    status: row.status,
    removedAt: row.removed_at,
    source: row.source,
    sourceLicense: row.source_license,
    importedAt: row.imported_at,
    lastConfirmedAt: row.last_confirmed_at,
    removalReportCount: row.removal_report_count,
  };
}

/** A persistent device with its country set and position, as every query here returns it (see camera-record.ts). */
export type DeviceRecord = CameraRecord<FixedSpeedCameraApi>;

export function toDeviceRecord(row: Record<string, unknown>): DeviceRecord {
  const typed = row as Row;
  return toRecord(toApi(typed), typed.countries);
}

const SELECT_COLUMNS = sql`
  c.id, c.camera_type, ST_AsGeoJSON(c.position)::json as position_geojson, c.countries, c.status, c.removed_at,
  c.source, c.source_license, c.imported_at, c.last_confirmed_at,
  (select count(*)::int from camera_removal_reports r where r.camera_id = c.id) as removal_report_count
`;

/*
 * None of the reads below applies the camera policy: they return candidates. The policy is applied once, afterwards, in
 * modules/cameras/policy/ (docs/camera-country-policy.md, section 4) — so there is exactly one copy of the rule.
 */

/** Every active persistent device of every kind (snapshot, zones). */
export async function findAllActiveDeviceRecords(db: Queryable): Promise<DeviceRecord[]> {
  const rows = await db.execute<Row>(sql`select ${SELECT_COLUMNS} from fixed_speed_cameras c where c.status = 'active'`);
  return rows.map(toDeviceRecord);
}

/** Active persistent devices within a radius of a point (exact distance — a candidate set for the projection). */
export async function findDeviceRecordsNearby(db: Queryable, lat: number, lng: number, radiusM: number): Promise<DeviceRecord[]> {
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS} from fixed_speed_cameras c
    where c.status = 'active'
      and ST_DWithin(c.position::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusM})
  `);
  return rows.map(toDeviceRecord);
}

/** Active persistent devices whose position lies in one of the envelopes (index-assisted, a superset the caller narrows). */
export async function findDeviceRecordsInEnvelopes(db: Queryable, envelopes: readonly Envelope[]): Promise<DeviceRecord[]> {
  if (envelopes.length === 0) return [];
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS} from fixed_speed_cameras c
    where c.status = 'active' and ${envelopeOverlap(sql`c.position`, envelopes)}
  `);
  return rows.map(toDeviceRecord);
}

/**
 * FOR UPDATE — locks the candidate so two concurrent camera reports at the same spot can't race.
 * Only speed cameras merge: a community `fixedSpeedCamera` report next to a red-light or distance device
 * (the same junction) is a different device and must not be swallowed by it.
 */
export async function findDuplicateFixedSpeedCamera(
  db: Queryable,
  lat: number,
  lng: number,
  radiusM: number,
): Promise<DeviceRecord | null> {
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS} from fixed_speed_cameras c
    where c.status = 'active'
      and c.camera_type = 'fixedSpeedCamera'
      and ST_DWithin(c.position::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusM})
    order by c.imported_at asc
    limit 1
    for update of c
  `);
  const row = rows[0];
  return row ? toDeviceRecord(row) : null;
}

export async function findFixedSpeedCameraByIdForUpdate(db: Queryable, id: string): Promise<DeviceRecord | null> {
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS} from fixed_speed_cameras c where c.id = ${id} for update of c
  `);
  const row = rows[0];
  return row ? toDeviceRecord(row) : null;
}

/** `marginM` is CAMERA_POLICY_BORDER_MARGIN_M: the country set is computed here, once, and stored with the row. */
export async function insertFixedSpeedCamera(
  db: Queryable,
  input: { lat: number; lng: number; source: string; marginM: number },
): Promise<DeviceRecord> {
  const rows = await db.execute<{ id: string } & Record<string, unknown>>(sql`
    insert into fixed_speed_cameras (position, countries, source, last_confirmed_at)
    values (
      ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326),
      camera_countries(ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326), ${input.marginM}),
      ${input.source}, now()
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (!id) throw new Error("insertFixedSpeedCamera: insert returned no id");
  const created = await findFixedSpeedCameraByIdForUpdate(db, id);
  if (!created) throw new Error("insertFixedSpeedCamera: could not re-read inserted row");
  return created;
}

export async function touchFixedSpeedCameraConfirmed(db: Queryable, id: string): Promise<DeviceRecord> {
  await db.execute(sql`update fixed_speed_cameras set last_confirmed_at = now() where id = ${id}`);
  const updated = await findFixedSpeedCameraByIdForUpdate(db, id);
  if (!updated) throw new Error("touchFixedSpeedCameraConfirmed: row disappeared");
  return updated;
}

/** True if this reporter had not already filed a removal report for this camera. */
export async function insertRemovalReportIfAbsent(db: Queryable, cameraId: string, reporterId: string): Promise<boolean> {
  const rows = await db.execute<{ id: number } & Record<string, unknown>>(sql`
    insert into camera_removal_reports (camera_id, reporter_id)
    values (${cameraId}, ${reporterId})
    on conflict (camera_id, reporter_id) do nothing
    returning id
  `);
  return rows.length > 0;
}

export async function markFixedSpeedCameraRemoved(db: Queryable, id: string): Promise<DeviceRecord> {
  await db.execute(sql`update fixed_speed_cameras set status = 'removed', removed_at = now() where id = ${id}`);
  const updated = await findFixedSpeedCameraByIdForUpdate(db, id);
  if (!updated) throw new Error("markFixedSpeedCameraRemoved: row disappeared");
  return updated;
}

/** Candidate active persistent devices of one envelope set, ordered by id — see tileStaticSignsQuery. The builder narrows by policy and tile. */
export function tileDeviceRecordsQuery(envelopes: readonly Envelope[]): { query: SQL; map: (row: Record<string, unknown>) => DeviceRecord } {
  return {
    query: sql`
      select ${SELECT_COLUMNS} from fixed_speed_cameras c
      where c.status = 'active' and ${envelopeOverlap(sql`c.position`, envelopes)} order by c.id
    `,
    map: toDeviceRecord,
  };
}
