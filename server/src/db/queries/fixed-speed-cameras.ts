import { sql, type SQL } from "drizzle-orm";
import type { Queryable } from "../client.js";
import { envelopeOverlap, type Envelope } from "../../lib/geo-bbox.js";

export interface FixedSpeedCameraApi {
  id: string;
  /** Not a stored column — stamped here so this shape matches the other four
   *  camera-adjacent types when they're combined in modules/cameras/routes.ts,
   *  and so event payloads carry a "type" the generic delta type-filter can read. */
  type: "fixedSpeedCamera";
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
  position_geojson: unknown;
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
    type: "fixedSpeedCamera",
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

const SELECT_COLUMNS = sql`
  c.id, ST_AsGeoJSON(c.position)::json as position_geojson, c.status, c.removed_at,
  c.source, c.source_license, c.imported_at, c.last_confirmed_at,
  (select count(*)::int from camera_removal_reports r where r.camera_id = c.id) as removal_report_count
`;

/** Full active set — used by the snapshot endpoint when the namespace flag is on (docs/concept.md section 3.1: synced globally like other static entities, not tile-filtered). */
export async function findAllActiveFixedSpeedCameras(db: Queryable): Promise<FixedSpeedCameraApi[]> {
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS} from fixed_speed_cameras c where c.status = 'active'
  `);
  return rows.map(toApi);
}

export async function findFixedSpeedCamerasNearby(
  db: Queryable,
  lat: number,
  lng: number,
  radiusM: number,
): Promise<FixedSpeedCameraApi[]> {
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS} from fixed_speed_cameras c
    where c.status = 'active'
      and ST_DWithin(c.position::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusM})
  `);
  return rows.map(toApi);
}

/** FOR UPDATE — locks the candidate so two concurrent camera reports at the same spot can't race. */
export async function findDuplicateFixedSpeedCamera(
  db: Queryable,
  lat: number,
  lng: number,
  radiusM: number,
): Promise<FixedSpeedCameraApi | null> {
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS} from fixed_speed_cameras c
    where c.status = 'active'
      and ST_DWithin(c.position::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusM})
    order by c.imported_at asc
    limit 1
    for update of c
  `);
  const row = rows[0];
  return row ? toApi(row) : null;
}

export async function findFixedSpeedCameraByIdForUpdate(db: Queryable, id: string): Promise<FixedSpeedCameraApi | null> {
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS} from fixed_speed_cameras c where c.id = ${id} for update of c
  `);
  const row = rows[0];
  return row ? toApi(row) : null;
}

export async function insertFixedSpeedCamera(
  db: Queryable,
  input: { lat: number; lng: number; source: string },
): Promise<FixedSpeedCameraApi> {
  const rows = await db.execute<{ id: string } & Record<string, unknown>>(sql`
    insert into fixed_speed_cameras (position, source, last_confirmed_at)
    values (ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326), ${input.source}, now())
    returning id
  `);
  const id = rows[0]?.id;
  if (!id) throw new Error("insertFixedSpeedCamera: insert returned no id");
  const created = await findFixedSpeedCameraByIdForUpdate(db, id);
  if (!created) throw new Error("insertFixedSpeedCamera: could not re-read inserted row");
  return created;
}

export async function touchFixedSpeedCameraConfirmed(db: Queryable, id: string): Promise<FixedSpeedCameraApi> {
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

export async function markFixedSpeedCameraRemoved(db: Queryable, id: string): Promise<FixedSpeedCameraApi> {
  await db.execute(sql`update fixed_speed_cameras set status = 'removed', removed_at = now() where id = ${id}`);
  const updated = await findFixedSpeedCameraByIdForUpdate(db, id);
  if (!updated) throw new Error("markFixedSpeedCameraRemoved: row disappeared");
  return updated;
}

/** Candidate active cameras of one partition tile, ordered by id — see tileStaticSignsQuery. */
export function tileFixedSpeedCamerasQuery(envelopes: readonly Envelope[]): { query: SQL; map: (row: Record<string, unknown>) => FixedSpeedCameraApi } {
  return {
    query: sql`
      select ${SELECT_COLUMNS} from fixed_speed_cameras c
      where c.status = 'active' and ${envelopeOverlap(sql`c.position`, envelopes)} order by c.id
    `,
    map: (row) => toApi(row as Row),
  };
}
