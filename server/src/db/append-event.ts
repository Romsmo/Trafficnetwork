import type { PgTransaction } from "drizzle-orm/pg-core";
import { eventLog } from "./schema/index.js";
import type { EntityType, EventType } from "../config/constants.js";
import { bumpStaticDataVersion } from "./queries/sync-state.js";

const STATIC_DATA_EVENT_TYPES: readonly EventType[] = ["StaticDataUpdated", "StaticDataRemoved"];

export interface AppendEventInput {
  type: EventType;
  entityType: EntityType;
  entityId: string;
  /** Full current representation of the entity, not a diff — see event_log schema comment. */
  payload: unknown;
  regionTile?: string | null;
  /**
   * Country set of the camera this event is about (docs/camera-country-policy.md) — pass it for every camera event, leave it
   * out for everything else. Delta, WebSocket push and federation egress decide from this column; a camera event without
   * it counts as "country unknown" and is never delivered.
   */
  cameraCountries?: string[] | null;
  source: string;
  /** Federation (F-S3, all optional/null by default) — see db/schema/events.ts's column comments. */
  federationEventId?: string | null;
  federationEnvelope?: unknown;
  originNodeId?: string | null;
}

/**
 * Appends one row to the append-only event_log. Must always be called with the
 * same transaction handle used for the corresponding materialized-table write
 * (insert/update on hazard_reports, fixed_speed_cameras, etc.) — never on its own
 * connection — so the event and the materialized state can never diverge (see
 * work order "phase1-server" (kept outside the repo) section 5.1/5.2 and the plan's "transaktionaler
 * Schreibpfad" note). Callers publish to WebSocket subscribers only after the
 * transaction that calls this has committed.
 */
export async function appendEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: PgTransaction<any, any, any>,
  input: AppendEventInput,
) {
  const [row] = await tx
    .insert(eventLog)
    .values({
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
      regionTile: input.regionTile ?? null,
      cameraCountries: input.cameraCountries ?? null,
      source: input.source,
      federationEventId: input.federationEventId ?? null,
      federationEnvelope: input.federationEnvelope ?? null,
      originNodeId: input.originNodeId ?? null,
    })
    .returning();

  if (!row) {
    throw new Error("appendEvent: insert into event_log returned no row");
  }

  if (STATIC_DATA_EVENT_TYPES.includes(input.type)) {
    await bumpStaticDataVersion(tx);
  }

  return row;
}
