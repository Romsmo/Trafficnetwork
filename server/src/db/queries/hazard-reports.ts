import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import type { HazardType } from "../../config/constants.js";

export interface HazardReportApi {
  id: string;
  type: HazardType;
  position: unknown; // GeoJSON Point
  reportedAt: string;
  reporterId: string;
  speedKmh: number | null;
  expiresAt: string;
  status: "active" | "expired" | "removed";
  source: "community" | "seed";
  sourceLicense: string | null;
  confirmCount: number;
  denyCount: number;
}

interface Row extends Record<string, unknown> {
  id: string;
  type: HazardType;
  position_geojson: unknown;
  reported_at: string;
  reporter_id: string;
  speed_kmh: number | null;
  expires_at: string;
  status: "active" | "expired" | "removed";
  source: "community" | "seed";
  source_license: string | null;
  confirm_count: number;
  deny_count: number;
}

function toApi(row: Row): HazardReportApi {
  return {
    id: row.id,
    type: row.type,
    position: row.position_geojson,
    reportedAt: row.reported_at,
    reporterId: row.reporter_id,
    speedKmh: row.speed_kmh,
    expiresAt: row.expires_at,
    status: row.status,
    source: row.source,
    sourceLicense: row.source_license,
    confirmCount: row.confirm_count,
    denyCount: row.deny_count,
  };
}

const SELECT_COLUMNS = sql`
  id, type, ST_AsGeoJSON(position)::json as position_geojson, reported_at, reporter_id,
  speed_kmh, expires_at, status, source, source_license, confirm_count, deny_count
`;

/**
 * Camera-adjacent types (mobileSpeedCamera, trailerCamera, redLightCamera,
 * distanceControl) are filtered out here unless the namespace flag is on — see
 * modules/cameras/filter.ts (introduced in milestone P1.4). Not yet a concern for
 * these two read functions: report creation (which is what would ever put a
 * camera-adjacent type into this table) doesn't exist until milestone P1.3, so
 * there is no camera data to filter yet.
 */
export async function findHazardReportsByTiles(
  db: Queryable,
  tiles: string[],
  types?: HazardType[],
): Promise<HazardReportApi[]> {
  const typeFilter = types && types.length > 0 ? sql`and type = any(${types}::hazard_type[])` : sql``;
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS}
    from hazard_reports
    where status = 'active' and region_tile = any(${tiles}) ${typeFilter}
  `);
  return rows.map(toApi);
}

export async function findHazardReportsNearby(
  db: Queryable,
  lat: number,
  lng: number,
  radiusM: number,
  types?: HazardType[],
): Promise<HazardReportApi[]> {
  const typeFilter = types && types.length > 0 ? sql`and type = any(${types}::hazard_type[])` : sql``;
  const rows = await db.execute<Row>(sql`
    select ${SELECT_COLUMNS}
    from hazard_reports
    where status = 'active' ${typeFilter}
      and ST_DWithin(
        position::geography,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
        ${radiusM}
      )
  `);
  return rows.map(toApi);
}
