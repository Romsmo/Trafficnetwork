import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { signEnvelope } from "../src/modules/crypto/envelope.js";
import type { NetworkConfigPayload } from "../src/modules/network/config.js";
import type { Ed25519KeyPair } from "../src/modules/crypto/keys.js";

/**
 * Run this OFFLINE, using the root key file from
 * network-generate-root-key.mts — never on a running server. Produces a
 * SignedEnvelope<NetworkConfigPayload> JSON file, which an operator then
 * distributes and points every server's NETWORK_CONFIG_PATH at (see
 * docs/api.md's "Client config" section and modules/network/config.ts).
 *
 * Usage:
 *   npm run network:sign-config -- --root-key ./network-root-key.json [options]
 *
 * Options (all optional, sensible defaults shown):
 *   --out <path>                    default: ./network-config.json
 *   --blitzer-enabled <true|false>  default: false
 *   --retention-dynamic-days <n>    default: 3
 *   --retention-static-days <n>     default: 30
 *   --min-version <semver>          default: 0.1.0
 *   --excluded-node-ids <a,b,c>     default: (none)
 *   --version <n>                   default: existing --out file's version + 1, or 1
 */

interface Args {
  rootKeyPath: string;
  out: string;
  blitzerEnabled: boolean;
  retentionDynamicDays: number;
  retentionStaticDays: number;
  minVersion: string;
  excludedNodeIds: string[];
  version?: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const rootKeyPath = get("--root-key");
  if (!rootKeyPath) throw new Error("--root-key <path> is required");

  return {
    rootKeyPath,
    out: get("--out") ?? "./network-config.json",
    blitzerEnabled: (get("--blitzer-enabled") ?? "false") === "true",
    retentionDynamicDays: Number(get("--retention-dynamic-days") ?? "3"),
    retentionStaticDays: Number(get("--retention-static-days") ?? "30"),
    minVersion: get("--min-version") ?? "0.1.0",
    excludedNodeIds: (get("--excluded-node-ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    version: get("--version") ? Number(get("--version")) : undefined,
  };
}

function nextVersion(outPath: string, explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  if (!existsSync(outPath)) return 1;
  try {
    const existing = JSON.parse(readFileSync(outPath, "utf8"));
    const currentVersion = existing?.payload?.version;
    return typeof currentVersion === "number" ? currentVersion + 1 : 1;
  } catch {
    return 1;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const rootKey: Ed25519KeyPair = JSON.parse(readFileSync(args.rootKeyPath, "utf8"));
  if (!rootKey.publicKeyRaw || !rootKey.privateKeyRaw) {
    throw new Error(`${args.rootKeyPath} does not look like a root key file (missing publicKeyRaw/privateKeyRaw)`);
  }

  const payload: NetworkConfigPayload = {
    version: nextVersion(args.out, args.version),
    blitzerEnabled: args.blitzerEnabled,
    eventLogRetentionDaysDynamic: args.retentionDynamicDays,
    eventLogRetentionDaysStatic: args.retentionStaticDays,
    minVersion: args.minVersion,
    excludedNodeIds: args.excludedNodeIds,
    issuedAt: new Date().toISOString(),
  };

  const envelope = signEnvelope(payload, rootKey);
  writeFileSync(args.out, JSON.stringify(envelope, null, 2));

  console.log(`Signed network config (version ${payload.version}) written to ${args.out}.`);
  console.log("Distribute this file and point every server's NETWORK_CONFIG_PATH at it.");
  if (payload.blitzerEnabled) {
    console.log("");
    console.log("WARNING: blitzerEnabled is true — this activates the speed-camera namespace");
    console.log("network-wide. Only sign this after the legal review docs/concept.md section 8 requires.");
  }
}

main();
