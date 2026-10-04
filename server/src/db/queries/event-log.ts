import { sql } from "drizzle-orm";
import type { Queryable } from "../client.js";
import { CAMERA_NAMESPACE_TYPES, type EntityType, type EventType } from "../../config/constants.js";
import { pgArray } from "../pg-array.js";

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

/** An event_log row as the delta query reads it: the API shape plus the camera country set the delivery layer decides on. */
export interface EventLogCandidate extends EventLogEntryApi {
  cameraCountries: string[] | null;
}

interface Row extends Record<string, unknown> {
  sequence: number;
  occurred_at: string;
  type: EventType;
  entity_type: EntityType;
  entity_id: string;
  payload: unknown;
  region_tile: string | null;
  camera_countries: string[] | null;
  source: string;
}

function toCandidate(row: Row): EventLogCandidate {
  return {
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    type: row.type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: row.payload,
    regionTile: row.region_tile,
    cameraCountries: row.camera_countries,
    source: row.source,
  };
}

/** The wire shape of an event: the candidate without its internal country set. */
export function toEventLogEntryApi(candidate: EventLogCandidate): EventLogEntryApi {
  const api: Partial<EventLogCandidate> = { ...candidate };
  delete api.cameraCountries;
  return api as EventLogEntryApi;
}

/** SQL for "this event is about a camera" - by content, so an event whose country column was never filled in is still recognised (and withheld). */
const IS_CAMERA_EVENT = sql`(
  entity_type in ('fixedSpeedCamera', 'enforcementDevice', 'cameraZone')
  or (entity_type = 'hazardReport' and payload ->> 'type' = any(${pgArray([...CAMERA_NAMESPACE_TYPES])}))
)`;

/** Null if the log is empty (nothing has ever happened, or everything has been purged). */
async function getEarliestRetainedSequence(db: Queryable): Promise<number | null> {
  const rows = await db.execute<{ min: number | null } & Record<string, unknown>>(sql`select min(sequence) as min from event_log`);
  return rows[0]?.min ?? null;
}

/**
 * Thrown when `since` predates what the retention window still has on record —
 * the caller (modules/sync/routes.ts) turns this into HTTP 409 SNAPSHOT_REQUIRED,
 * per work order "phase1-server" (kept outside the repo) section 5.1 ("Ein Gerät, das deutlich länger
 * offline war, fordert einen frischen Snapshot an").
 */
export class SnapshotRequiredError extends Error {
  constructor() {
    super("Requested delta range has been purged by the retention window; fetch a fresh snapshot instead.");
  }
}

export interface DeltaPage {
  events: unknown[];
  nextSince: number | null;
  hasMore: boolean;
}

export interface DeltaCandidates {
  /** Oldest first. Every camera event of the range is in here whatever its tile - the delivery layer routes it (zone events go by cell). */
  rows: EventLogCandidate[];
  /** True if the range holds more rows than `limit`. */
  hasMore: boolean;
  /** Sequence of the last row that was looked at, delivered or not - where the next page continues when everything on this one was withheld. */
  scannedThrough: number | null;
}

/**
 * `types` filters hazard-report/camera lifecycle events by the hazard type carried
 * in their JSON payload; entity types with no such concept (speedLimitSegment,
 * staticSign updates) always pass through regardless of `types`, since they are
 * unconditionally globally synced data rather than a categorized report stream.
 *
 * This returns **candidates**: camera events are not tile-filtered here and nothing is decided about their country -
 * both belong to the camera policy (modules/cameras/policy/events.ts), applied by modules/sync/delta.service.ts.
 */
export async function getDeltaCandidates(
  db: Queryable,
  since: number,
  opts: { tiles?: string[]; types?: string[]; limit: number },
): Promise<DeltaCandidates> {
  if (since > 0) {
    const earliest = await getEarliestRetainedSequence(db);
    if (earliest === null || since < earliest - 1) {
      throw new SnapshotRequiredError();
    }
  }

  const tiles = opts.tiles ?? [];
  const typeFilter =
    opts.types && opts.types.length > 0
      ? sql`and (entity_type not in ('hazardReport', 'fixedSpeedCamera', 'enforcementDevice') or payload ->> 'type' = any(${pgArray(opts.types)}))`
      : sql``;

  const rows = await db.execute<Row>(sql`
    select sequence, occurred_at, type, entity_type, entity_id, payload, region_tile, camera_countries, source
    from event_log
    where sequence > ${since}
      and (region_tile is null or region_tile = any(${pgArray(tiles)}) or ${IS_CAMERA_EVENT})
      ${typeFilter}
    order by sequence asc
    limit ${opts.limit + 1}
  `);

  const hasMore = rows.length > opts.limit;
  const page = (hasMore ? rows.slice(0, opts.limit) : rows).map(toCandidate);
  return { rows: page, hasMore, scannedThrough: page.at(-1)?.sequence ?? null };
}

/** True if this federation event has already been ingested (by us, or relayed to us before) — the dedup check every federation ingest path starts with. */
export async function federationEventExists(db: Queryable, federationEventId: string): Promise<boolean> {
  const rows = await db.execute<{ found: number } & Record<string, unknown>>(sql`
    select 1 as found from event_log where federation_event_id = ${federationEventId} limit 1
  `);
  return rows.length > 0;
}

export interface FederationEventPage {
  events: { sequence: number; federationEventId: string; envelope: unknown; occurredAt: string }[];
  nextAfter: number | null;
}

/** A federation-eligible row as read, before the camera policy decides whether it may leave this node. */
export interface FederationEventCandidate {
  sequence: number;
  federationEventId: string;
  envelope: unknown;
  occurredAt: string;
  /** Whether the event is about a camera (decided by content, see IS_CAMERA_EVENT) and the country set stored with it. */
  isCamera: boolean;
  cameraCountries: string[] | null;
}

/**
 * Pull-based anti-entropy (GET /v1/federation/events, modules/federation/routes.ts):
 * every federation-eligible row (federation_event_id is not null) after a
 * per-peer cursor. `after` is always a value *this* server previously
 * returned to the specific peer asking — never compared across peers (see
 * db/schema/network-peers.ts's lastPulledSequence comment).
 */
export async function getFederationEventCandidatesSince(db: Queryable, after: number, limit: number): Promise<FederationEventCandidate[]> {
  const rows = await db.execute<
    {
      sequence: number;
      federation_event_id: string;
      federation_envelope: unknown;
      occurred_at: string;
      is_camera: boolean;
      camera_countries: string[] | null;
    } & Record<string, unknown>
  >(sql`
    select sequence, federation_event_id, federation_envelope, occurred_at, ${IS_CAMERA_EVENT} as is_camera, camera_countries
    from event_log
    where sequence > ${after} and federation_event_id is not null
    order by sequence asc
    limit ${limit}
  `);
  return rows.map((r) => ({
    sequence: r.sequence,
    federationEventId: r.federation_event_id,
    envelope: r.federation_envelope,
    occurredAt: r.occurred_at,
    isCamera: r.is_camera,
    cameraCountries: r.camera_countries,
  }));
}
