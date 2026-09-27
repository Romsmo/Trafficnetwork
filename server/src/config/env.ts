import { z } from "zod";
import { isAcceptableFederationAddress } from "../modules/federation/address.js";
import { DEFAULT_MAP_TILE_URL, isAcceptableTileUrl } from "../modules/web/tile.js";

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

  // H3 resolution that partitions the static-data packages/manifest
  // (client-lib P2.0) — much coarser than REGION_TILE_H3_RESOLUTION, since a
  // package carries the full static dataset of its tile, not per-request filtering.
  //
  // 4 (≈ 1,770 km² per tile, a few MB per package at Europe density) since the
  // Europe add-on (docs/europe-scale.md): the former 2 gave tiles of hundreds of MB.
  // Decided by the operator 2026-09-25 while there are no real users — changing it
  // later means every device re-downloads everything (the tile ids change), and
  // **every node of a network must use the same value**, or their packages are
  // incompatible and clients download twice. The value is in GET /v1/config
  // (`staticDataPartitionH3Resolution`) and in every manifest (`partitionResolution`)
  // so a client can notice a deviation instead of silently syncing garbage.
  STATIC_DATA_PARTITION_H3_RESOLUTION: z.coerce.number().int().min(0).max(15).default(4),

  // Disk-backed, pre-built static-data packages (add-on E-B, docs/europe-scale.md).
  // Where the content-addressed package files live. In Docker this is a volume
  // (docker-compose.yml); a Europe-sized set needs roughly the compressed size of
  // the dataset (see docs/operating.md for measured numbers).
  STATIC_PACKAGES_DIR: z.string().min(1).default("./data/static-packages"),
  // false: this process never builds packages in the background (build them with
  // `npm run static-packages -- build`, or run the worker in another process).
  STATIC_PACKAGES_WORKER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // The worker waits until static data has been quiet this long before rebuilding
  // the tiles a write touched — a bulk import marks tiles for hours and must not
  // trigger a rebuild per batch. (It still rebuilds after STATIC_PACKAGES_MAX_WAIT_SECONDS
  // of continuous writes, so packages are never starved indefinitely.)
  STATIC_PACKAGES_DEBOUNCE_SECONDS: z.coerce.number().int().nonnegative().default(30),
  STATIC_PACKAGES_MAX_WAIT_SECONDS: z.coerce.number().int().positive().default(900),
  // Up to this many static rows the packages are built on demand, inside the
  // first request that needs them (today's behaviour, no waiting for a worker).
  // Above it a request that finds no complete package set answers 503 +
  // Retry-After until the worker has finished the initial build.
  STATIC_PACKAGES_INLINE_BUILD_MAX_ROWS: z.coerce.number().int().nonnegative().default(200_000),
  // Rows fetched per round trip while streaming a tile into its file — bounds
  // the builder's memory regardless of how big a tile is.
  STATIC_PACKAGES_PAGE_ROWS: z.coerce.number().int().positive().default(5000),
  // Compression of the stored files. gzip 9 / brotli 9 are slow but the packages
  // are built once and downloaded many times; lower them if builds are too slow.
  STATIC_PACKAGES_GZIP_LEVEL: z.coerce.number().int().min(1).max(9).default(9),
  STATIC_PACKAGES_BROTLI_QUALITY: z.coerce.number().int().min(0).max(11).default(9),
  // How long a replaced package file is kept, so a client that started
  // downloading it before the rebuild can finish.
  STATIC_PACKAGES_KEEP_MINUTES: z.coerce.number().int().nonnegative().default(120),
  // true: GET /v1/static-data/packages/:tile/:hash needs no Authorization header,
  // so a reverse proxy or CDN can cache and serve it. The data is public OSM data
  // and the URL is content-addressed, but it does mean anyone can download it
  // from your server (or your CDN) without a client credential — hence off by default.
  STATIC_PACKAGES_PUBLIC: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // GET /v1/snapshot with static data reads every static row into memory. Above
  // this many rows it answers 413 and points at the manifest/package endpoints
  // instead of taking the process down. 0 disables the check.
  SNAPSHOT_STATIC_MAX_ROWS: z.coerce.number().int().nonnegative().default(1_000_000),
  // Rows accepted per POST /v1/bulk-import/* call.
  BULK_IMPORT_MAX_ROWS: z.coerce.number().int().positive().max(50_000).default(5000),

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

  // Reputation (F-S4, modules/federation/reputation.ts) — thresholds for the
  // three-tier probation → active → trusted ladder, all measured from this
  // server's own active health checks of a peer (never self-reported). See
  // the F-S0 plan's decision 5 for the reasoning; these are the "konkrete
  // Zahlen als Vorschlag" it deferred to this milestone.
  REPUTATION_PROBATION_MIN_HOURS: z.coerce.number().int().positive().default(24),
  REPUTATION_MIN_SUCCESSFUL_HEALTH_CHECKS: z.coerce.number().int().positive().default(5),
  REPUTATION_TRUSTED_MIN_HOURS: z.coerce.number().int().positive().default(24 * 7),
  REPUTATION_TRUSTED_MIN_SUCCESSFUL_HEALTH_CHECKS: z.coerce.number().int().positive().default(50),
  // Consecutive failed health checks (heartbeat send or anti-entropy pull)
  // before a peer is demoted back to probation — reset to 0 by any success.
  REPUTATION_DEMOTE_AFTER_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(5),
  // Directory listing cap for probation-tier peers (GET /v1/network/directory)
  // — a fraction of the *total* listed peers, not of probation peers alone.
  // Keeps a brand-new server discoverable without letting a flood of unproven
  // servers dominate the list (the F-S0 plan's "gedeckelter Verzeichnis-Anteil
  // für Probezeit-Server").
  REPUTATION_DIRECTORY_PROBATION_MAX_SHARE: z.coerce.number().min(0).max(1).default(0.5),

  // Overload signal (F-S4): POST /v1/federation/events returns 503 +
  // Retry-After once this many pushes are being processed concurrently by
  // this process, rather than degrading everyone's latency under load.
  FEDERATION_OVERLOAD_MAX_CONCURRENT_PUSHES: z.coerce.number().int().positive().default(20),

  // Community speed-limit corrections (add-on K-A, docs/speed-limit-corrections.md).
  // Master switch: false removes the overlay from every read (imported values
  // are served again), unregisters the write/list endpoints and makes
  // federation ignore votes. Stored votes/corrections are kept, so switching
  // it back on restores them.
  COMMUNITY_CORRECTIONS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Net confirmations (distinct supporting devices minus distinct denying
  // devices) a proposed value needs before it overrides the imported one. The
  // operator's safety decision — 3 by default, never a constant in code.
  COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED: z.coerce.number().int().positive().default(3),
  // Plausible range per unit, in the segment's own unit (a correction never
  // converts). Bounds cover what is actually posted in Europe (140 km/h at
  // most on a few motorways; 70 mph UK, 85 mph as a generous ceiling).
  COMMUNITY_CORRECTIONS_KMH_MIN: z.coerce.number().int().positive().default(5),
  COMMUNITY_CORRECTIONS_KMH_MAX: z.coerce.number().int().positive().default(150),
  COMMUNITY_CORRECTIONS_MPH_MIN: z.coerce.number().int().positive().default(5),
  COMMUNITY_CORRECTIONS_MPH_MAX: z.coerce.number().int().positive().default(85),
  // Proposed values must be a multiple of this (posted limits are multiples of
  // 5 almost everywhere; catches fat-finger values like 55 for 5). 1 disables.
  COMMUNITY_CORRECTIONS_VALUE_STEP: z.coerce.number().int().positive().default(5),
  // Per calling client, deliberately stricter than the 10-per-10-minutes budget
  // for hazard reports: a correction is a durable, safety-relevant claim.
  COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  COMMUNITY_CORRECTIONS_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),

  // "Currently online" counter (add-on O-A, modules/online/, GET /v1/stats/online).
  // Numbers only, kept in process memory — nothing here is ever stored or logged.
  // false: the endpoint still answers, with `{ "enabled": false }`, and nothing is tracked.
  ONLINE_COUNTER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // A client that made a sync or write request within this window counts as
  // online (open WebSocket connections count for as long as they are open).
  // 0 = only open WebSocket connections count.
  ONLINE_WINDOW_SECONDS: z.coerce.number().int().nonnegative().default(300),
  // Below this many, the endpoint says "fewer than N" instead of the exact
  // number ("1 online" would be a statement about one person). 0 = never mask.
  ONLINE_MIN_DISPLAY_THRESHOLD: z.coerce.number().int().nonnegative().default(5),
  // How long a computed answer is reused. 0 = compute on every request.
  ONLINE_CACHE_SECONDS: z.coerce.number().int().nonnegative().default(10),
  // A peer's reported figure (carried in its signed heartbeat) stops counting
  // towards the network estimate when its last heartbeat is older than this.
  ONLINE_PEER_STALE_SECONDS: z.coerce.number().int().positive().default(300),
  // Upper bound on distinct clients remembered for the activity window — keeps
  // memory bounded (~100 bytes each); beyond it new clients are not added.
  ONLINE_MAX_TRACKED: z.coerce.number().int().positive().default(100_000),
  // Reverse-proxy awareness. Unset/"false" = use the socket address (right when clients connect
  // directly). Behind Caddy/nginx/Apache every client would otherwise look like the proxy, so all
  // per-IP limits (token exchange, device registration, web sessions) would be shared by everyone.
  // "true" (trust every hop — only safe if the server is reachable ONLY through the proxy), a hop
  // count ("1"), or a comma-separated list of proxy IPs/CIDRs. See docs/web-ui.md.
  TRUST_PROXY: z.string().optional(),

  // Request logs contain the client's exact coordinates (query string) and IP address. With this on
  // (default) request logs keep only method, path and host — no query string, no client address.
  LOG_PRIVACY_MODE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Built-in web UI (server/web, docs/web-ui.md): map, reporting, connect guide. Off = the node serves
  // the API only and none of the web routes (including POST /v1/web/session) exist.
  WEB_UI_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Shown in the web UI footer/about page; one place to change for a fork or after publication.
  PROJECT_REPO_URL: z.string().url().default("https://github.com/Romsmo/Trafficnetwork"),
  // Raster tile source for the web UI map, with {z}/{x}/{y} placeholders. Unset or empty = the default,
  // OpenStreetMap's public tile server, whose usage policy
  // (https://operations.osmfoundation.org/policies/tiles/) is not meant for heavy use: a node with
  // real traffic should point this at its own or a commercial tile service. "none" = no map background.
  // No API keys in here — the URL is visible to every visitor. (Empty means "default" rather than "off"
  // because docker-compose passes an unset variable through as an empty string.) After parsing, "" means off.
  MAP_TILE_URL: z
    .string()
    .default("")
    .transform((value) => (value.trim() === "" ? DEFAULT_MAP_TILE_URL : value.trim().toLowerCase() === "none" ? "" : value.trim())),
  MAP_TILE_ATTRIBUTION_TEXT: z.string().min(1).default("© OpenStreetMap contributors"),
  MAP_TILE_ATTRIBUTION_URL: z.string().url().default("https://www.openstreetmap.org/copyright"),
  MAP_TILE_MAX_ZOOM: z.coerce.number().int().min(1).max(22).default(19),

  // Web sessions (POST /v1/web/session): anonymous, short-lived, unlinkable between renewals.
  WEB_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  WEB_SESSION_MINT_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  // Write limits for web sessions, in addition to the ordinary moderation gate (REPORT_RATE_LIMIT_*):
  // per session within the REPORT_RATE_LIMIT_WINDOW_MINUTES window, per client IP per hour, and a
  // per-node circuit breaker per hour for all web sessions together.
  WEB_REPORT_LIMIT_PER_SESSION: z.coerce.number().int().positive().default(3),
  WEB_REPORT_LIMIT_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(10),
  WEB_REPORT_LIMIT_NODE_PER_HOUR: z.coerce.number().int().positive().default(300),
  WEB_READ_LIMIT_PER_IP_PER_MINUTE: z.coerce.number().int().positive().default(120),
  WEB_HEAVY_READ_LIMIT_PER_IP_PER_MINUTE: z.coerce.number().int().positive().default(30),
  WEB_MAX_SEGMENT_RADIUS_M: z.coerce.number().int().positive().max(50_000).default(1500),
  WEB_MAX_HAZARD_RADIUS_M: z.coerce.number().int().positive().max(50_000).default(25_000),
  WEB_WS_MAX_TILES_PER_CONNECTION: z.coerce.number().int().positive().default(60),
}).refine((env) => env.COMMUNITY_CORRECTIONS_KMH_MIN <= env.COMMUNITY_CORRECTIONS_KMH_MAX, {
  message: "COMMUNITY_CORRECTIONS_KMH_MIN must not exceed COMMUNITY_CORRECTIONS_KMH_MAX",
  path: ["COMMUNITY_CORRECTIONS_KMH_MIN"],
}).refine((env) => env.COMMUNITY_CORRECTIONS_MPH_MIN <= env.COMMUNITY_CORRECTIONS_MPH_MAX, {
  message: "COMMUNITY_CORRECTIONS_MPH_MIN must not exceed COMMUNITY_CORRECTIONS_MPH_MAX",
  path: ["COMMUNITY_CORRECTIONS_MPH_MIN"],
}).refine((env) => isAcceptableTileUrl(env.MAP_TILE_URL), {
  message: "MAP_TILE_URL must be empty (no map background) or an http(s) URL containing {z}, {x} and {y} (no {s} subdomain placeholder, no credentials)",
  path: ["MAP_TILE_URL"],
}).refine((env) => !env.NETWORK_CONFIG_PATH || env.NETWORK_ROOT_PUBLIC_KEY, {
  message: "NETWORK_ROOT_PUBLIC_KEY is required whenever NETWORK_CONFIG_PATH is set — a signed config can't be verified without it",
  path: ["NETWORK_ROOT_PUBLIC_KEY"],
}).refine((env) => !env.FEDERATION_ENABLED || env.FEDERATION_PUBLIC_ADDRESS, {
  message: "FEDERATION_PUBLIC_ADDRESS is required whenever FEDERATION_ENABLED=true — peers need a reachable address to join/heartbeat back to",
  path: ["FEDERATION_PUBLIC_ADDRESS"],
}).refine((env) => !env.FEDERATION_PUBLIC_ADDRESS || isAcceptableFederationAddress(env.FEDERATION_PUBLIC_ADDRESS), {
  message: "FEDERATION_PUBLIC_ADDRESS must be an https:// URL (docs/threat-model.md: no self-hosted server identity over plain HTTP; a bare http://127.0.0.1 or http://localhost loopback literal is the one exception, for local testing)",
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
