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
  type FixedSpeedCameraApi,
} from "../../db/queries/fixed-speed-cameras.js";
import { checkRateLimit } from "../moderation/rate-limit.js";
import { badRequest, notFound } from "../../lib/errors.js";

export interface CreateCameraInput {
  lat: number;
  lng: number;
  reporterId: string;
}

export interface CreateCameraResult {
  camera: FixedSpeedCameraApi;
  merged: boolean;
  event: Awaited<ReturnType<typeof appendEvent>>;
}

/**
 * docs/prompt-phase1-server.md section 6: this write path runs regardless of
 * SPEED_CAMERA_NAMESPACE_ENABLED — the flag only ever gates reads (see
 * modules/cameras/filter.ts and modules/cameras/routes.ts). Only coordinate
 * plausibility is checked here (no speedKmh concept for a fixed camera); the
 * shared rate limit still applies so this can't be used to bypass it.
 */
export async function createOrMergeFixedCamera(db: Queryable, env: Env, input: CreateCameraInput): Promise<CreateCameraResult> {
  if (input.lat === 0 && input.lng === 0) {
    throw badRequest("Position (0, 0) is rejected as implausible (\"null island\")");
  }
  await checkRateLimit(db, input.reporterId, env);

  return db.transaction(async (tx) => {
    const existing = await findDuplicateFixedSpeedCamera(tx, input.lat, input.lng, env.DUPLICATE_MERGE_RADIUS_METERS);

    if (existing) {
      const updated = await touchFixedSpeedCameraConfirmed(tx, existing.id);
      const event = await appendEvent(tx, {
        type: "StaticDataUpdated",
        entityType: "fixedSpeedCamera",
        entityId: updated.id,
        payload: updated,
        source: "community",
      });
      return { camera: updated, merged: true, event };
    }

    const created = await insertFixedSpeedCamera(tx, { lat: input.lat, lng: input.lng, source: "community" });
    const event = await appendEvent(tx, {
      type: "StaticDataUpdated",
      entityType: "fixedSpeedCamera",
      entityId: created.id,
      payload: created,
      source: "community",
    });
    return { camera: created, merged: false, event };
  });
}

export interface ReportRemovalInput {
  cameraId: string;
  reporterId: string;
}

export interface ReportRemovalResult {
  camera: FixedSpeedCameraApi;
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
    if (camera.status !== "active") {
      return { camera, recorded: false, removed: false };
    }

    const recorded = await insertRemovalReportIfAbsent(tx, camera.id, input.reporterId);
    if (!recorded) {
      return { camera, recorded: false, removed: false };
    }

    const newCount = camera.removalReportCount + 1;
    if (newCount < env.CAMERA_REMOVAL_THRESHOLD) {
      return { camera: { ...camera, removalReportCount: newCount }, recorded: true, removed: false };
    }

    const removed = await markFixedSpeedCameraRemoved(tx, camera.id);
    const event = await appendEvent(tx, {
      type: "StaticDataRemoved",
      entityType: "fixedSpeedCamera",
      entityId: removed.id,
      payload: removed,
      source: "community",
    });
    return { camera: removed, recorded: true, removed: true, event };
  });
}
