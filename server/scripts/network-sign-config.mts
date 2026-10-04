import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { signEnvelope } from "../src/modules/crypto/envelope.js";
import type { NetworkConfigPayload } from "../src/modules/network/config.js";
import type { Ed25519KeyPair } from "../src/modules/crypto/keys.js";
import { CameraPolicyError, parseCountryLevels, type CameraLevel } from "../src/modules/cameras/policy/levels.js";

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
 *   --camera-policy <CC=level,...>  default: (none) = every country off. e.g. "DE=full,FR=zones,CH=off"
 *   --version <n>                   default: existing --out file's version + 1, or 1
 *
 * The camera policy is part of what you sign: a re-signed file lists exactly the countries given here, so signing again
 * without --camera-policy withdraws every country (it never carries an old, more generous policy over by accident).
 * Which country may be "zones" or "full" is a LEGAL decision of the operator, not a technical one -
 * docs/camera-country-policy.md and docs/operating.md ("Camera policy").
 */

interface Args {
  rootKeyPath: string;
  out: string;
  blitzerEnabled: boolean;
  retentionDynamicDays: number;
  retentionStaticDays: number;
  minVersion: string;
  excludedNodeIds: string[];
  cameraPolicyByCountry: Record<string, CameraLevel>;
  version?: number;
}

/** "DE=full,FR=zones" -> { DE: "full", FR: "zones" }; validated by the same parser the servers use. */
function parseCameraPolicyArg(spec: string | undefined): Record<string, CameraLevel> {
  if (!spec || spec === "none") return {};
  const entries: Record<string, string> = {};
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [country, level, ...rest] = part.split("=").map((s) => s.trim());
    if (!country || !level || rest.length > 0) throw new Error(`--camera-policy: "${part}" is not of the form CC=level`);
    entries[country] = level;
  }
  try {
    return parseCountryLevels(entries, "--camera-policy");
  } catch (err) {
    if (err instanceof CameraPolicyError) throw new Error(err.message);
    throw err;
  }
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
    cameraPolicyByCountry: parseCameraPolicyArg(get("--camera-policy")),
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
    // Written only when something is released: a file without the field means "every country off", exactly like an empty object.
    ...(Object.keys(args.cameraPolicyByCountry).length > 0 ? { cameraPolicyByCountry: args.cameraPolicyByCountry } : {}),
    issuedAt: new Date().toISOString(),
  };

  const envelope = signEnvelope(payload, rootKey);
  writeFileSync(args.out, JSON.stringify(envelope, null, 2));

  console.log(`Signed network config (version ${payload.version}) written to ${args.out}.`);
  console.log("Distribute this file and point every server's NETWORK_CONFIG_PATH at it.");
  const released = Object.entries(args.cameraPolicyByCountry).filter(([, level]) => level !== "off");
  console.log("");
  console.log(
    released.length === 0
      ? "Camera policy: none — every country is off, no camera data is delivered."
      : `Camera policy: ${released.map(([country, level]) => `${country}=${level}`).join(", ")} (every other country: off).`,
  );
  if (payload.blitzerEnabled && released.length === 0) {
    console.log("Note: blitzerEnabled is true, but no country is released (--camera-policy), so nothing is delivered.");
  }
  if (!payload.blitzerEnabled && released.length > 0) {
    console.log("Note: blitzerEnabled is false — the emergency brake is on, so nothing is delivered despite the policy above.");
  }
  if (released.length > 0) {
    console.log("");
    console.log("WARNING: this releases camera data for the countries above. Which country may be \"zones\" or \"full\" is a");
    console.log("legal decision of the operator (and depends on the operator's role, not only the driver's): sign it only after");
    console.log("that review — docs/camera-country-policy.md, docs/operating.md (\"Camera policy\"), docs/concept.md section 8.");
  }
}

main();
