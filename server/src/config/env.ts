import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  SPEED_CAMERA_NAMESPACE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  EVENT_LOG_RETENTION_DAYS_DYNAMIC: z.coerce.number().int().positive().default(3),
  EVENT_LOG_RETENTION_DAYS_STATIC: z.coerce.number().int().positive().default(30),

  REPORT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  REPORT_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(10),
  DUPLICATE_MERGE_RADIUS_METERS: z.coerce.number().int().positive().default(500),
  SPEED_KMH_MIN: z.coerce.number().int().nonnegative().default(0),
  SPEED_KMH_MAX: z.coerce.number().int().positive().default(300),

  // Base expiry durations per docs/concept.md section 3.2. Hazard types are grouped
  // into the same three bands the concept doc's table uses, rather than one env var
  // per type, to avoid an unwieldy number of knobs for what is fundamentally one table.
  HAZARD_EXPIRY_SHORT_MINUTES: z.coerce.number().int().positive().default(12),
  HAZARD_EXPIRY_MEDIUM_MINUTES: z.coerce.number().int().positive().default(25),
  HAZARD_EXPIRY_CONSTRUCTION_DAYS: z.coerce.number().int().positive().default(7),

  // Distinct-reporter "this fixed camera is gone" votes needed before it's marked
  // removed (docs/concept.md section 8: "nur durch gehäufte 'nicht mehr da'-
  // Meldungen entfernt" — no specific number given, this is our chosen default).
  CAMERA_REMOVAL_THRESHOLD: z.coerce.number().int().positive().default(3),

  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  SPEED_LIMIT_LOOKUP_MAX_DISTANCE_METERS: z.coerce.number().int().positive().default(200),

  REGION_TILE_H3_RESOLUTION: z.coerce.number().int().min(0).max(15).default(7),

  // Coarse H3 resolution used to partition the static-data package/manifest
  // endpoints (client-lib P2.0) — deliberately much coarser than
  // REGION_TILE_H3_RESOLUTION, since these packages carry the full static
  // dataset per partition, not per-request filtering.
  STATIC_DATA_PARTITION_H3_RESOLUTION: z.coerce.number().int().min(0).max(15).default(2),

  // Anonymous device registration (client-lib P2.0): max devices a single app
  // key may register per rolling day, on top of the per-IP @fastify/rate-limit
  // on the route itself.
  DEVICE_REGISTRATION_RATE_LIMIT_MAX_PER_DAY: z.coerce.number().int().positive().default(50),

  // Self-hosting & federation (Phase F). false = isolated single server,
  // exactly today's behavior — see docs/federation.md section 4's "Ein
  // Betreiber kann den Beitritt abschalten" and the F-S0 plan's migration
  // path. Actual peer-to-peer join/gossip lands in F-S3; this flag exists
  // now because it already gates the signed-network-config precedence rule
  // below (F-S2).
  FEDERATION_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // The project's network root public key (Ed25519, raw base64url — see
  // modules/crypto/keys.ts), needed to verify a signed network config.
  // Optional: a non-federating operator has no network to trust a root key
  // for. Only ever the public half — the root private key never touches a
  // running server (docs/threat-model.md).
  NETWORK_ROOT_PUBLIC_KEY: z.string().optional(),

  // Path to a root-signed network config JSON file (a SignedEnvelope — see
  // modules/crypto/envelope.ts and modules/network/config.ts), produced
  // offline by scripts/network-sign-config.mts. Optional; when set, the
  // server refuses to start unless NETWORK_ROOT_PUBLIC_KEY is also set and
  // the file verifies against it (fail loudly rather than silently ignore a
  // bad/tampered config — see docs/threat-model.md's "Sicherheit vor
  // Bequemlichkeit" framing).
  NETWORK_CONFIG_PATH: z.string().optional(),

  // Federation protocol (F-S3): join over seeds, signed heartbeats,
  // event push/pull replication. All only relevant/read when
  // FEDERATION_ENABLED=true — see modules/federation/*.
  //
  // This server's own externally-reachable https:// base URL, told to peers
  // during join/heartbeat so they know how to reach back. Required whenever
  // FEDERATION_ENABLED is true (enforced by the refine below) — there is no
  // sensible default for "how the outside world reaches me".
  FEDERATION_PUBLIC_ADDRESS: z.string().url().optional(),
  // Comma-separated https:// base URLs of seed servers to join on startup.
  // Optional even when federating — a server can also be *only* ever joined
  // *to*, never itself initiate a join (e.g. the network's first server).
  FEDERATION_SEEDS: z.string().optional(),
  FEDERATION_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  FEDERATION_ANTI_ENTROPY_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  FEDERATION_ANTI_ENTROPY_PAGE_SIZE: z.coerce.number().int().positive().default(200),
  // How far in the past a replicated event's own timestamp may be and still
  // be accepted — deliberately generous compared to the 60s freshness window
  // used for short-lived auth assertions (modules/crypto/envelope.ts), since
  // anti-entropy is explicitly meant to catch a server back up after being
  // offline. Defaults to the same span as EVENT_LOG_RETENTION_DAYS_DYNAMIC's
  // default (3 days = 72h) — an event older than that would be purged again
  // immediately anyway.
  FEDERATION_EVENT_MAX_AGE_HOURS: z.coerce.number().int().positive().default(72),
  // Outbound HTTP timeout for calls to other servers (join/heartbeat/push/pull)
  // — an unreachable peer must never hang this server's own request handling
  // or background workers indefinitely.
  FEDERATION_PEER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
}).refine((env) => !env.NETWORK_CONFIG_PATH || env.NETWORK_ROOT_PUBLIC_KEY, {
  message: "NETWORK_ROOT_PUBLIC_KEY is required whenever NETWORK_CONFIG_PATH is set — a signed config can't be verified without it",
  path: ["NETWORK_ROOT_PUBLIC_KEY"],
}).refine((env) => !env.FEDERATION_ENABLED || env.FEDERATION_PUBLIC_ADDRESS, {
  message: "FEDERATION_PUBLIC_ADDRESS is required whenever FEDERATION_ENABLED=true — peers need a reachable address to join/heartbeat back to",
  path: ["FEDERATION_PUBLIC_ADDRESS"],
}).refine((env) => !env.FEDERATION_PUBLIC_ADDRESS || env.FEDERATION_PUBLIC_ADDRESS.startsWith("https://"), {
  message: "FEDERATION_PUBLIC_ADDRESS must be an https:// URL (docs/threat-model.md: no self-hosted server identity over plain HTTP)",
  path: ["FEDERATION_PUBLIC_ADDRESS"],
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

/** Test-only: forces the next loadEnv() call to re-parse instead of returning the cached value. */
export function resetEnvCache(): void {
  cachedEnv = undefined;
}
