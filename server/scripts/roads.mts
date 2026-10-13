import "dotenv/config";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { loadEnv } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { roadCounts } from "../src/db/queries/roads.js";
import { attachAll, countPending } from "../src/modules/roads/attach.js";
import { DEFECT_TARGET_TYPES, restoreRemoval, type DefectTargetType } from "../src/modules/defects/service.js";
import { resolveInterval } from "../src/modules/roads/resolve.js";

/**
 * Operator CLI for the road network and for entries visitors marked as wrong (docs/road-network.md) - no admin HTTP API,
 * same reasoning as create-client. Everything here is local: it changes what THIS server serves and is never replicated.
 * Run it against the same DATABASE_URL / .env as the server.
 *
 *   npm run roads -- status                       what the node knows: ways, covered areas, items by attach status
 *   npm run roads -- attach                       one pass of the attach step now (the worker does this every few minutes)
 *   npm run roads -- lookup <lat1,lng1> <lat2,lng2>   which stretch of which road two points name (the preview a visitor gets)
 *   npm run roads -- defects [--limit 50]         entries taken out because enough visitors marked them as wrong
 *   npm run roads -- reports [--limit 50]         entries marked as wrong that are not out yet
 *   npm run roads -- restore <speedLimitSegment|staticSign> <match-key>   show a removed entry again
 *
 * The attach worker stops with ROAD_ATTACH_WORKER_ENABLED=false (restart); the lookup service with ROAD_LOOKUP_URL=none.
 */

function parsePoint(text: string | undefined): { lat: number; lng: number } {
  const [lat, lng] = (text ?? "").split(",").map(Number);
  if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(`"${text ?? ""}" is not "<lat>,<lng>"`);
  return { lat, lng };
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { limit: { type: "string" } } });
  const [command, a, b] = positionals;
  const env = loadEnv();
  const { db, client } = createDb(env);
  const limit = Math.max(1, Math.min(1000, Number(values.limit ?? 50)));

  try {
    switch (command) {
      case "status": {
        const counts = await roadCounts(db);
        console.log(`ways: ${counts.ways}   covered areas (res 8): ${counts.coveredTiles}`);
        for (const table of ["static_signs", "fixed_speed_cameras"] as const) {
          const rows = await db.execute<{ attach_status: string; visible: boolean; n: number } & Record<string, unknown>>(
            sql`select attach_status, visible, count(*)::int as n from ${sql.raw(table)} group by 1, 2 order by 1, 2`,
          );
          console.log(`${table}:`);
          for (const r of rows) console.log(`  ${r.attach_status.padEnd(9)} ${r.visible ? "served" : "hidden"}  ${r.n}`);
        }
        console.log(`waiting for a look: ${await countPending(db)}`);
        console.log(`lookup service: ${env.ROAD_LOOKUP_URL === "" ? "off (ROAD_LOOKUP_URL=none)" : env.ROAD_LOOKUP_URL}`);
        break;
      }
      case "attach": {
        const report = await attachAll(db, env);
        console.log(
          `signs: ${JSON.stringify(report.signs)}\ncameras: ${JSON.stringify(report.cameras)}\nlegacy stretches hidden: ${report.stretchesHidden}`,
        );
        break;
      }
      case "lookup": {
        const stretch = await resolveInterval({ db, env, warn: (m, d) => console.warn(m, d) }, parsePoint(a), parsePoint(b));
        console.log(JSON.stringify({ ref: stretch.ref, segmentKey: stretch.segmentKey, lengthM: stretch.lengthM, road: { name: stretch.roadName, ref: stretch.roadRef, class: stretch.roadClass }, vertices: stretch.coordinates.length }, null, 2));
        break;
      }
      case "defects": {
        const rows = await db.execute<{ target_type: string; match_key: string; reason: string | null; removed_at: string; restored_at: string | null } & Record<string, unknown>>(sql`
          select target_type, match_key, reason, removed_at, restored_at from data_defect_removals order by removed_at desc limit ${limit}
        `);
        for (const r of rows) console.log(`${r.target_type.padEnd(18)} ${r.match_key}  ${r.reason ?? ""}  removed ${String(r.removed_at)}${r.restored_at ? `  RESTORED ${String(r.restored_at)}` : ""}`);
        if (rows.length === 0) console.log("nothing was taken out");
        break;
      }
      case "reports": {
        const rows = await db.execute<{ target_type: string; target_id: string; reporters: number; last: string } & Record<string, unknown>>(sql`
          select target_type, target_id, count(distinct reporter_id)::int as reporters, max(reported_at) as last
          from data_defect_reports group by 1, 2 order by reporters desc, last desc limit ${limit}
        `);
        for (const r of rows) console.log(`${r.target_type.padEnd(18)} ${r.target_id}  ${r.reporters} of ${env.DEFECT_REMOVAL_THRESHOLD}`);
        if (rows.length === 0) console.log("no entry is marked");
        break;
      }
      case "restore": {
        const type = a as DefectTargetType | undefined;
        if (!type || !(DEFECT_TARGET_TYPES as readonly string[]).includes(type) || !b) {
          throw new Error(`usage: restore <${DEFECT_TARGET_TYPES.join("|")}> <match-key> (see "defects")`);
        }
        const shown = await restoreRemoval(db, env, type, b);
        console.log(shown > 0 ? `${shown} row(s) are served again; the packages are rebuilt.` : "Nothing to restore for that key.");
        break;
      }
      default:
        throw new Error("usage: roads <status|attach|lookup|defects|reports|restore> ... (see the header of scripts/roads.mts)");
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
