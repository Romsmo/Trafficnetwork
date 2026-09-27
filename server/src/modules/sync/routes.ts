import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateSnapshot } from "./snapshot.service.js";
import { getDeltaPage, SnapshotRequiredError } from "../../db/queries/event-log.js";
import { parseCsv, parseHazardTypes } from "../../lib/query-params.js";
import { ApiError, badRequest, conflict } from "../../lib/errors.js";
import { resolveSyncHazardTypes } from "../cameras/filter.js";
import { estimateStaticRows } from "../../db/queries/static-packages.js";

const DELTA_LIMIT_DEFAULT = 500;
const DELTA_LIMIT_MAX = 5000;

export async function registerSyncRoutes(app: FastifyInstance) {
  app.get("/v1/snapshot", async (req) => {
    const query = req.query as Record<string, unknown>;
    const tiles = parseCsv(query.tiles);
    const types = parseHazardTypes(query.types);
    // A snapshot with static data reads every static row into memory (~2.5 KB of process memory per
    // row, measured — docs/europe-scale.md). Past SNAPSHOT_STATIC_MAX_ROWS that would take the whole
    // server down for one request, so refuse it and point at the package endpoints instead.
    const maxStaticRows = app.deps.env.SNAPSHOT_STATIC_MAX_ROWS;
    if (query.staticData !== "false" && maxStaticRows > 0 && (await estimateStaticRows(app.deps.db, maxStaticRows)) > maxStaticRows) {
      throw new ApiError(
        413,
        "STATIC_DATA_TOO_LARGE_FOR_SNAPSHOT",
        `This server holds more than ${maxStaticRows} static rows; a snapshot cannot include them. Request /v1/snapshot?staticData=false and fetch the static data through /v1/static-data/manifest and the packages it lists.`,
        { limit: maxStaticRows, use: ["/v1/snapshot?staticData=false", "/v1/static-data/manifest"] },
      );
    }
    const result = await generateSnapshot(app.deps.db, {
      tiles,
      types,
      cameraNamespaceEnabled: app.deps.env.SPEED_CAMERA_NAMESPACE_ENABLED,
      communityCorrectionsEnabled: app.deps.env.COMMUNITY_CORRECTIONS_ENABLED,
      // ?staticData=false (client-lib P2.0): omit the static-entity payload for
      // a client that already has it via /v1/static-data/{manifest,partitions}.
      includeStaticData: query.staticData !== "false",
    });
    return result;
  });

  app.get("/v1/delta", async (req) => {
    const query = req.query as Record<string, unknown>;
    const sinceSchema = z.coerce.number().int().nonnegative();
    const sinceResult = sinceSchema.safeParse(query.since);
    if (!sinceResult.success) {
      throw badRequest("since query parameter is required and must be a non-negative integer");
    }
    const tiles = parseCsv(query.tiles);
    const types = resolveSyncHazardTypes(parseHazardTypes(query.types), app.deps.env.SPEED_CAMERA_NAMESPACE_ENABLED);
    const limitResult = z.coerce.number().int().positive().max(DELTA_LIMIT_MAX).safeParse(query.limit);
    const limit = limitResult.success ? limitResult.data : DELTA_LIMIT_DEFAULT;

    try {
      const page = await getDeltaPage(app.deps.db, sinceResult.data, { tiles, types, limit });
      return page;
    } catch (err) {
      if (err instanceof SnapshotRequiredError) {
        throw conflict("SNAPSHOT_REQUIRED", err.message);
      }
      throw err;
    }
  });
}
