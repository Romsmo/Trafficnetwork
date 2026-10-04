import { getResolution, isValidCell, latLngToCell } from "h3-js";
import type { Queryable } from "../../../db/client.js";
import {
  findAllActiveDeviceRecords,
  findDeviceRecordsInEnvelopes,
  findDeviceRecordsNearby,
  type FixedSpeedCameraApi,
} from "../../../db/queries/fixed-speed-cameras.js";
import {
  findAllActiveHazardReportRecords,
  findHazardReportRecordsByTiles,
  findHazardReportRecordsInEnvelopes,
  findHazardReportRecordsNearby,
  type HazardReportApi,
} from "../../../db/queries/hazard-reports.js";
import type { CameraRecord } from "../../../db/queries/camera-record.js";
import {
  ADDITIONAL_PERSISTENT_CAMERA_TYPES,
  CAMERA_NAMESPACE_TYPES,
  DYNAMIC_CAMERA_TYPES,
  isPersistentCameraType,
  type HazardType,
} from "../../../config/constants.js";
import { badRequest } from "../../../lib/errors.js";
import { tileEnvelopes } from "../../static-data/tiles.js";
import { zoneCellOf, zoneCellsForTiles, zoneCellsIntersectingCircle } from "./cells.js";
import { individualItems, removedZone, zonesForCells, type CameraZoneApi } from "./projection.js";
import type { CameraLevel } from "./levels.js";
import type { EffectiveCameraPolicy } from "./policy.js";

/**
 * The database-facing half of the single delivery layer (docs/camera-country-policy.md, section 4).
 *
 * Every read of camera data that a client can reach goes through one of these functions: the endpoint says *what it
 * is asking about* (a circle, some tiles, a snapshot), the function fetches **candidates** without any policy, and
 * the projection (projection.ts) decides what may be delivered. The endpoints contain no copy of the rule.
 */

export type CameraItem = FixedSpeedCameraApi | HazardReportApi;
type AnyRecord = CameraRecord<CameraItem>;

export interface CameraRead {
  cameras: CameraItem[];
  zones: CameraZoneApi[];
}

/** More zone cells than this in one query means the requested tiles are far coarser than a zone: refused instead of silently truncated. */
export const MAX_ZONE_CELLS_PER_QUERY = 5000;
const CELLS_PER_ENVELOPE_QUERY = 400;

const ALL_CAMERA_TYPES: ReadonlySet<string> = new Set(CAMERA_NAMESPACE_TYPES);

/** The camera types a request asks for: everything when it names none; nothing when it names only non-camera types. */
export function requestedCameraTypes(requested: readonly HazardType[] | undefined): Set<string> {
  if (!requested) return new Set(ALL_CAMERA_TYPES);
  return new Set(requested.filter((t) => ALL_CAMERA_TYPES.has(t)));
}

const dynamicOf = (types: ReadonlySet<string>): HazardType[] => DYNAMIC_CAMERA_TYPES.filter((t) => types.has(t));

/** Candidates (devices of every kind and live reports of the dynamic types) whose position lies in the envelopes of the cells. */
async function loadRecordsInCells(db: Queryable, cells: readonly string[], dynamicTypes: HazardType[]): Promise<AnyRecord[]> {
  const out: AnyRecord[] = [];
  for (let i = 0; i < cells.length; i += CELLS_PER_ENVELOPE_QUERY) {
    const envelopes = cells.slice(i, i + CELLS_PER_ENVELOPE_QUERY).flatMap((cell) => tileEnvelopes(cell));
    const [devices, reports] = await Promise.all([
      findDeviceRecordsInEnvelopes(db, envelopes),
      dynamicTypes.length > 0 ? findHazardReportRecordsInEnvelopes(db, envelopes, dynamicTypes) : Promise.resolve([]),
    ]);
    out.push(...devices, ...reports);
  }
  return out;
}

/**
 * The zones for these cells, from the records inside them. A cell belongs in the answer because *the cell* was asked
 * about (it intersects the circle, is the parent of a requested tile…), never because of where a camera inside it is.
 */
