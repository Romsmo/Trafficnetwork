import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { hazardReports } from "../../db/schema/index.js";
import { appendEvent } from "../../db/append-event.js";
import { isCameraType } from "../cameras/filter.js";
import type { HazardType } from "../../config/constants.js";

export interface ReportToExpire {
  id: string;
  type: string;
  regionTile: string;
  source: string;
  /** Country set of a camera report (null for every other type) - travels with the event, see db/queries/camera-record.ts. */
  countries: string[] | null;
  /** GeoJSON Point of the report. */
  position: unknown;
}

/**
 * Flips one active report to `expired` and appends its `ReportExpired` event, inside the caller's transaction. The
 * one place that does it, so the periodic sweep (modules/expiry/worker.ts) and an early end through "gone" votes
 * (modules/hazard-reports/service.ts) produce the identical state and event — clients need nothing new to handle it.
 */
export async function markReportExpired(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: PgTransaction<any, any, any>,
  report: ReportToExpire,
) {
  await tx.update(hazardReports).set({ status: "expired", updatedAt: sql`now()` }).where(sql`id = ${report.id}`);

  return appendEvent(tx, {
    type: "ReportExpired",
    entityType: "hazardReport",
    entityId: report.id,
    // A camera report's expiry also names its position: the delivery layer needs it to find the zone that changed
    // (it is only ever sent on where the camera was delivered individually in the first place).
    payload: isCameraType(report.type as HazardType)
      ? { id: report.id, type: report.type, status: "expired", position: report.position }
      : { id: report.id, type: report.type, status: "expired" },
    regionTile: report.regionTile,
    cameraCountries: report.countries,
    source: report.source,
  });
}
