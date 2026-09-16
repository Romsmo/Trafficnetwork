import { sql } from "drizzle-orm";
import type { Queryable } from "../../src/db/client.js";

/** Test-only raw-SQL inserts for geometry-bearing tables (see db/schema/geometry.ts). */

export async function insertStaticSign(
  db: Queryable,
  opts: { lat: number; lng: number; signType?: string; source?: string },
): Promise<string> {
  const rows = await db.execute<{ id: string } & Record<string, unknown>>(sql`
    insert into static_signs (position, sign_type, source)
    values (ST_SetSRID(ST_MakePoint(${opts.lng}, ${opts.lat}), 4326), ${opts.signType ?? "DE:274"}, ${opts.source ?? "seed"})
    returning id
  `);
  const id = rows[0]?.id;
  if (!id) throw new Error("insertStaticSign: insert returned no id");
  return id;
}

export async function insertSpeedLimitSegment(
  db: Queryable,
  opts: { lineString: [number, number][]; speedLimit: number; source?: string },
): Promise<string> {
  const wkt = `LINESTRING(${opts.lineString.map(([lng, lat]) => `${lng} ${lat}`).join(", ")})`;
  const rows = await db.execute<{ id: string } & Record<string, unknown>>(sql`
    insert into speed_limit_segments (geometry, speed_limit, speed_limit_unit, source)
    values (ST_SetSRID(ST_GeomFromText(${wkt}), 4326), ${opts.speedLimit}, 'kmh', ${opts.source ?? "seed"})
    returning id
  `);
  const id = rows[0]?.id;
  if (!id) throw new Error("insertSpeedLimitSegment: insert returned no id");
  return id;
}

export async function insertHazardReport(
  db: Queryable,
  opts: {
    lat: number;
    lng: number;
    type?: string;
    regionTile: string;
    expiresAt: Date;
    status?: "active" | "expired" | "removed";
    reporterId?: string;
  },
): Promise<string> {
  const rows = await db.execute<{ id: string } & Record<string, unknown>>(sql`
    insert into hazard_reports (type, position, region_tile, reporter_id, expires_at, status)
    values (
      ${opts.type ?? "traffic"},
      ST_SetSRID(ST_MakePoint(${opts.lng}, ${opts.lat}), 4326),
      ${opts.regionTile},
      ${opts.reporterId ?? "test-reporter"},
      ${opts.expiresAt.toISOString()},
      ${opts.status ?? "active"}
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (!id) throw new Error("insertHazardReport: insert returned no id");
  return id;
}
