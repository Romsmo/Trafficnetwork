import "dotenv/config";
import { loadEnv } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { generateClientId, generateClientSecret, hashSecret } from "../src/modules/auth/credentials.js";
import { insertClient } from "../src/db/queries/clients.js";
import { CLIENT_SCOPES, type ClientScope } from "../src/config/constants.js";

/**
 * Operator CLI — no admin HTTP API in Phase 1 (see server/README.md's
 * "Client-Provisionierung" section for why). Usage:
 *   npm run create-client -- --name "my-app" --scope client
 *   npm run create-client -- --name "ingestion-worker" --scope bulk-import
 * --scope may be repeated or comma-separated to grant multiple scopes.
 */

function parseArgs(argv: string[]): { name: string; scopes: ClientScope[] } {
  let name: string | undefined;
  const scopes: ClientScope[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") {
      name = argv[++i];
    } else if (argv[i] === "--scope") {
      const value = argv[++i];
      if (!value) continue;
      for (const s of value.split(",")) {
        if (!(CLIENT_SCOPES as readonly string[]).includes(s)) {
          throw new Error(`Unknown scope "${s}" — must be one of: ${CLIENT_SCOPES.join(", ")}`);
        }
        scopes.push(s as ClientScope);
      }
    }
  }

  if (!name) throw new Error("--name is required");
  if (scopes.length === 0) throw new Error("--scope is required (at least one of: " + CLIENT_SCOPES.join(", ") + ")");
  return { name, scopes: [...new Set(scopes)] };
}

async function main() {
  const { name, scopes } = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const { db, client } = createDb(env);

  const clientId = generateClientId();
  const clientSecret = generateClientSecret();
  const clientSecretHash = await hashSecret(clientSecret);

  await insertClient(db, { clientId, clientSecretHash, scopes, name });
  await client.end();

  console.log("Client created. Store these credentials now — the secret is never shown again:\n");
  console.log(`  clientId:     ${clientId}`);
  console.log(`  clientSecret: ${clientSecret}`);
  console.log(`  scopes:       ${scopes.join(", ")}`);
}

main().catch((err) => {
  console.error("Failed to create client:", err instanceof Error ? err.message : err);
  process.exit(1);
});
