import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  bulkInsertFixedSpeedCameras,
  bulkInsertSpeedLimitSegments,
  bulkInsertStaticSigns,
} from "../../db/queries/bulk-import.js";
import { requireScope } from "../auth/hook.js";
import { badRequest } from "../../lib/errors.js";

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
}
