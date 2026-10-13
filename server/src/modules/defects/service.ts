import { sql } from "drizzle-orm";
import { latLngToCell } from "h3-js";
import type { Database, Queryable } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { appendEvent } from "../../db/append-event.js";
import { markTilesDirty } from "../../db/queries/static-packages.js";
import { findSpeedLimitSegmentById, type SpeedLimitSegmentApi } from "../../db/queries/speed-limit-segments.js";
import { segmentTilesOf } from "../static-data/tiles.js";
import { notFound, tooManyRequests, unprocessable } from "../../lib/errors.js";

/**
 * "This entry is wrong - take it out" (docs/road-network.md, "Defect reports").
 *
 * A visitor marks a speed limit or a sign on the map; the mark is one report per reporter and target. When
 * DEFECT_REMOVAL_THRESHOLD distinct reporters have marked the same entry it is hidden: no read returns it, the packages are
 * rebuilt without it, clients are told it went. The entry itself stays in the database and a re-import does not bring it back
 * (it is remembered by what identifies it - data_defect_removals); an operator can restore it. Cameras have their own, older
 * vote ("this camera is gone", CAMERA_REMOVAL_THRESHOLD) and are not part of this.
 */
export const DEFECT_TARGET_TYPES = ["speedLimitSegment", "staticSign"] as const;
export type DefectTargetType = (typeof DEFECT_TARGET_TYPES)[number];

export const DEFECT_REASONS = ["not_on_a_road", "wrong_place", "does_not_exist", "wrong_value", "other"] as const;
export type DefectReason = (typeof DEFECT_REASONS)[number];

type AppendedEvent = Awaited<ReturnType<typeof appendEvent>>;

export interface DefectOutcome {
  recorded: boolean;
  reports: number;
  threshold: number;
  removed: boolean;
  /** Events appended by a removal: the caller publishes them once the transaction has committed. */
  events: AppendedEvent[];
}

/** What identifies an entry across a re-import. */
export function matchKeySql(type: DefectTargetType) {
  return type === "speedLimitSegment" ? sql`geometry_key` : sql`md5(sign_type || ':' || ST_AsText(position))`;
}

async function countReports(db: Queryable, type: DefectTargetType, id: string): Promise<number> {
  const rows = await db.execute<{ n: number } & Record<string, unknown>>(sql`
    select count(distinct reporter_id)::int as n from data_defect_reports where target_type = ${type} and target_id = ${id}
  `);
  return rows[0]?.n ?? 0;
}

/** Counts per target for a list of ids, for the "near" listing. */
export async function reportCounts(db: Queryable, type: DefectTargetType, ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db.execute<{ target_id: string; n: number } & Record<string, unknown>>(sql`
    select target_id, count(distinct reporter_id)::int as n from data_defect_reports
    where target_type = ${type} and target_id = any(${`{${ids.join(",")}}`}::uuid[]) group by target_id
  `);
  return new Map(rows.map((r) => [r.target_id, r.n]));
}

