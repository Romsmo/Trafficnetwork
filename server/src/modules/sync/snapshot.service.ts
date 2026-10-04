import { sql } from "drizzle-orm";
import type { Queryable } from "../../db/client.js";
import { findAllSpeedLimitSegments } from "../../db/queries/speed-limit-segments.js";
import { findAllStaticSigns } from "../../db/queries/static-signs.js";
import { findHazardReportsByTiles, type HazardReportApi } from "../../db/queries/hazard-reports.js";
import type { FixedSpeedCameraApi } from "../../db/queries/fixed-speed-cameras.js";
import { NON_CAMERA_HAZARD_TYPES, type HazardType } from "../../config/constants.js";
import { resolveSyncHazardTypes } from "../cameras/filter.js";
import { readCamerasForSnapshot, requestedCameraTypes } from "../cameras/policy/delivery.js";
import type { EffectiveCameraPolicy } from "../cameras/policy/policy.js";
import type { CameraZoneApi } from "../cameras/policy/projection.js";

export interface SnapshotResult {
  snapshotSequence: number;
  speedLimitSegments: Awaited<ReturnType<typeof findAllSpeedLimitSegments>>;
  staticSigns: Awaited<ReturnType<typeof findAllStaticSigns>>;
  hazardReports: HazardReportApi[];
  /** Only what the camera policy lets this node deliver (docs/camera-country-policy.md) - empty otherwise. The classic speed cameras only, as it has always meant. */
  fixedSpeedCameras: FixedSpeedCameraApi[];
  /** Add-on D. Every persistent enforcement device (speed cameras included), each with `cameraType`. Same policy as `fixedSpeedCameras`. */
  enforcementDevices: FixedSpeedCameraApi[];
  /** Zones of the countries at level `zones`: coarse H3 cells with the camera kinds in them, instead of the cameras. */
  cameraZones: CameraZoneApi[];
}

/**
 * Static data is always returned in full (docs/concept.md section 3.3); dynamic
 * hazard reports are only included when the caller supplies `tiles` — an empty/
 * omitted tile list means "static-only snapshot", matching the delta endpoint's
 * symmetric behavior for events with no regionTile. The persistent camera devices
 * are treated as static data (globally synced, not tile-filtered), matching how
 * they are modeled in the schema (no regionTile column). Everything about cameras -
 * which countries, individual or zone - is decided by the camera policy in
 * modules/cameras/policy/; this function only says what it is asking for.
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
 *
 * `includeStaticData: false` (client-lib P2.0) omits the three static-entity
 * reads entirely — for a client that already has them all via the partition/
 * manifest endpoints (modules/static-data/package-service.ts) and just wants
 * the current snapshotSequence plus tile-filtered hazard reports.
 */
export async function generateSnapshot(
  db: Queryable,
  opts: {
    tiles?: string[];
    types?: HazardType[];
    policy: EffectiveCameraPolicy;
    /** COMMUNITY_CORRECTIONS_ENABLED — whether speed-limit segments carry their community-corrected value. */
    communityCorrectionsEnabled: boolean;
    includeStaticData?: boolean;
  },
): Promise<SnapshotResult> {
  const includeStaticData = opts.includeStaticData ?? true;
  const tiles = opts.tiles ?? [];
  return db.transaction(
    async (tx) => {
      const [sequenceRows, speedLimitSegments, staticSigns] = await Promise.all([
        tx.execute<{ max: number | null }>(sql`select max(sequence) as max from event_log`),
        includeStaticData ? findAllSpeedLimitSegments(tx, opts.communityCorrectionsEnabled) : Promise.resolve([]),
        includeStaticData ? findAllStaticSigns(tx) : Promise.resolve([]),
      ]);
      const snapshotSequence = sequenceRows[0]?.max ?? 0;

      // Non-camera reports: as always. Camera reports and the persistent devices: through the camera policy.
      const resolved = resolveSyncHazardTypes(opts.types, opts.policy.deliversAnything);
      const plainTypes = resolved.filter((t) => (NON_CAMERA_HAZARD_TYPES as readonly HazardType[]).includes(t));
      const plainReports = tiles.length > 0 && plainTypes.length > 0 ? await findHazardReportsByTiles(tx, tiles, plainTypes) : [];
      const cameras = await readCamerasForSnapshot(tx, opts.policy, {
        tiles,
        types: requestedCameraTypes(resolved),
        includeStatic: includeStaticData,
      });

      return {
        snapshotSequence,
        speedLimitSegments,
        staticSigns,
        hazardReports: [...plainReports, ...cameras.hazardReports],
        fixedSpeedCameras: cameras.fixedSpeedCameras,
        enforcementDevices: cameras.enforcementDevices,
        cameraZones: cameras.cameraZones,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
