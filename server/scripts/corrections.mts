import "dotenv/config";
import { parseArgs } from "node:util";
import { CORRECTION_STATUSES, type CorrectionStatus } from "../src/config/constants.js";
import { loadEnv } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { listBans, listCorrections, listOrphanCorrections, type CorrectionApi } from "../src/db/queries/speed-limit-corrections.js";
import {
  banReporter,
  resetAllApplied,
  resetCorrection,
  restoreCorrection,
  showSegment,
  unbanReporter,
  type OperatorOutcome,
} from "../src/modules/speed-limit-corrections/operator.js";

/**
 * Operator CLI for community speed-limit corrections (add-on K-A) — no admin
 * HTTP API, same reasoning as create-client. Everything here is local policy:
 * it changes what THIS server counts and serves and is never replicated.
 * Run it against the same DATABASE_URL / .env as the server.
 *
 *   npm run corrections -- list [--status applied,proposed] [--needs-review] [--limit 100]
 *   npm run corrections -- show <segment-id | segment-key>
 *   npm run corrections -- reset <correction-id> [--reason "..."]
 *   npm run corrections -- reset --all [--reason "..."]     (roll back every correction in effect)
 *   npm run corrections -- restore <correction-id>
 *   npm run corrections -- ban <reporter-id> [--reason "..."]
 *   npm run corrections -- unban <reporter-id>
 *   npm run corrections -- bans
 *   npm run corrections -- orphans
 *
 * The switch for the whole feature is COMMUNITY_CORRECTIONS_ENABLED=false (restart).
 * This process cannot push WebSocket messages: clients pick a change up on their
 * next delta / manifest poll.
 */

function describeOutcome(outcome: OperatorOutcome): string {
  if (outcome.changes.length === 0) return "No change to what is served.";
  return outcome.changes
    .map((c) => `  segment ${c.segmentKey} (${c.unit}): ${c.before ?? "imported"} -> ${c.after ?? "imported"}`)
    .join("\n");
}

function row(c: CorrectionApi): string {
  const review = c.needsReview ? "  NEEDS REVIEW" : "";
  return [
    c.id,
    c.status.padEnd(10),
    `${String(c.value).padStart(3)} ${c.unit}`.padEnd(8),
    `+${c.confirmations}/-${c.denials}`.padEnd(8),
    `imported ${c.importedSpeedLimit ?? "?"}`.padEnd(13),
    `segment ${c.segmentId ?? "(not on this server)"}`,
    `key ${c.segmentKey}`,
  ].join("  ") + review;
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      status: { type: "string" },
      "needs-review": { type: "boolean" },
      limit: { type: "string" },
      reason: { type: "string" },
      all: { type: "boolean" },
    },
  });
  const [command, target] = positionals;
  const env = loadEnv();
  const { db, client } = createDb(env);

  try {
    switch (command) {
      case "list": {
        const statuses = (values.status ?? "proposed,applied").split(",") as CorrectionStatus[];
        const bad = statuses.filter((s) => !(CORRECTION_STATUSES as readonly string[]).includes(s));
        if (bad.length > 0) throw new Error(`Unknown status "${bad.join(",")}" — one of: ${CORRECTION_STATUSES.join(", ")}`);
        const corrections = await listCorrections(db, {
          statuses,
          needsReviewOnly: values["needs-review"] ?? false,
          limit: Number(values.limit ?? 100),
        });
        console.log(corrections.length === 0 ? "No corrections." : corrections.map(row).join("\n"));
        break;
      }
      case "show": {
        if (!target) throw new Error("show needs a segment id or a segment key");
        const report = await showSegment(db, env, target);
        console.log(`segment key: ${report.segmentKey}`);
        console.log("\nlocal segment rows (as currently served):");
        for (const s of report.segments) {
          const origin = s.correctedBy ? `${s.speedLimit} ${s.speedLimitUnit} (community; imported ${s.importedSpeedLimit})` : `${s.speedLimit} ${s.speedLimitUnit} (imported)`;
          console.log(`  ${s.id}  ${origin}  source=${s.source}${s.correction?.needsReview ? "  NEEDS REVIEW" : ""}`);
        }
        if (report.segments.length === 0) console.log("  (none — this server has no segment with that geometry)");
        console.log("\ncorrections:");
        console.log(report.corrections.length === 0 ? "  (none)" : report.corrections.map((c) => "  " + row(c)).join("\n"));
        console.log("\nvotes (reporter ids are pseudonyms):");
        for (const v of report.votes) {
          console.log(
            `  ${v.voteTimestamp}  ${v.kind.padEnd(7)} ${v.value} ${v.unit}  ${v.reporterId}${v.signed ? "" : "  [unsigned, local only]"}${v.banned ? "  [BANNED]" : ""}${v.reason ? `  reason=${v.reason}` : ""}`,
          );
        }
        if (report.votes.length === 0) console.log("  (none)");
        break;
      }
      case "reset": {
        if (values.all) {
          const { reset } = await resetAllApplied(db, env, values.reason ?? null);
          console.log(`Reset ${reset} correction(s) that were in effect. The imported values are served again.`);
        } else {
          if (!target) throw new Error("reset needs a correction id (or --all)");
          console.log("Reset. " + describeOutcome(await resetCorrection(db, env, target, values.reason ?? null)));
        }
        break;
      }
      case "restore": {
        if (!target) throw new Error("restore needs a correction id");
        console.log("Restored. " + describeOutcome(await restoreCorrection(db, env, target)));
        break;
      }
      case "ban": {
        if (!target) throw new Error("ban needs a reporter id (see `show`)");
        const result = await banReporter(db, env, target, values.reason ?? null);
        console.log(`${result.newlyBanned ? "Banned" : "Already banned"}: ${target}. Recounted ${result.segmentsRecomputed} segment(s).`);
        break;
      }
      case "unban": {
        if (!target) throw new Error("unban needs a reporter id");
        const result = await unbanReporter(db, env, target);
        console.log(`${result.wasBanned ? "Unbanned" : "Was not banned"}: ${target}. Recounted ${result.segmentsRecomputed} segment(s).`);
        break;
      }
      case "bans": {
        const bans = await listBans(db);
        console.log(bans.length === 0 ? "No banned reporters." : bans.map((b) => `${b.reporterId}  since ${b.bannedAt}${b.reason ? `  (${b.reason})` : ""}`).join("\n"));
        break;
      }
      case "orphans": {
        const orphans = await listOrphanCorrections(db, Number(values.limit ?? 100));
        console.log(orphans.length === 0 ? "No orphaned corrections." : orphans.map(row).join("\n"));
        break;
      }
      default:
        throw new Error("Usage: corrections <list|show|reset|restore|ban|unban|bans|orphans> — see the header of scripts/corrections.mts");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("corrections:", err instanceof Error ? err.message : err);
  process.exit(1);
});
