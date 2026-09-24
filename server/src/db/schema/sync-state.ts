import { boolean, integer, pgTable } from "drizzle-orm/pg-core";

/**
 * Single-row table (id is always 1) tracking a global, monotonically
 * increasing version for the static-data partition/manifest endpoints
 * (client-lib P2.0). Bumped transactionally alongside every write that
 * changes static data — appendEvent() for StaticDataUpdated/StaticDataRemoved
 * events (fixed-camera create/removal), and bulk-import inserts (which
 * deliberately don't append event_log rows, see db/queries/bulk-import.ts) —
 * so a client can cheaply check "has anything changed since I last looked"
 * before fetching the full manifest. A row UPDATE (not a sequence) so the
 * bump rolls back with the rest of the transaction if it fails.
 */
export const staticDataState = pgTable("static_data_state", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull().default(1),
  // The COMMUNITY_CORRECTIONS_ENABLED value the last boot ran with. The overlay
  // changes what every static read returns, so a flip has to bump `version`
  // (and emit events) for clients to drop/regain corrected values — see
  // modules/speed-limit-corrections/switch.ts.
  correctionsOverlayEnabled: boolean("corrections_overlay_enabled").notNull().default(true),
});