async function zonesOfCells(
  db: Queryable,
  policy: EffectiveCameraPolicy,
  cells: readonly string[],
  types: ReadonlySet<string>,
): Promise<CameraZoneApi[]> {
  if (cells.length === 0 || types.size === 0 || !policy.anyZones) return [];
  const records = await loadRecordsInCells(db, cells, dynamicOf(types));
  return zonesForCells(policy, records, new Set(cells), types);
}

/** Current state of cells for events: the active zone, or a `removed` one when no camera of the (requested) kinds is left in the cell. */
export async function zoneStates(
  db: Queryable,
  policy: EffectiveCameraPolicy,
  cells: readonly string[],
  types: ReadonlySet<string> = ALL_CAMERA_TYPES,
): Promise<CameraZoneApi[]> {
  const active = new Map((await zonesOfCells(db, policy, cells, types)).map((zone) => [zone.cell, zone]));
  return cells.map((cell) => active.get(cell) ?? removedZone(cell, policy.zoneResolution));
}

function zoneCellsFor(tiles: readonly string[], policy: EffectiveCameraPolicy): string[] {
  const valid = tiles.filter((tile) => isValidCell(tile));
  const cells = zoneCellsForTiles(valid, policy.zoneResolution, MAX_ZONE_CELLS_PER_QUERY);
  if (cells === null) {
    throw badRequest(
      `The requested tiles are too coarse for camera zones (more than ${MAX_ZONE_CELLS_PER_QUERY} cells of resolution ${policy.zoneResolution}); ask with finer tiles.`,
    );
  }
  return cells;
}

export interface WriteAnswer {
  level: CameraLevel;
  /** At level `zones`: the zone the camera is in (its state now, exactly what a read of that cell returns). */
  zone: CameraZoneApi | null;
}

/** What a camera write may tell the writer (see modules/cameras/write-response.ts). */
export async function answerForWrite(
  db: Queryable,
  policy: EffectiveCameraPolicy,
  record: { countries: string[] | null; lat: number; lng: number },
): Promise<WriteAnswer> {
  const level = policy.levelOf(record.countries);
  if (level !== "zones") return { level, zone: null };
  const [zone] = await zoneStates(db, policy, [zoneCellOf(record.lat, record.lng, policy.zoneResolution)]);
  return { level, zone: zone && zone.status === "active" ? zone : null };
}

/** `GET /v1/speed-cameras/nearby` */
export async function readCamerasNear(
  db: Queryable,
  policy: EffectiveCameraPolicy,
  q: { lat: number; lng: number; radiusM: number; types: ReadonlySet<string> },
): Promise<CameraRead> {
  if (!policy.deliversAnything || q.types.size === 0) return { cameras: [], zones: [] };

  const cameras: CameraItem[] = [];
  if (policy.anyFull) {
    const wantsDevices = [...q.types].some(isPersistentCameraType);
    const dynamic = dynamicOf(q.types);
    const [devices, reports] = await Promise.all([
      wantsDevices ? findDeviceRecordsNearby(db, q.lat, q.lng, q.radiusM) : Promise.resolve([]),
      dynamic.length > 0 ? findHazardReportRecordsNearby(db, q.lat, q.lng, q.radiusM, dynamic) : Promise.resolve([]),
    ]);
    cameras.push(...individualItems(policy, devices, { types: q.types }), ...individualItems(policy, reports, { types: q.types }));
  }

  const zones = policy.anyZones
    ? await zonesOfCells(db, policy, zoneCellsIntersectingCircle(q.lat, q.lng, q.radiusM, policy.zoneResolution), q.types)
    : [];
  return { cameras, zones };
}

/**
 * `GET /v1/speed-cameras/by-tile`. Classic speed cameras are not tile-addressed (they are synced globally, like static
 * signs), so individually only the additional device kinds and the live reports come back; zones cover all kinds.
 */
