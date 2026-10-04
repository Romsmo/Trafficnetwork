import { isValidCell } from "h3-js";
import type { Queryable } from "../../../db/client.js";
import { CAMERA_NAMESPACE_TYPES } from "../../../config/constants.js";
import { pointOf } from "../../../db/queries/camera-record.js";
import { toEventLogEntryApi, type EventLogCandidate, type EventLogEntryApi } from "../../../db/queries/event-log.js";
import { tileSpeaksForCell, zoneCellOf } from "./cells.js";
import { zoneStates } from "./delivery.js";
import { buildEffectivePolicy, type EffectiveCameraPolicy } from "./policy.js";
import type { CameraZoneApi } from "./projection.js";

/**
 * The same single rule for *events* (delta, WebSocket push): a camera event is delivered as it is at level `full`,
 * becomes a zone event at level `zones`, and does not exist for a client at level `off`. Which events are camera
 * events is decided here, by content — not by whether somebody remembered to fill a column in.
 */

const CAMERA_TYPES: ReadonlySet<string> = new Set(CAMERA_NAMESPACE_TYPES);

export function isCameraEvent(event: { entityType: string; payload: unknown }): boolean {
  if (event.entityType === "fixedSpeedCamera" || event.entityType === "enforcementDevice" || event.entityType === "cameraZone") return true;
  if (event.entityType !== "hazardReport") return false;
  const type = (event.payload as { type?: unknown } | null | undefined)?.type;
  return typeof type === "string" && CAMERA_TYPES.has(type);
}

export type EventDisposition =
  | { kind: "pass" } // not a camera event: nothing to decide
  | { kind: "withhold" }
  | { kind: "item" } // level full: deliver as it is
  | { kind: "zone"; cell: string }; // level zones: deliver the cell instead

function zoneCellOfEvent(event: { payload: unknown }, resolution: number): string | null {
  try {
    const { lat, lng } = pointOf((event.payload as { position?: unknown } | null | undefined)?.position);
    return zoneCellOf(lat, lng, resolution);
  } catch {
    return null;
  }
}

export function classifyEvent(policy: EffectiveCameraPolicy, event: { entityType: string; payload: unknown; cameraCountries: string[] | null }): EventDisposition {
  if (!isCameraEvent(event)) return { kind: "pass" };
  const level = policy.levelOf(event.cameraCountries);
  if (level === "full" && event.entityType !== "cameraZone") return { kind: "item" };
  if (level === "zones") {
    const cell = zoneCellOfEvent(event, policy.zoneResolution);
    return cell ? { kind: "zone", cell } : { kind: "withhold" };
  }
  return { kind: "withhold" };
}

/** The event a client sees for a zone: its state *now*, collapsed over everything that happened to the cell. */
export function zoneEvent(zone: CameraZoneApi, at: { sequence: number; occurredAt: string }): EventLogEntryApi {
  return {
    sequence: at.sequence,
    occurredAt: at.occurredAt,
    type: zone.status === "active" ? "StaticDataUpdated" : "StaticDataRemoved",
    entityType: "cameraZone",
    entityId: zone.id,
    payload: zone,
    regionTile: null,
    source: "zone",
  };
}

/** What `GET /v1/delta` is asked for (already validated by the route). */
export interface DeltaQuery {
  tiles: readonly string[];
  /** The resolved type allow-list (never empty). */
  types: readonly string[];
}

/**
 * Applies the policy to one page of candidate events (`event_log` rows, oldest first, region/type pre-filtered but with
 * *every* camera event of the page in it — see getDeltaPage) and returns what the client may see, still oldest first.
 *
 * Zone events are decided by the **cell**, never by the tile the camera happens to be in: a zone event reaches a client
 * that asked about a tile the cell touches, whichever camera caused it. (Routing it by the camera's own tile would let
 * a client that subscribes to a fine tile learn in which part of the cell the camera is.) Events about persistent
 * devices carry no tile — they are global, like the devices themselves — and are global as zone events too.
 */
export async function projectDeltaEvents(
  db: Queryable,
  policy: EffectiveCameraPolicy,
  rows: readonly EventLogCandidate[],
  query: DeltaQuery,
): Promise<EventLogEntryApi[]> {
  const tiles = new Set(query.tiles);
  const validTiles = query.tiles.filter((tile) => isValidCell(tile));
  const out: EventLogEntryApi[] = [];
  const lastOfCell = new Map<string, { sequence: number; occurredAt: string }>();

  for (const row of rows) {
    const disposition = classifyEvent(policy, row);
    if (disposition.kind === "withhold") continue;
    if (disposition.kind === "pass") {
      out.push(toEventLogEntryApi(row));
    } else if (disposition.kind === "item") {
      if (row.regionTile === null || tiles.has(row.regionTile)) out.push(toEventLogEntryApi(row));
    } else if (row.regionTile === null || validTiles.some((tile) => tileSpeaksForCell(tile, disposition.cell))) {
      lastOfCell.set(disposition.cell, { sequence: row.sequence, occurredAt: row.occurredAt }); // collapse: the latest event of the cell stands for all
    }
  }

  if (lastOfCell.size > 0) {
    const types = new Set(query.types.filter((t) => CAMERA_TYPES.has(t)));
    if (types.size > 0) {
      const cells = [...lastOfCell.keys()];
      const states = await zoneStates(db, policy, cells, types);
      states.forEach((zone, index) => out.push(zoneEvent(zone, lastOfCell.get(cells[index]!)!)));
    }
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

/**
 * May this event leave the node towards a peer (federation pull and gossip)? Peers receive the device-signed report with
 * its exact coordinates, so a camera event leaves only where the individual camera may be delivered: level `full`.
 */
export function mayLeaveNode(policy: EffectiveCameraPolicy, event: { isCamera: boolean; cameraCountries: string[] | null }): boolean {
  return !event.isCamera || policy.levelOf(event.cameraCountries) === "full";
}

/** `mayLeaveNode` for an event row that was just appended (the ingest and write paths decide about gossip with this). */
export function eventMayLeaveNode(policy: EffectiveCameraPolicy, event: { entityType: string; payload: unknown; cameraCountries: string[] | null }): boolean {
  return mayLeaveNode(policy, { isCamera: isCameraEvent(event), cameraCountries: event.cameraCountries });
}

/** What the WebSocket publisher needs from the camera policy. */
export interface CameraGate {
  current(): EffectiveCameraPolicy;
  /** H3 resolution clients subscribe at (REGION_TILE_H3_RESOLUTION): where a zone event is routed to. */
  readonly regionTileResolution: number;
  /** Current state of cells (active or removed), for pushing a zone event. */
  zoneStates(cells: string[]): Promise<CameraZoneApi[]>;
  onError?(err: unknown): void;
}

/** The gate of a registry nobody wired a policy into (unit tests): no camera event ever leaves it. */
export const CLOSED_GATE: CameraGate = {
  current: () => CLOSED_POLICY,
  regionTileResolution: 7,
  zoneStates: () => Promise.resolve([]),
};

const CLOSED_POLICY = buildEffectivePolicy({ SPEED_CAMERA_NAMESPACE_ENABLED: false, CAMERA_POLICY_LOCAL_CAPS: "", CAMERA_ZONE_H3_RESOLUTION: 6 }, null);
