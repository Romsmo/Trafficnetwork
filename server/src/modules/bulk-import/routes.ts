import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  bulkInsertFixedSpeedCameras,
  bulkInsertSpeedLimitSegments,
  bulkInsertStaticSigns,
} from "../../db/queries/bulk-import.js";
import { requireScope } from "../auth/hook.js";
import { badRequest } from "../../lib/errors.js";
import { publishEvent } from "../realtime/publisher.js";
import { retireSeedReports, upsertSeedReports } from "./seed-reports.js";

const BULK_IMPORT_MAX_ROWS = 5000;

const latLng = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

const speedLimitSegmentRowSchema = z.object({
  lineString: z.array(latLng).min(2),
  speedLimit: z.number().positive(),
  speedLimitUnit: z.enum(["kmh", "mph"]),
  source: z.string().min(1),
  sourceLicense: z.string().optional(),
  importedAt: z.string().datetime().optional(),
});

const staticSignRowSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  signType: z.string().min(1),
  source: z.string().min(1),
  sourceLicense: z.string().optional(),
  importedAt: z.string().datetime().optional(),
});

const fixedSpeedCameraRowSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  source: z.string().min(1),
  sourceLicense: z.string().optional(),
  importedAt: z.string().datetime().optional(),
});

// Seed reports (roadworks etc. from a periodically re-imported feed) — see ./seed-reports.ts for the lifecycle.
const feedIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/, "feedId: lowercase letters, digits, '.', '_' and '-' only");
const runIdSchema = z.string().min(1).max(100);

const seedReportSchema = z.object({
  externalId: z.string().min(1).max(200),
  // Only roadworks for now; the enum is the extension point for other authoritative time-limited types.
  type: z.enum(["construction"]),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  endsAt: z.string().datetime({ offset: true }).optional(),
  ttlHours: z.number().int().min(1).max(24 * 90).optional(),
});

const seedReportsBodySchema = z.object({
  feedId: feedIdSchema,
  runId: runIdSchema,
  // Provenance is mandatory for seed data (docs/concept.md section 3.2): a feed can be removed later by license or source.
  sourceLicense: z.string().min(1).max(200),
  reports: z.array(seedReportSchema).min(1).max(BULK_IMPORT_MAX_ROWS),
});

const retireSeedReportsBodySchema = z.object({ feedId: feedIdSchema, runId: runIdSchema });

function rowsSchema<T extends z.ZodTypeAny>(row: T) {
  return z.object({ rows: z.array(row).min(1).max(BULK_IMPORT_MAX_ROWS) });
}

/**
 * A normal, publicly documented API endpoint with an elevated permission level —
 * not a special access path hardcoded for one future ingestion program (see
 * docs/prompt-phase1-server.md section 1 and docs/concept.md section 7). Any
 * authenticated client holding the bulk-import scope may call these.
 */
export async function registerBulkImportRoutes(app: FastifyInstance) {
  app.post(
    "/v1/bulk-import/speed-limit-segments",
    { preHandler: requireScope("bulk-import") },
    async (req) => {
      const parsed = rowsSchema(speedLimitSegmentRowSchema).safeParse(req.body);
      if (!parsed.success) throw badRequest("Invalid request body", parsed.error.issues);
      const inserted = await bulkInsertSpeedLimitSegments(app.deps.db, parsed.data.rows);
      return { inserted };
    },
  );

  app.post("/v1/bulk-import/static-signs", { preHandler: requireScope("bulk-import") }, async (req) => {
    const parsed = rowsSchema(staticSignRowSchema).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request body", parsed.error.issues);
    const inserted = await bulkInsertStaticSigns(app.deps.db, parsed.data.rows);
    return { inserted };
  });

  app.post("/v1/bulk-import/speed-cameras", { preHandler: requireScope("bulk-import") }, async (req) => {
    const parsed = rowsSchema(fixedSpeedCameraRowSchema).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request body", parsed.error.issues);
    const inserted = await bulkInsertFixedSpeedCameras(app.deps.db, parsed.data.rows);
    return { inserted };
  });

  // Upsert one batch of a feed's current reports. Idempotent: re-sending the same batch changes nothing.
  app.post("/v1/bulk-import/seed-reports", { preHandler: requireScope("bulk-import") }, async (req) => {
    const parsed = seedReportsBodySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request body", parsed.error.issues);
    const { events, ...counts } = await upsertSeedReports(app.deps.db, app.deps.env, { ...parsed.data, reporterId: req.auth!.sub });
    for (const event of events) publishEvent(app.realtime, event); // after commit, like every other write path
    return counts;
  });

  // Finish a COMPLETE run of a feed: the active reports of that feed this run did not re-send are over.
  app.post("/v1/bulk-import/seed-reports/retire", { preHandler: requireScope("bulk-import") }, async (req) => {
    const parsed = retireSeedReportsBodySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request body", parsed.error.issues);
    const { events, retired } = await retireSeedReports(app.deps.db, parsed.data.feedId, parsed.data.runId);
    for (const event of events) publishEvent(app.realtime, event);
    return { retired };
  });
}
