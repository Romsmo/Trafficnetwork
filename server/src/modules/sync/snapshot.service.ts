import { sql } from "drizzle-orm";
import type { Queryable } from "../../db/client.js";
import { findAllSpeedLimitSegments } from "../../db/queries/speed-limit-segments.js";
import { findAllStaticSigns } from "../../db/queries/static-signs.js";
import { findHazardReportsByTiles } from "../../db/queries/hazard-reports.js";
import { findAllActiveFixedSpeedCameras, type FixedSpeedCameraApi } from "../../db/queries/fixed-speed-cameras.js";
import type { HazardType } from "../../config/constants.js";
import { resolveSyncHazardTypes } from "../cameras/filter.js";

export interface SnapshotResult {
  snapshotSequence: number;
  speedLimitSegments: Awaited<ReturnType<typeof findAllSpeedLimitSegments>>;
  staticSigns: Awaited<ReturnType<typeof findAllStaticSigns>>;
  hazardReports: Awaited<ReturnType<typeof findHazardReportsByTiles>>;
  /** Only populated when SPEED_CAMERA_NAMESPACE_ENABLED — omitted (empty) otherwise. */
  fixedSpeedCameras: FixedSpeedCameraApi[];
}

/**
 * Static data is always returned in full (docs/concept.md section 3.3); dynamic
 * hazard reports are only included when the caller supplies `tiles` — an empty/
 * omitted tile list means "static-only snapshot", matching the delta endpoint's
 * symmetric behavior for events with no regionTile. fixedSpeedCamera is treated
 * as static data (globally synced, not tile-filtered) once the namespace flag is
 * on, matching how it's modeled in the schema (no regionTile column) — see
 * modules/cameras/filter.ts for why the hazard-type allow-list itself is resolved
 * through the flag before this ever reaches the query layer.
 *
 * Runs in a single REPEATABLE READ transaction so snapshotSequence (captured via
 * max(event_log.sequence)) is read from the exact same consistent snapshot as the
 * entity table reads that follow it — otherwise a write landing between the two
 * reads could be silently missing from both the snapshot body and any delta a
 * client later requests starting at snapshotSequence.
 *
 * Reads are buffered (not DB-cursor-streamed) — a deliberate simplification for
 * Phase 1, where the static dataset is empty pending Phase 3 ingestion. Revisit
 * with server-side cursor streaming before the static dataset actually reaches
 * the "low single-digit GB" scale docs/concept.md section 6 anticipates.
 */
export async function generateSnapshot(
  db: Queryable,
  opts: { tiles?: string[]; types?: HazardType[]; cameraNamespaceEnabled: boolean },
): Promise<SnapshotResult> {
  return db.transaction(
    async (tx) => {
      const [sequenceRows, speedLimitSegments, staticSigns, fixedSpeedCameras] = await Promise.all([
        tx.execute<{ max: number | null }>(sql`select max(sequence) as max from event_log`),
        findAllSpeedLimitSegments(tx),
        findAllStaticSigns(tx),
        opts.cameraNamespaceEnabled ? findAllActiveFixedSpeedCameras(tx) : Promise.resolve([]),
      ]);
      const snapshotSequence = sequenceRows[0]?.max ?? 0;

      const allowedTypes = resolveSyncHazardTypes(opts.types, opts.cameraNamespaceEnabled);
      const hazardReports =
        opts.tiles && opts.tiles.length > 0 ? await findHazardReportsByTiles(tx, opts.tiles, allowedTypes) : [];

      return { snapshotSequence, speedLimitSegments, staticSigns, hazardReports, fixedSpeedCameras };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
