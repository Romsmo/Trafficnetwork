import { gridDisk, latLngToCell } from "h3-js";
import type { Env } from "../config/env.js";

/**
 * regionTile computation, work order "phase1-server" (kept outside the repo) section 2.1: H3 resolution 7
 * (~5.16 km² avg cell area), chosen for near-uniform global cell size and clean
 * k-ring neighbor semantics. Computed in application code (h3-js), not a Postgres
 * extension — see the plan's "kein Postgres-H3-Extension" decision.
 */
export function positionToRegionTile(lat: number, lng: number, env: Pick<Env, "REGION_TILE_H3_RESOLUTION">): string {
  return latLngToCell(lat, lng, env.REGION_TILE_H3_RESOLUTION);
}

/**
 * Expands a center tile into itself plus its k rings of neighbors — the same
 * function used for both the REST `by-tile` endpoints and WebSocket subscription
 * registration, so both share identical "nearby tiles" semantics (see the
 * realtime module and each entity's routes file).
 */
export function expandTile(tile: string, k: number): string[] {
  return gridDisk(tile, k);
}
