import type { SourceId } from "../config/sources.js";
import { nvdbNoWorker } from "./nvdb/worker.js";
import { osmWorker } from "./osm/worker.js";
import type { SourceWorker } from "./worker.js";

/**
 * "osm" is registered as of P3.2, "nvdb-no" (official Norwegian sign plates) as of add-on Q4. HERE/TomTom/Mobilithek/Autobahn-API stay
 * catalog-only (config/sources.ts knows their ids and licensing status, but
 * no worker exists) per the project owner's decision for this round —
 * enabling any of them fails loudly in cli.ts rather than silently doing
 * nothing.
 */
export const WORKER_REGISTRY: Partial<Record<SourceId, SourceWorker>> = {
  osm: osmWorker,
  "nvdb-no": nvdbNoWorker,
};
