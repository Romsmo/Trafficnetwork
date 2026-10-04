import type { CameraRecord } from "../../../db/queries/camera-record.js";
import { CAMERA_NAMESPACE_TYPES } from "../../../config/constants.js";
import { cellPolygon, zoneCellOf, zoneId, type GeoJsonPolygon } from "./cells.js";
import type { EffectiveCameraPolicy } from "./policy.js";

/**
 * The projection: the one place that turns camera records into what a client may receive
 * (docs/camera-country-policy.md, sections 1 and 4). Pure — no database, no I/O — so every delivery path can use it and a
 * test can exercise it exhaustively. Nothing here knows which endpoint it serves.
 *
 *   full  -> the individual item, unchanged
 *   zones -> a zone: the H3 cell the camera is in and the kinds present in it — nothing else
 *   off   -> nothing (also: country unknown)
 */

/** What every camera-like item has: the hazard-enum `type` and a GeoJSON `position`. */
export interface CameraLike {
  type: string;
  position: unknown;
}

/** A zone as it goes on the wire (section 5.2). No position, no camera id, no timestamp, no count. */
export interface CameraZoneApi {
  id: string;
  cell: string;
  resolution: number;
  boundary: GeoJsonPolygon;
  cameraTypes: string[];
  status: "active" | "removed";
}

export function buildZone(cell: string, cameraTypes: Iterable<string>, resolution: number, status: "active" | "removed" = "active"): CameraZoneApi {
  return {
    id: zoneId(cell),
    cell,
    resolution,
    boundary: cellPolygon(cell),
    cameraTypes: [...new Set(cameraTypes)].sort(),
    status,
  };
}

/** The zone of a cell that has no camera any more — the payload of a removal event. Carries no boundary beyond the cell id. */
export function removedZone(cell: string, resolution: number): CameraZoneApi {
  return buildZone(cell, [], resolution, "removed");
}

/** The body of `202` for a camera write that is not delivered individually: the same for a new and a merged camera. */
export function acceptedBody(zone: CameraZoneApi | null): { accepted: true; zone?: CameraZoneApi } {
  return zone ? { accepted: true, zone } : { accepted: true };
}

export function isCameraType(type: unknown): boolean {
  return typeof type === "string" && (CAMERA_NAMESPACE_TYPES as readonly string[]).includes(type);
}

/**
 * The records that may be delivered as individual items: effective level `full`, and (when given) of a requested type.
 * `keep` is the endpoint's own exact selection (distance, tile…) applied to those that survive the policy.
 */
export function individualItems<T extends CameraLike>(
  policy: EffectiveCameraPolicy,
  records: readonly CameraRecord<T>[],
  options: { types?: ReadonlySet<string> | undefined; keep?: (record: CameraRecord<T>) => boolean } = {},
): T[] {
  const out: T[] = [];
  for (const record of records) {
    if (policy.levelOf(record.countries) !== "full") continue;
    if (options.types && !options.types.has(record.item.type)) continue;
    if (options.keep && !options.keep(record)) continue;
    out.push(record.item);
  }
  return out;
}

/**
 * Zones for a given set of candidate cells: every cell in `cells` that contains at least one record whose effective level
 * is `zones` (and, when given, of a requested type). Membership is decided by the cell alone — the records only say what
 * is inside it — so the answer for a cell is the same for every query that asks about that cell.
 */
export function zonesForCells<T extends CameraLike>(
  policy: EffectiveCameraPolicy,
  records: readonly CameraRecord<T>[],
  cells: ReadonlySet<string>,
  types?: ReadonlySet<string>,
): CameraZoneApi[] {
  const typesByCell = new Map<string, Set<string>>();
  for (const record of records) {
    if (policy.levelOf(record.countries) !== "zones") continue;
    if (types && !types.has(record.item.type)) continue;
    const cell = zoneCellOf(record.lat, record.lng, policy.zoneResolution);
    if (!cells.has(cell)) continue;
    let set = typesByCell.get(cell);
    if (!set) typesByCell.set(cell, (set = new Set()));
    set.add(record.item.type);
  }
  return [...typesByCell.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([cell, set]) => buildZone(cell, set, policy.zoneResolution));
}

/** Zones for every `zones`-level record, whatever the cell (snapshot of the persistent devices). */
export function allZones<T extends CameraLike>(policy: EffectiveCameraPolicy, records: readonly CameraRecord<T>[]): CameraZoneApi[] {
  const cells = new Set<string>();
  for (const record of records) {
    if (policy.levelOf(record.countries) === "zones") cells.add(zoneCellOf(record.lat, record.lng, policy.zoneResolution));
  }
  return zonesForCells(policy, records, cells);
}

/** Merges zones of the same cell (a cell can be reported from the persistent devices and from reports separately). */
export function mergeZones(...lists: readonly CameraZoneApi[][]): CameraZoneApi[] {
  const byCell = new Map<string, CameraZoneApi>();
  for (const zone of lists.flat()) {
    const existing = byCell.get(zone.cell);
    byCell.set(zone.cell, existing ? buildZone(zone.cell, [...existing.cameraTypes, ...zone.cameraTypes], zone.resolution) : zone);
  }
  return [...byCell.values()].sort((a, b) => (a.cell < b.cell ? -1 : 1));
}
