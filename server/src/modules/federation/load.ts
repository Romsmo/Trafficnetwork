import type { Env } from "../../config/env.js";

/**
 * Overload signal (F-S4): a simple in-process gauge of how many
 * POST /v1/federation/events pushes this server is currently processing
 * concurrently. Module-level state (not per-request) deliberately — the
 * whole point is a process-wide capacity signal, not something scoped to one
 * request. modules/federation/routes.ts gates on it (503 + Retry-After); the
 * heartbeat-send worker (modules/federation/workers.ts) reports it to peers
 * as `capacityHint` so they can see this server trending toward saturation
 * before it actually starts rejecting pushes.
 */
let concurrentPushes = 0;

export function beginPush(): void {
  concurrentPushes += 1;
}

export function endPush(): void {
  concurrentPushes -= 1;
}

export function getConcurrentPushes(): number {
  return concurrentPushes;
}

/** 0 (idle) to 1 (at or over the configured concurrency limit). */
export function getCapacityHint(env: Pick<Env, "FEDERATION_OVERLOAD_MAX_CONCURRENT_PUSHES">): number {
  return Math.min(1, concurrentPushes / env.FEDERATION_OVERLOAD_MAX_CONCURRENT_PUSHES);
}

/** Test-only: resets the gauge between test cases. */
export function resetLoadGaugeForTests(): void {
  concurrentPushes = 0;
}
