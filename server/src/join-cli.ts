import "dotenv/config";
import { parseArgs } from "node:util";
import { loadEnv } from "./config/env.js";
import { createDb } from "./db/client.js";
import { qrTerminal } from "./modules/join/qr.js";
import { createInvitation, joinSettings, listCodes, refreshMetadata, revokeCode, rotatePublicJoinCode, showCode, type JoinContext, type JoinLog } from "./modules/join/service.js";

/**
 * Operator CLI for join codes (docs/join-code.md) - no admin HTTP API, same reasoning as create-client. Compiled into the
 * image, so it runs where the files are:
 *
 *   docker compose exec server node dist/join-cli.js show
 *   npm run join:show                                   (source install)
 *
 *   show [<clientId>]                    the public code (or the invitation code of <clientId>): text, files, QR in the terminal
 *   create --label <text> [--max-uses N] [--expires 7d]   an invitation code (never shown on the web page)
 *   rotate                               a new public code; the old one ends after JOIN_ROTATE_GRACE_DAYS
 *   revoke <clientId>                    no new registrations with that code; devices that registered with it stay valid
 *   list                                 all codes: status, registrations, expiry
 *
 * `show`, `create` and `rotate` print the code itself - that is their job, in your terminal. Nothing else here does.
 */

const log: JoinLog = {
  info: (message) => console.error(message),
  warn: (message) => console.error(`warning: ${message}`),
  error: (message) => console.error(`error: ${message}`),
};

/** "7d", "12h", "90m" -> a date that far from now. */
export function parseExpiry(text: string, now: Date = new Date()): Date {
  const match = /^([1-9][0-9]{0,4})([dhm])$/.exec(text.trim());
  if (!match) throw new Error(`--expires must look like 7d, 12h or 90m (got "${text}")`);
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[match[2] as "d" | "h" | "m"];
  return new Date(now.getTime() + Number(match[1]) * unit);
}

function printCode(title: string, shown: { uri: string; files: { join: string; svg: string; json: string } }, extra: string[] = []): void {
  console.log(`${title}\n`);
  console.log(`  ${shown.uri}\n`);
  for (const line of extra) console.log(`  ${line}`);
  console.log(`  code file: ${shown.files.join}`);
  console.log(`  QR (SVG):  ${shown.files.svg}`);
  console.log(`  metadata:  ${shown.files.json}\n`);
  console.log(qrTerminal(shown.uri));
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { label: { type: "string" }, "max-uses": { type: "string" }, expires: { type: "string" } },
  });
  const [command, argument] = positionals;
  const env = loadEnv();
  const { db, client } = createDb(env);
  const ctx: JoinContext = { db, env, log };

  try {
    switch (command) {
      case "show": {
        const shown = await showCode(ctx, argument ?? null);
        if ("problem" in shown) {
          console.error(`error: ${shown.problem}`);
          return 1;
        }
        printCode(`${shown.row.kind === "join-public" ? "Public join code" : `Invitation code ${shown.row.clientId}`} (${shown.status})`, shown, [
          `node:        ${shown.node}`,
          `app key:     ${shown.row.clientId}`,
          `network key: ${shown.rootFingerprint ?? "(none in this code)"}`,
          `registered:  ${shown.row.useCount}`,
        ]);
        return 0;
      }
      case "create": {
        if (!values.label) throw new Error("--label <text> is required");
        const maxUses = values["max-uses"] === undefined ? null : Number(values["max-uses"]);
        if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) throw new Error("--max-uses must be a whole number of at least 1");
        const expiresAt = values.expires === undefined ? null : parseExpiry(values.expires);
        const created = await createInvitation(ctx, { label: values.label, maxUses, expiresAt });
        printCode(`Invitation code ${created.clientId} created`, created, [`label:       ${values.label}`, `max uses:    ${maxUses ?? "unlimited"}`, `expires:     ${expiresAt?.toISOString() ?? "never"}`]);
        return 0;
      }
      case "rotate": {
        const rotated = await rotatePublicJoinCode(ctx);
        printCode("New public join code", rotated, [
          rotated.previous
            ? `the old code (${rotated.previous}) ${rotated.graceUntil ? `keeps working until ${rotated.graceUntil.toISOString()}` : "ended now"}`
            : "there was no earlier public code",
        ]);
        return 0;
      }
      case "revoke": {
        if (!argument) throw new Error("usage: revoke <clientId>");
        const result = await revokeCode(ctx, argument);
        if (result === "not_found") {
          console.error(`error: no join code ${argument}`);
          return 1;
        }
        console.log(result === "revoked" ? `${argument} revoked: no new registrations. Devices that registered with it keep working.` : `${argument} was revoked already.`);
        return 0;
      }
      case "list": {
        await refreshMetadata(ctx);
        const codes = await listCodes(ctx);
        if (codes.length === 0) {
          const { problem } = joinSettings(env);
          console.log(`No join codes yet.${problem ? ` (${problem})` : ""}`);
          return 0;
        }
        for (const { row, status } of codes) {
          const uses = `${row.useCount}${row.maxUses !== null ? `/${row.maxUses}` : ""}`;
          const detail = [row.kind === "join-public" ? "public" : `invitation${row.label ? ` "${row.label}"` : ""}`, `registered ${uses}`, row.expiresAt ? `ends ${row.expiresAt}` : null, row.revokedAt ? `revoked ${row.revokedAt}` : null];
          console.log(`${row.clientId}  ${status.padEnd(7)}  ${detail.filter(Boolean).join(", ")}`);
        }
        return 0;
      }
      default:
        console.error("usage: join-cli <show [clientId] | create --label <text> [--max-uses N] [--expires 7d] | rotate | revoke <clientId> | list>");
        return 2;
    }
  } finally {
    await client.end();
  }
}

// Not run when the file is imported (the tests import parseExpiry).
if (process.argv[1] && /join-cli\.[cm]?[jt]s$/.test(process.argv[1])) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error("join-cli failed:", err instanceof Error ? err.message : "unknown error");
      process.exit(1);
    });
}
