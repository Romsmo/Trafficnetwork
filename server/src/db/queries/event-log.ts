import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import type { EntityType, EventType } from "../../config/constants.js";

export interface EventLogEntryApi {
  sequence: number;
  occurredAt: string;
  type: EventType;
  entityType: EntityType;
  entityId: string;
  payload: unknown;
  regionTile: string | null;
  source: string;
}

interface Row extends Record<string, unknown> {
  sequence: number;
  occurred_at: string;
  type: EventType;
  entity_type: EntityType;
  entity_id: string;
  payload: unknown;
  region_tile: string | null;
  source: string;
}

function toApi(row: Row): EventLogEntryApi {
  return {
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    type: row.type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: row.payload,
    regionTile: row.region_tile,
    source: row.source,
  };
}

/** Null if the log is empty (nothing has ever happened, or everything has been purged). */
async function getEarliestRetainedSequence(db: Queryable): Promise<number | null> {
  const rows = await db.execute<{ min: number | null } & Record<string, unknown>>(sql`select min(sequence) as min from event_log`);
  return rows[0]?.min ?? null;
}

/**
 * Thrown when `since` predates what the retention window still has on record —
 * the caller (modules/sync/routes.ts) turns this into HTTP 409 SNAPSHOT_REQUIRED,
 * per docs/prompt-phase1-server.md section 5.1 ("Ein Gerät, das deutlich länger
 * offline war, fordert einen frischen Snapshot an").
 */
export class SnapshotRequiredError extends Error {
  constructor() {
    super("Requested delta range has been purged by the retention window; fetch a fresh snapshot instead.");
  }
}

export interface DeltaPage {
  events: EventLogEntryApi[];
  nextSince: number | null;
  hasMore: boolean;
}

/**
 * `types` filters hazard-report/camera lifecycle events by the hazard type carried
 * in their JSON payload; entity types with no such concept (speedLimitSegment,
 * staticSign updates) always pass through regardless of `types`, since they are
 * unconditionally globally synced data rather than a categorized report stream.
 */
export async function getDeltaPage(
  db: Queryable,
  since: number,
  opts: { tiles?: string[]; types?: string[]; limit: number },
): Promise<DeltaPage> {
  if (since > 0) {
    const earliest = await getEarliestRetainedSequence(db);
    if (earliest === null || since < earliest - 1) {
      throw new SnapshotRequiredError();
    }
  }

  const tiles = opts.tiles ?? [];
  const typeFilter =
    opts.types && opts.types.length > 0
      ? sql`and (entity_type not in ('hazardReport', 'fixedSpeedCamera') or payload ->> 'type' = any(${opts.types}))`
      : sql``;

  const rows = await db.execute<Row>(sql`
    select sequence, occurred_at, type, entity_type, entity_id, payload, region_tile, source
    from event_log
    where sequence > ${since}
      and (region_tile is null or region_tile = any(${tiles}))
      ${typeFilter}
    order by sequence asc
    limit ${opts.limit + 1}
  `);

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const events = page.map(toApi);
  const lastEvent = events.at(-1);

  return {
    events,
    nextSince: lastEvent ? lastEvent.sequence : null,
    hasMore,
  };
}
