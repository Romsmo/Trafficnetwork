import { z } from "zod";

const csv = (value: string): string[] => value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

const envSchema = z
  .object({
    SERVER_URL: z.string().url("SERVER_URL must be a valid URL"),
    CLIENT_ID: z.string().min(1, "CLIENT_ID is required"),
    CLIENT_SECRET: z.string().min(1, "CLIENT_SECRET is required"),

    // Where per-region/per-source progress state lives (state/store.ts) —
    // this directory is the *only* thing standing between a resumed run and
    // re-posting rows the server already accepted (the server itself has no
    // dedup of its own). Never delete it between runs unless you mean to
    // duplicate everything already imported.
    STATE_DIR: z.string().default("./.ingestion-state"),

    // Where downloaded source extracts (e.g. Geofabrik .osm.pbf files) are
    // cached between runs, keyed by region — re-used if its checksum still
    // matches instead of re-downloading a multi-hundred-MB file every time.
    DOWNLOAD_DIR: z.string().default("./.ingestion-downloads"),

    // Overrides config/regions.json's path — mainly for integration tests to
    // point at a fixture-backed region catalog instead of the real one.
    REGIONS_CONFIG_PATH: z.string().optional(),

    // Rows per bulk-import API call. Server hard-caps at 5000; kept well
    // below that by default so a crash's duplication blast radius (see
    // state/store.ts) stays small, at the cost of more HTTP round trips.
    BATCH_SIZE: z.coerce.number().int().positive().max(5000).default(2000),

    // Pause after every committed batch (ms) — a pacing floor that keeps a server's CPU/IO bounded
    // during a multi-hour import. 0 = as fast as the server answers.
    BATCH_PACING_MS: z.coerce.number().int().nonnegative().default(0),

    // Abort the run when more rows than this end up quarantined (client-side invalid or rejected by
    // the server): stray bad rows are expected, hundreds are a systematic problem.
    MAX_QUARANTINED: z.coerce.number().int().positive().default(500),

    // Where osmium keeps its node-location index (≈16 B per node, randomly accessed). Put it on an
    // SSD. Default: next to the other osmium work files under DOWNLOAD_DIR.
    OSMIUM_INDEX_DIR: z.string().optional(),

    HTTP_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
    HTTP_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(500),
    HTTP_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(30_000),

    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    // Only OSM is on by default (docs/prompt-phase3-ingestion.md section 1:
    // "Standardmäßig sind diese Quellen aus; nur OSM ist standardmäßig an").
    OSM_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
    HERE_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    TOMTOM_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    MOBILITHEK_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    AUTOBAHN_API_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),

    // Roadworks feeds (pipeline/roadworks/, config/roadworks-feeds.json). Each feed has its own enabled
    // flag in that file; a feed whose terms are not settled ships disabled. These are the operator's switches:
    ROADWORKS_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"), // global kill switch
    ROADWORKS_FEEDS_ON: z.string().default("").transform(csv), // enable these feed ids on purpose
    ROADWORKS_FEEDS_OFF: z.string().default("").transform(csv), // disable these (wins over everything)
    ROADWORKS_FEEDS_CONFIG_PATH: z.string().optional(),
    // A roadwork that starts within this many minutes is already sent (0 = only once it has started).
    ROADWORKS_LOOKAHEAD_MINUTES: z.coerce.number().int().nonnegative().default(30),
    // The same roadwork in two feeds within this distance (and overlapping in time) is created once.
    ROADWORKS_MERGE_RADIUS_METERS: z.coerce.number().int().positive().default(250),

    // No default: current HERE/TomTom free-tier pricing could not be pinned
    // to one confirmed authoritative number as of this project's own source
    // research (see ingestion/docs/sources.md) — a hardcoded limit would
    // silently encode a figure nobody could verify is still current. The
    // operator must set this from their own account/contract before either
    // source can be enabled.
    HERE_MONTHLY_CALL_LIMIT: z.coerce.number().int().positive().optional(),
    TOMTOM_MONTHLY_CALL_LIMIT: z.coerce.number().int().positive().optional(),
  })
  .refine((env) => !env.HERE_ENABLED || env.HERE_MONTHLY_CALL_LIMIT !== undefined, {
    message: "HERE_MONTHLY_CALL_LIMIT is required whenever HERE_ENABLED=true — no default exists (see ingestion/docs/sources.md)",
    path: ["HERE_MONTHLY_CALL_LIMIT"],
  })
  .refine((env) => !env.TOMTOM_ENABLED || env.TOMTOM_MONTHLY_CALL_LIMIT !== undefined, {
    message: "TOMTOM_MONTHLY_CALL_LIMIT is required whenever TOMTOM_ENABLED=true — no default exists (see ingestion/docs/sources.md)",
    path: ["TOMTOM_MONTHLY_CALL_LIMIT"],
  });

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

/** Test-only: forces the next loadEnv() call to re-parse instead of returning the cached value. */
export function resetEnvCache(): void {
  cachedEnv = undefined;
}
