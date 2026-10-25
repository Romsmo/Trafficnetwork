import "dotenv/config";
import { parseArgs } from "node:util";
import { loadEnv } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { entryCounts, findEntry, getVersion, listEntriesByStatus, listVotesOfEntry } from "../src/db/queries/context-signs.js";
import { banReporter, removeEntry, restoreEntry, unbanReporter } from "../src/modules/context-signs/service.js";

/**
 * Operator CLI for context signs (docs/context-signs.md) - no admin HTTP API, same reasoning as create-client. Everything here is
 * local policy: it changes what THIS node delivers and is never replicated. Run it against the same DATABASE_URL / .env as the server.
 *
 *   npm run context-signs -- status                        entries by status, the version clients compare
 *   npm run context-signs -- list [--status proposed,confirmed,disputed] [--limit 50]
 *   npm run context-signs -- show <id>                     one entry with its votes (who, what, signed or not)
 *   npm run context-signs -- remove <id> [--reason "..."]  stop delivering it, whatever the votes say
 *   npm run context-signs -- restore <id>                  deliver it again if the votes allow
 *   npm run context-signs -- ban <reporterId> [--reason]   leave a device's votes out of every tally (ids are in `show`)
 *   npm run context-signs -- unban <reporterId>
 */

const STATUSES = ["proposed", "confirmed", "disputed", "expired", "removed"];

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { status: { type: "string" }, limit: { type: "string" }, reason: { type: "string" } } });
  const [command, argument] = positionals;
  const env = loadEnv();
  const { db, client } = createDb(env);
  try {
    switch (command) {
      case "status": {
        console.log(`version ${await getVersion(db)}, feature ${env.CONTEXT_SIGNS_ENABLED ? "on" : "off"}`);
        const counts = await entryCounts(db);
        for (const status of STATUSES) console.log(`  ${status.padEnd(10)} ${counts[status] ?? 0}`);
        return 0;
      }
      case "list": {
        const statuses = (values.status ?? "proposed,confirmed,disputed").split(",").map((s) => s.trim());
        const bad = statuses.filter((s) => !STATUSES.includes(s));
        if (bad.length > 0) throw new Error(`unknown status ${bad.join(", ")} (one of ${STATUSES.join(", ")})`);
        const limit = Math.max(1, Math.min(1000, Number(values.limit ?? 50)));
        for (const e of await listEntriesByStatus(db, statuses, limit)) {
          console.log(`${e.entryKey}  ${e.status.padEnd(9)} ${e.signType.padEnd(10)} +${e.supportCount}/-${e.denyCount}  ${e.lengthM} m  ${e.descriptor.direction}  last vote ${e.lastVoteAt}`);
        }
        return 0;
      }
      case "show": {
        if (!argument) throw new Error("usage: show <id>");
        const e = await findEntry(db, argument);
        if (!e) {
          console.error(`error: no context sign ${argument}`);
          return 1;
        }
        console.log(JSON.stringify({ ...e, tiles: undefined }, null, 2));
        console.log("\nvotes:");
        for (const v of await listVotesOfEntry(db, argument)) console.log(`  ${v.at}  ${v.kind.padEnd(7)} ${v.reporterId}  ${v.signed ? "signed" : "local"}${v.origin ? ` via ${v.origin}` : ""}`);
        return 0;
      }
      case "remove": {
        if (!argument) throw new Error('usage: remove <id> [--reason "..."]');
        const e = await removeEntry(db, env, argument, values.reason ?? null);
        console.log(e ? `${argument} removed: it is no longer delivered (local decision, not replicated)` : `no context sign ${argument}`);
        return e ? 0 : 1;
      }
      case "restore": {
        if (!argument) throw new Error("usage: restore <id>");
        const e = await restoreEntry(db, env, argument);
        console.log(e ? `${argument} restored: now ${e.status}` : `no context sign ${argument}`);
        return e ? 0 : 1;
      }
      case "ban": {
        if (!argument) throw new Error('usage: ban <reporterId> [--reason "..."]');
        const r = await banReporter(db, env, argument, values.reason ?? null);
        console.log(`${argument} ${r.newlyBanned ? "banned" : "was banned already"}; ${r.recomputed} entries recomputed`);
        return 0;
      }
      case "unban": {
        if (!argument) throw new Error("usage: unban <reporterId>");
        const r = await unbanReporter(db, env, argument);
        console.log(`${argument} ${r.wasBanned ? "unbanned" : "was not banned"}; ${r.recomputed} entries recomputed`);
        return 0;
      }
      default:
        console.error("usage: context-signs <status | list | show <id> | remove <id> | restore <id> | ban <reporterId> | unban <reporterId>>");
        return 2;
    }
  } finally {
    await client.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("context-signs failed:", err instanceof Error ? err.message : "unknown error");
    process.exit(1);
  });
