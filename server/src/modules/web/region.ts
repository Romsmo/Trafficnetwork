import { sql } from "drizzle-orm";
import type { Queryable } from "../../db/client.js";

export type RegionBounds = [[number, number], [number, number]]; // [[south, west], [north, east]] — Leaflet order

interface Row extends Record<string, unknown> {
  xmin: number | null;
  ymin: number | null;
  xmax: number | null;
  ymax: number | null;
}

async function queryBounds(db: Queryable): Promise<RegionBounds | null> {
  // Planner statistics answer instantly; fall back to a real scan only when there are none yet (fresh import).
  const estimated = await db.execute<Row>(sql`
    select ST_XMin(e) as xmin, ST_YMin(e) as ymin, ST_XMax(e) as xmax, ST_YMax(e) as ymax
    from (select ST_EstimatedExtent('speed_limit_segments', 'geometry') as e) t`).catch(() => [] as Row[]);
  let row = estimated[0];
  if (row?.xmin === null || row?.xmin === undefined) {
    const scanned = await db.execute<Row>(sql`
      select ST_XMin(e) as xmin, ST_YMin(e) as ymin, ST_XMax(e) as xmax, ST_YMax(e) as ymax
      from (select ST_Extent(geometry) as e from speed_limit_segments) t`);
    row = scanned[0];
  }
  if (!row || row.xmin === null || row.ymin === null || row.xmax === null || row.ymax === null) return null;
  return [[Number(row.ymin), Number(row.xmin)], [Number(row.ymax), Number(row.xmax)]];
}

const CACHE_MS = 10 * 60_000;

/**
 * Bounding box of the speed-limit data this node holds, so the map can open where the data is. Cached for ten
 * minutes; a stale value is returned immediately while a refresh runs, so a page load never waits on the scan.
 */
export function createRegionHint(db: Queryable, now: () => number = Date.now): () => Promise<RegionBounds | null> {
  let value: RegionBounds | null = null;
  let loadedAt = 0;
  let inflight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    inflight ??= queryBounds(db)
      .then((bounds) => {
        value = bounds;
        loadedAt = now();
      })
      .catch(() => {
        loadedAt = now(); // keep the old value, retry after the next interval
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return async () => {
    if (loadedAt === 0) await refresh();
    else if (now() - loadedAt > CACHE_MS) void refresh();
    return value;
  };
}
