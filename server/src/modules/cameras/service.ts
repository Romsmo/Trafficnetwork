import type { Queryable } from "../../db/client.js";
import type { Env } from "../../config/env.js";
import { appendEvent } from "../../db/append-event.js";
import {
  findDuplicateFixedSpeedCamera,
  findFixedSpeedCameraByIdForUpdate,
  insertFixedSpeedCamera,
  insertRemovalReportIfAbsent,
  markFixedSpeedCameraRemoved,
  touchFixedSpeedCameraConfirmed,
  type DeviceRecord,
} from "../../db/queries/fixed-speed-cameras.js";
import { checkRateLimit } from "../moderation/rate-limit.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { markTilesDirty } from "../../db/queries/static-packages.js";
import { cameraPackageTiles } from "./policy/cells.js";

export interface CreateCameraInput {
  lat: number;
  lng: number;
  reporterId: string;
}

export interface CreateCameraResult {
  camera: DeviceRecord;
  merged: boolean;
  event: Awaited<ReturnType<typeof appendEvent>>;
}

/** The package tiles a persistent camera touches: the tile it is in, and the tile that carries its zone (docs/camera-country-policy.md, 5.3). */
function packageTilesOf(camera: DeviceRecord, env: Env): string[] {
  return cameraPackageTiles(camera.lat, camera.lng, env.STATIC_DATA_PARTITION_H3_RESOLUTION, env.CAMERA_ZONE_H3_RESOLUTION);
}

/**
 * work order "phase1-server" (kept outside the repo) section 6: this write path runs regardless of the camera policy — the policy only ever
 * gates reads (see modules/cameras/policy/ and modules/cameras/routes.ts). What differs with the policy is what the
 * *answer* tells the reporter (modules/cameras/policy/delivery.ts, answerForWrite). Only coordinate
 * plausibility is checked here (no speedKmh concept for a fixed camera); the
 * shared rate limit still applies so this can't be used to bypass it.
 *
 * The camera's country set is computed here, once, and stored with the row and with the event (camera-record.ts).
 */
export async function createOrMergeFixedCamera(db: Queryable, env: Env, input: CreateCameraInput): Promise<CreateCameraResult> {
  if (input.lat === 0 && input.lng === 0) {
    throw badRequest("Position (0, 0) is rejected as implausible (\"null island\")");
  }
  await checkRateLimit(db, input.reporterId, env);

  return db.transaction(async (tx) => {
    const existing = await findDuplicateFixedSpeedCamera(tx, input.lat, input.lng, env.DUPLICATE_MERGE_RADIUS_METERS);

    if (existing) {
      const updated = await touchFixedSpeedCameraConfirmed(tx, existing.item.id);
      const event = await appendEvent(tx, {
        type: "StaticDataUpdated",
        entityType: "fixedSpeedCamera",
        entityId: updated.item.id,
        payload: updated.item,
        cameraCountries: updated.countries,
        source: "community",
      });
      await markTilesDirty(tx, packageTilesOf(updated, env));
      return { camera: updated, merged: true, event };
    }

    const created = await insertFixedSpeedCamera(tx, {
      lat: input.lat,
      lng: input.lng,
      source: "community",
      marginM: env.CAMERA_POLICY_BORDER_MARGIN_M,
    });
    const event = await appendEvent(tx, {
      type: "StaticDataUpdated",
      entityType: "fixedSpeedCamera",
      entityId: created.item.id,
      payload: created.item,
      cameraCountries: created.countries,
      source: "community",
    });
    await markTilesDirty(tx, packageTilesOf(created, env));
    return { camera: created, merged: false, event };
  });
}

export interface ReportRemovalInput {
  cameraId: string;
  reporterId: string;
}

export interface ReportRemovalResult {
  camera: DeviceRecord;
  recorded: boolean;
  removed: boolean;
  /** Only set when removed is true — that's the only branch that appends an event. */
  event?: Awaited<ReturnType<typeof appendEvent>>;
}

/**
 * No "stillThere" counterpart for fixed cameras (docs/concept.md section 8: only
 * removed via accumulated "gone" reports, never auto-expires) — that's why this is
 * a dedicated endpoint/service rather than reusing modules/hazard-reports's
 * confirmations model, which assumes both directions exist.
 */
export async function reportCameraRemoval(db: Queryable, env: Env, input: ReportRemovalInput): Promise<ReportRemovalResult> {
  await checkRateLimit(db, input.reporterId, env);

  return db.transaction(async (tx) => {
    const camera = await findFixedSpeedCameraByIdForUpdate(tx, input.cameraId);
    if (!camera) throw notFound(`No fixed speed camera with id ${input.cameraId}`);
    if (camera.item.status !== "active") {
      return { camera, recorded: false, removed: false };
    }

    const recorded = await insertRemovalReportIfAbsent(tx, camera.item.id, input.reporterId);
    if (!recorded) {
      return { camera, recorded: false, removed: false };
    }

    const newCount = camera.item.removalReportCount + 1;
    if (newCount < env.CAMERA_REMOVAL_THRESHOLD) {
      return { camera: { ...camera, item: { ...camera.item, removalReportCount: newCount } }, recorded: true, removed: false };
    }

    const removed = await markFixedSpeedCameraRemoved(tx, camera.item.id);
    const event = await appendEvent(tx, {
      type: "StaticDataRemoved",
      // Speed cameras keep the entity type clients have always known; the other kinds must not look like one.
      entityType: removed.item.cameraType === "fixedSpeedCamera" ? "fixedSpeedCamera" : "enforcementDevice",
      entityId: removed.item.id,
      payload: removed.item,
      cameraCountries: removed.countries,
      source: "community",
    });
    await markTilesDirty(tx, packageTilesOf(removed, env));
    return { camera: removed, recorded: true, removed: true, event };
  });
}
