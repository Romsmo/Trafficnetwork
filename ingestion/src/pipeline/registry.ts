import type { SourceId } from "../config/sources.js";
import type { SourceWorker } from "./worker.js";

/**
 * Only "osm" is registered as of P3.1 — its worker is built in P3.2
 * (pipeline/osm/worker.ts). HERE/TomTom/Mobilithek/Autobahn-API stay
 * catalog-only (config/sources.ts knows their ids and licensing status, but
 * no worker exists) per the project owner's decision for this round —
 * enabling any of them before then fails loudly in cli.ts rather than
 * silently doing nothing.
 */
export const WORKER_REGISTRY: Partial<Record<SourceId, SourceWorker>> = {};