export async function reportDefect(
  db: Database["db"],
  env: Env,
  input: { type: DefectTargetType; id: string; reporterId: string; submittedBy: string; reason: DefectReason | null },
): Promise<DefectOutcome> {
  const threshold = env.DEFECT_REMOVAL_THRESHOLD;
  return db.transaction(async (tx) => {
    // lock per target: two reporters completing the threshold at once must hide it exactly once
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`defect:${input.type}:${input.id}`}, 0))`);

    const exists =
      input.type === "speedLimitSegment"
        ? await tx.execute<{ one: number } & Record<string, unknown>>(sql`select 1 as one from speed_limit_segments where id = ${input.id}::uuid and visible`)
        : await tx.execute<{ one: number } & Record<string, unknown>>(sql`select 1 as one from static_signs where id = ${input.id}::uuid and visible`);
    if (exists.length === 0) throw notFound("No such entry (it may have been removed already)");

    // a per-caller budget, so one client cannot empty a map on its own
    const recent = await tx.execute<{ n: number } & Record<string, unknown>>(sql`
      select count(*)::int as n from data_defect_reports
      where reporter_id = ${input.reporterId} and reported_at > now() - make_interval(mins => ${env.COMMUNITY_CORRECTIONS_RATE_LIMIT_WINDOW_MINUTES})
    `);
    if ((recent[0]?.n ?? 0) >= env.COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX) {
      throw tooManyRequests(
        `Rate limit exceeded: max ${env.COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX} defect reports per ${env.COMMUNITY_CORRECTIONS_RATE_LIMIT_WINDOW_MINUTES} minutes`,
      );
    }

    const inserted = await tx.execute<{ id: number } & Record<string, unknown>>(sql`
      insert into data_defect_reports (target_type, target_id, reporter_id, reason)
      values (${input.type}, ${input.id}::uuid, ${input.reporterId}, ${input.reason})
      on conflict (target_type, target_id, reporter_id) do nothing
      returning id
    `);
    const reports = await countReports(tx, input.type, input.id);
    const recorded = inserted.length > 0;
    if (reports < threshold) return { recorded, reports, threshold, removed: false, events: [] };

    const events = await hideTarget(tx, input.type, input.id, "defect", env.STATIC_DATA_PARTITION_H3_RESOLUTION);
    return { recorded, reports, threshold, removed: true, events };
  });
}

/**
 * Hides the entry (every row with the same identity) and remembers it, as one transaction with its events. Used by the
 * threshold and by the operator's CLI.
 */
export async function hideTarget(
  tx: Parameters<Parameters<Database["db"]["transaction"]>[0]>[0],
  type: DefectTargetType,
  id: string,
  reason: string,
  partitionResolution: number,
): Promise<AppendedEvent[]> {
  const tiles = new Set<string>();
  const events: AppendedEvent[] = [];
  if (type === "speedLimitSegment") {
    const key = await tx.execute<{ k: string } & Record<string, unknown>>(sql`select geometry_key as k from speed_limit_segments where id = ${id}::uuid`);
    const geometryKey = key[0]?.k;
    if (!geometryKey) throw notFound("No such speed-limit segment");
    const rows = await tx.execute<{ id: string } & Record<string, unknown>>(sql`
      select id from speed_limit_segments where geometry_key = ${geometryKey} and visible
    `);
    for (const row of rows) {
      const served = (await findSpeedLimitSegmentById(tx, row.id, true)) as SpeedLimitSegmentApi | null;
      await tx.execute(sql`update speed_limit_segments set visible = false, hidden_reason = 'defect' where id = ${row.id}::uuid`);
      if (served) {
        events.push(await appendEvent(tx, { type: "StaticDataRemoved", entityType: "speedLimitSegment", entityId: row.id, payload: served, regionTile: null, source: "community" }));
        for (const t of segmentTilesOf(served.geometry, partitionResolution)) tiles.add(t);
      }
    }
    await tx.execute(sql`
      insert into data_defect_removals (target_type, match_key, reason) values ('speedLimitSegment', ${geometryKey}, ${reason})
      on conflict (target_type, match_key) do update set removed_at = now(), restored_at = null, reason = excluded.reason
    `);
  } else {
    const rows = await tx.execute<{ id: string; k: string; lat: number; lng: number; sign_type: string; source: string; source_license: string | null; imported_at: string } & Record<string, unknown>>(sql`
      select id, md5(sign_type || ':' || ST_AsText(position)) as k, ST_Y(position) as lat, ST_X(position) as lng,
             sign_type, source, source_license, imported_at
      from static_signs where id = ${id}::uuid
    `);
    const sign = rows[0];
    if (!sign) throw notFound("No such sign");
    await tx.execute(sql`update static_signs set visible = false, hidden_reason = 'defect' where id = ${id}::uuid`);
    events.push(await appendEvent(tx, {
      type: "StaticDataRemoved",
      entityType: "staticSign",
      entityId: id,
      payload: {
        id,
        position: { type: "Point", coordinates: [sign.lng, sign.lat] },
        signType: sign.sign_type,
        source: sign.source,
        sourceLicense: sign.source_license,
        importedAt: sign.imported_at,
      },
      regionTile: null,
      source: "community",
    }));
    tiles.add(latLngToCell(sign.lat, sign.lng, partitionResolution));
    await tx.execute(sql`
      insert into data_defect_removals (target_type, match_key, reason) values ('staticSign', ${sign.k}, ${reason})
      on conflict (target_type, match_key) do update set removed_at = now(), restored_at = null, reason = excluded.reason
    `);
  }
  await markTilesDirty(tx, [...tiles]);
  return events;
}

/** Operator: allow an entry again (by the key it was remembered under). Returns how many rows were shown again. */
export async function restoreRemoval(db: Database["db"], env: Env, type: DefectTargetType, matchKey: string): Promise<number> {
  return db.transaction(async (tx) => {
    const done = await tx.execute<{ id: number } & Record<string, unknown>>(sql`
      update data_defect_removals set restored_at = now() where target_type = ${type} and match_key = ${matchKey} and restored_at is null returning id
    `);
    if (done.length === 0) return 0;
    const tiles = new Set<string>();
    let shown = 0;
    if (type === "speedLimitSegment") {
      const rows = await tx.execute<{ id: string } & Record<string, unknown>>(sql`
        update speed_limit_segments set visible = true, hidden_reason = null
        where geometry_key = ${matchKey} and hidden_reason = 'defect' returning id
      `);
      // The marks that took it out are spent: one new mark must not hide it again at once.
      if (rows.length > 0) {
        await tx.execute(sql`
          delete from data_defect_reports where target_type = 'speedLimitSegment' and target_id = any(${`{${rows.map((r) => r.id).join(",")}}`}::uuid[])
        `);
      }
      for (const row of rows) {
        const served = await findSpeedLimitSegmentById(tx, row.id, true);
        if (served) {
          await appendEvent(tx, { type: "StaticDataUpdated", entityType: "speedLimitSegment", entityId: row.id, payload: served, regionTile: null, source: "community" });
          for (const t of segmentTilesOf(served.geometry, env.STATIC_DATA_PARTITION_H3_RESOLUTION)) tiles.add(t);
        }
        shown += 1;
      }
    } else {
      const rows = await tx.execute<{ id: string; lat: number; lng: number } & Record<string, unknown>>(sql`
        update static_signs set visible = true, hidden_reason = null
        where md5(sign_type || ':' || ST_AsText(position)) = ${matchKey} and hidden_reason = 'defect'
        returning id, ST_Y(position) as lat, ST_X(position) as lng
      `);
      for (const r of rows) tiles.add(latLngToCell(r.lat, r.lng, env.STATIC_DATA_PARTITION_H3_RESOLUTION));
      shown = rows.length;
      if (rows.length > 0) {
        await tx.execute(sql`
          delete from data_defect_reports where target_type = 'staticSign' and target_id in (
            select id from static_signs where md5(sign_type || ':' || ST_AsText(position)) = ${matchKey}
          )
        `);
      }
    }
    await markTilesDirty(tx, [...tiles]);
    return shown;
  });
}

export function validateTargetType(raw: unknown): DefectTargetType {
  if (typeof raw === "string" && (DEFECT_TARGET_TYPES as readonly string[]).includes(raw)) return raw as DefectTargetType;
  throw unprocessable("DEFECT_TARGET_TYPE", `targetType must be one of: ${DEFECT_TARGET_TYPES.join(", ")}`);
}
