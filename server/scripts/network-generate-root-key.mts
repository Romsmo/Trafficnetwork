import { writeFileSync, existsSync } from "node:fs";
import { generateEd25519KeyPair, keyId } from "../src/modules/crypto/keys.js";

/**
 * Run this OFFLINE, on a machine that will never run the server — the
 * output file contains the network's root private key, which must never
 * touch a running server or the internet (docs/threat-model.md's "Root key
 * compromise or loss" row). This script does not read any server env var
 * and does not touch the database; it's a standalone tool.
 *
 * Usage: npm run network:generate-root-key -- [--out <path>]
 */

function parseArgs(argv: string[]): { out: string } {
  let out = "./network-root-key.json";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i] ?? out;
  }
  return { out };
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));

  if (existsSync(out)) {
    throw new Error(`${out} already exists — refusing to overwrite an existing root key. Use --out for a new path.`);
  }

  const pair = generateEd25519KeyPair();
  writeFileSync(
    out,
    JSON.stringify({ publicKeyRaw: pair.publicKeyRaw, privateKeyRaw: pair.privateKeyRaw, generatedAt: new Date().toISOString() }, null, 2),
  );

  console.log(`Root key written to ${out}.`);
  console.log("");
  console.log("!!! This file contains the network ROOT PRIVATE KEY. !!!");
  console.log("Move it to secure OFFLINE storage right now (encrypted USB drive, hardware");
  console.log("token, paper backup, etc.) and delete it from this machine afterward. Never:");
  console.log("  - commit it to git");
  console.log("  - copy it onto any machine that runs the server");
  console.log("  - set it as an environment variable anywhere");
  console.log("");
  console.log(`Public key (this IS meant to be distributed — set as NETWORK_ROOT_PUBLIC_KEY on every server):`);
  console.log(`  ${pair.publicKeyRaw}`);
  console.log(`Node-style keyId for reference: ${keyId(pair.publicKeyRaw)}`);
}

main();
