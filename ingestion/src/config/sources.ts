import type { Env } from "./env.js";

/**
 * The full source catalog (ingestion/docs/sources.md has the evidence for
 * each). "osm" (P3.2) and "nvdb-no" (official Norwegian sign plates, add-on Q4) have real
 * workers; here, tomtom, mobilithek and autobahn-api are catalog-only entries (documented,
 * off, not implemented) per the project owner's decision, kept here so config/CLI
 * validation already knows their names and doesn't need a later breaking change to add a real worker.
 */
export const SOURCE_IDS = ["osm", "here", "tomtom", "mobilithek", "autobahn-api", "nvdb-no"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export interface SourceConfig {
  id: SourceId;
  enabled: boolean;
  /** Only set for metered sources (here/tomtom) with enabled=true. */
  killSwitch?: { maxCalls: number };
}

export function resolveSources(env: Env): Record<SourceId, SourceConfig> {
  return {
    osm: { id: "osm", enabled: env.OSM_ENABLED },
    here: {
      id: "here",
      enabled: env.HERE_ENABLED,
      killSwitch: env.HERE_ENABLED ? { maxCalls: requireLimit(env.HERE_MONTHLY_CALL_LIMIT, "HERE_MONTHLY_CALL_LIMIT") } : undefined,
    },
    tomtom: {
      id: "tomtom",
      enabled: env.TOMTOM_ENABLED,
      killSwitch: env.TOMTOM_ENABLED ? { maxCalls: requireLimit(env.TOMTOM_MONTHLY_CALL_LIMIT, "TOMTOM_MONTHLY_CALL_LIMIT") } : undefined,
    },
    mobilithek: { id: "mobilithek", enabled: env.MOBILITHEK_ENABLED },
    "autobahn-api": { id: "autobahn-api", enabled: env.AUTOBAHN_API_ENABLED },
    "nvdb-no": { id: "nvdb-no", enabled: env.NVDB_NO_ENABLED },
  };
}

function requireLimit(value: number | undefined, name: string): number {
  // env.ts's own .refine() already guarantees this at load time — this is
  // just a type-narrowing guard, not a second source of the validation.
  if (value === undefined) throw new Error(`${name} missing despite being required by env validation`);
  return value;
}
