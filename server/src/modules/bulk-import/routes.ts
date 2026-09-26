import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  bulkInsertFixedSpeedCameras,
  bulkInsertSpeedLimitSegments,
  bulkInsertStaticSigns,
} from "../../db/queries/bulk-import.js";
import { requireScope } from "../auth/hook.js";
import { PERSISTENT_CAMERA_TYPES } from "../../config/constants.js";
import { badRequest } from "../../lib/errors.js";


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
  // Add-on D: which persistent device this is. Omitted = a speed camera, exactly as before.
  cameraType: z.enum(PERSISTENT_CAMERA_TYPES).optional(),
  source: z.string().min(1),
  sourceLicense: z.string().optional(),
  importedAt: z.string().datetime().optional(),
});

function rowsSchema<T extends z.ZodTypeAny>(row: T, maxRows: number) {
  return z.object({ rows: z.array(row).min(1).max(maxRows) });
}

/** Room for BULK_IMPORT_MAX_ROWS rows of JSON (a long segment is a few KB); Fastify's default body limit is 1 MiB. */
const BULK_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * A normal, publicly documented API endpoint with an elevated permission level —
 * not a special access path hardcoded for one future ingestion program (see
 * docs/prompt-phase1-server.md section 1 and docs/concept.md section 7). Any
 * authenticated client holding the bulk-import scope may call these.
 */
export async function registerBulkImportRoutes(app: FastifyInstance) {
  const maxRows = app.deps.env.BULK_IMPORT_MAX_ROWS;
  const importOptions = { partitionResolution: app.deps.env.STATIC_DATA_PARTITION_H3_RESOLUTION };
  const route = { preHandler: requireScope("bulk-import"), bodyLimit: BULK_BODY_LIMIT_BYTES };

  app.post("/v1/bulk-import/speed-limit-segments", route, async (req) => {
    const parsed = rowsSchema(speedLimitSegmentRowSchema, maxRows).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request body", parsed.error.issues);
    const inserted = await bulkInsertSpeedLimitSegments(app.deps.db, parsed.data.rows, importOptions);
    return { inserted };
  });

  app.post("/v1/bulk-import/static-signs", route, async (req) => {
    const parsed = rowsSchema(staticSignRowSchema, maxRows).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request body", parsed.error.issues);
    const inserted = await bulkInsertStaticSigns(app.deps.db, parsed.data.rows, importOptions);
    return { inserted };
  });

  app.post("/v1/bulk-import/speed-cameras", route, async (req) => {
    const parsed = rowsSchema(fixedSpeedCameraRowSchema, maxRows).safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid request body", parsed.error.issues);
    const inserted = await bulkInsertFixedSpeedCameras(app.deps.db, parsed.data.rows, importOptions);
    return { inserted };
  });
}