export async function readCamerasInTiles(
  db: Queryable,
  policy: EffectiveCameraPolicy,
  q: { tiles: string[]; types: ReadonlySet<string> },
): Promise<CameraRead> {
  if (!policy.deliversAnything || q.types.size === 0 || q.tiles.length === 0) return { cameras: [], zones: [] };

  const cameras: CameraItem[] = [];
  if (policy.anyFull) {
    const additional = new Set([...q.types].filter((t) => (ADDITIONAL_PERSISTENT_CAMERA_TYPES as readonly string[]).includes(t)));
    const dynamic = dynamicOf(q.types);
    if (additional.size > 0) {
      const wanted = new Set(q.tiles);
      const resolution = getResolution(q.tiles[0]!);
      const candidates = await findDeviceRecordsInEnvelopes(
        db,
        q.tiles.flatMap((tile) => tileEnvelopes(tile)),
      );
      cameras.push(
        ...individualItems(policy, candidates, { types: additional, keep: (r) => wanted.has(latLngToCell(r.lat, r.lng, resolution)) }),
      );
    }
    if (dynamic.length > 0) {
      const reports = await findHazardReportRecordsByTiles(db, q.tiles, dynamic);
      cameras.push(...individualItems(policy, reports, { types: new Set(dynamic) }));
    }
  }

  const zones = policy.anyZones ? await zonesOfCells(db, policy, zoneCellsFor(q.tiles, policy), q.types) : [];
  return { cameras, zones };
}

export interface CameraSnapshotPart {
  /** The classic speed cameras only, as `fixedSpeedCameras` has always meant. */
  fixedSpeedCameras: FixedSpeedCameraApi[];
  /** Every persistent device, each with `cameraType`. */
  enforcementDevices: FixedSpeedCameraApi[];
  /** Live camera reports in the requested tiles at level `full`. */
  hazardReports: HazardReportApi[];
  cameraZones: CameraZoneApi[];
}

/**
 * The camera part of `GET /v1/snapshot`. The persistent devices are global (`includeStatic`), the live reports are
 * tile-bound, exactly as before; zones follow the same split: every zone of the persistent devices, plus the zones of the
 * cells the requested tiles speak for.
 */
export async function readCamerasForSnapshot(
  db: Queryable,
  policy: EffectiveCameraPolicy,
  q: { tiles: string[]; types: ReadonlySet<string>; includeStatic: boolean },
): Promise<CameraSnapshotPart> {
  const empty: CameraSnapshotPart = { fixedSpeedCameras: [], enforcementDevices: [], hazardReports: [], cameraZones: [] };
  if (!policy.deliversAnything) return empty;

  const dynamic = dynamicOf(q.types);
  const devices = q.includeStatic ? await findAllActiveDeviceRecords(db) : [];

  const reportsInTiles = q.tiles.length > 0 && dynamic.length > 0 && policy.anyFull ? await findHazardReportRecordsByTiles(db, q.tiles, dynamic) : [];
  const part: CameraSnapshotPart = {
    fixedSpeedCameras: individualItems(policy, devices, { keep: (r) => r.item.cameraType === "fixedSpeedCamera" }),
    enforcementDevices: individualItems(policy, devices),
    hazardReports: individualItems(policy, reportsInTiles),
    cameraZones: [],
  };

  if (policy.anyZones) {
    const cells = new Set(q.tiles.length > 0 ? zoneCellsFor(q.tiles, policy) : []);
    for (const device of devices) {
      if (policy.levelOf(device.countries) === "zones") cells.add(zoneCellOf(device.lat, device.lng, policy.zoneResolution));
    }
    if (cells.size > 0) {
      const records: AnyRecord[] = [...devices, ...(await findAllActiveHazardReportRecords(db, dynamic))];
      if (!q.includeStatic) records.push(...(await loadRecordsInCells(db, [...cells], []))); // devices of the cells the tiles speak for
      part.cameraZones = zonesForCells(policy, dedupe(records), cells);
    }
  }
  return part;
}

/** The same record can come from two loads (all active reports and an envelope query); count it once. */
function dedupe(records: readonly AnyRecord[]): AnyRecord[] {
  const seen = new Set<string>();
  const out: AnyRecord[] = [];
  for (const record of records) {
    const key = (record.item as { id: string }).id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}
