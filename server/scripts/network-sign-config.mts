import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { signEnvelope } from "../src/modules/crypto/envelope.js";
import type { NetworkConfigPayload } from "../src/modules/network/config.js";
import type { Ed25519KeyPair } from "../src/modules/crypto/keys.js";
import { CameraPolicyError, parseCountryLevels, type CameraLevel } from "../src/modules/cameras/policy/levels.js";
import { parseExpiryOverrides, ReportExpiryConfigError, type ExpiryOverrides } from "../src/config/report-expiry.js";

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
 *   --blitzer-enabled <true|false>  default: true  (the network-wide emergency brake: false = no camera data anywhere)
 *   --retention-dynamic-days <n>    default: 3
 *   --retention-static-days <n>     default: 30
 *   --min-version <semver>          default: 0.1.0
 *   --excluded-node-ids <a,b,c>     default: (none)
 *   --camera-policy <CC=level,...>  default: (none) = every country full. The EXCEPTIONS, e.g. "CH=off,FR=zones"
 *   --report-expiry <json>          default: (none) = every node uses the defaults of its server version. How long reports
 *                                   live and what a reporter may ask for, per hazard type, e.g.
 *                                   '{"mobileSpeedCamera":{"defaultSeconds":10800,"maxSeconds":43200}}' (server/docs/report-expiry.md)
 *   --version <n>                   default: existing --out file's version + 1, or 1
 *
 * Cameras are delivered at level "full" in every country that is not listed. The camera policy is part of what you sign: a
 * re-signed file lists exactly the exceptions given here, so signing again without --camera-policy lifts all of them (it never
 * carries an old policy over by accident - check the printed summary). The same goes for --report-expiry. Whether a country should be restricted ("zones" = coarse
 * areas only, "off" = nothing) is a LEGAL decision of the operator, not a technical one -
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
  reportExpiry: ExpiryOverrides;
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
    blitzerEnabled: (get("--blitzer-enabled") ?? "true") === "true",
    retentionDynamicDays: Number(get("--retention-dynamic-days") ?? "3"),
    retentionStaticDays: Number(get("--retention-static-days") ?? "30"),
    minVersion: get("--min-version") ?? "0.1.0",
    excludedNodeIds: (get("--excluded-node-ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    cameraPolicyByCountry: parseCameraPolicyArg(get("--camera-policy")),
    reportExpiry: parseReportExpiryArg(get("--report-expiry")),
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

/** A JSON object as the servers read it (config/report-expiry.ts) - the same parser, so a file this script writes is one they accept. */
function parseReportExpiryArg(spec: string | undefined): ExpiryOverrides {
  if (!spec || spec === "none") return {};
  let json: unknown;
  try {
    json = JSON.parse(spec);
  } catch {
    throw new Error("--report-expiry: not valid JSON");
  }
  try {
    return parseExpiryOverrides(json, "--report-expiry");
  } catch (err) {
    if (err instanceof ReportExpiryConfigError) throw new Error(err.message);
    throw err;
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
    // Likewise: written only when something is set, so a file without the field means "the defaults of each server version".
    ...(Object.keys(args.reportExpiry).length > 0 ? { reportExpiry: args.reportExpiry as NetworkConfigPayload["reportExpiry"] } : {}),
    issuedAt: new Date().toISOString(),
  };

  const envelope = signEnvelope(payload, rootKey);
  writeFileSync(args.out, JSON.stringify(envelope, null, 2));

  console.log(`Signed network config (version ${payload.version}) written to ${args.out}.`);
  console.log("Distribute this file and point every server's NETWORK_CONFIG_PATH at it.");
  const exceptions = Object.entries(args.cameraPolicyByCountry).filter(([, level]) => level !== "full");
  console.log("");
  console.log(
    exceptions.length === 0
      ? "Camera policy: no exceptions - cameras are delivered in full in every country."
      : `Camera policy: full everywhere except ${exceptions.map(([country, level]) => `${country}=${level}`).join(", ")}.`,
  );
  console.log(
    Object.keys(args.reportExpiry).length === 0
      ? "Report expiry: nothing set - every node uses the defaults of its server version."
      : `Report expiry: set for ${Object.keys(args.reportExpiry).join(", ")} - replaces the nodes' own values for exactly these fields.`,
  );
  if (!payload.blitzerEnabled) {
    console.log("Note: blitzerEnabled is false - the emergency brake is on, so no camera data is delivered anywhere, whatever the policy says.");
  }
  console.log("Whether a country should be restricted is the operator's legal decision (known special cases: Switzerland - a broad ban, even");
  console.log("hints; France - only general danger zones, no concrete spots). See docs/camera-country-policy.md and docs/operating.md.");
}

main();
