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

  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  SPEED_LIMIT_LOOKUP_MAX_DISTANCE_METERS: z.coerce.number().int().positive().default(200),

  REGION_TILE_H3_RESOLUTION: z.coerce.number().int().min(0).max(15).default(7),
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
