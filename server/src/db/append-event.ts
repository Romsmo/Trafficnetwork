import type { PgTransaction } from "drizzle-orm/pg-core";
import { eventLog } from "./schema/index.js";
import type { EntityType, EventType } from "../config/constants.js";

export interface AppendEventInput {
  type: EventType;
  entityType: EntityType;
  entityId: string;
  /** Full current representation of the entity, not a diff — see event_log schema comment. */
  payload: unknown;
  regionTile?: string | null;
  source: string;
}

/**
 * Appends one row to the append-only event_log. Must always be called with the
 * same transaction handle used for the corresponding materialized-table write
 * (insert/update on hazard_reports, fixed_speed_cameras, etc.) — never on its own
 * connection — so the event and the materialized state can never diverge (see
 * docs/prompt-phase1-server.md section 5.1/5.2 and the plan's "transaktionaler
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
      source: input.source,
    })
    .returning();

  if (!row) {
    throw new Error("appendEvent: insert into event_log returned no row");
  }

  return row;
}
