import { readFile } from "node:fs/promises";
import type { Env } from "../../config/env.js";
import { verifySignedEnvelope, type SignedEnvelope } from "../crypto/envelope.js";
import { CameraPolicyError, parseCountryLevels, type CameraLevel } from "../cameras/policy/levels.js";

/**
 * The network-wide config a root-key holder signs offline (see
 * scripts/network-sign-config.mts) — matches the F-S0 plan's protocol
 * sketch. `excludedNodeIds` and the delegation key ids are placeholders this
 * milestone doesn't act on yet (F-S3/F-S4 consume them); the field shapes
 * exist now so scripts/network-sign-config.mts and this loader don't need a
 * breaking change later.
 */
export interface NetworkConfigPayload {
  version: number;
  /** Network-wide emergency brake: false switches every country off, whatever `cameraPolicyByCountry` says. */
  blitzerEnabled: boolean;
  /**
   * The exceptions to "cameras are delivered in full": per ISO 3166-1 alpha-2 country what the camera categories may deliver
   * (docs/camera-country-policy.md). A country that is not listed — and an absent field — is `full`. Taking a country back
   * (`zones`, `off`) is the operator's legal decision, signed offline; the code never fills it in.
   */
  cameraPolicyByCountry?: Record<string, CameraLevel>;
  eventLogRetentionDaysDynamic: number;
  eventLogRetentionDaysStatic: number;
  minVersion: string;
  excludedNodeIds: string[];
  directoryKeyId?: string;
  importKeyId?: string;
  issuedAt: string;
}

export class NetworkConfigError extends Error {}

/**
 * Returns null if NETWORK_CONFIG_PATH isn't set (the default — an isolated
 * or not-yet-federated server just uses its own local env config, exactly as
 * before this milestone). If it *is* set, failure to read/parse/verify the
 * file throws rather than silently falling back — a server must never serve
 * traffic on a config it couldn't authenticate (docs/threat-model.md,
 * "Sicherheit vor Bequemlichkeit").
 */
export async function loadSignedNetworkConfig(env: Env): Promise<SignedEnvelope<NetworkConfigPayload> | null> {
  if (!env.NETWORK_CONFIG_PATH) return null;
  if (!env.NETWORK_ROOT_PUBLIC_KEY) {
    // Already enforced by config/env.ts's schema-level refine, but checked
    // again here so this function is safe to call even if that ever changes.
    throw new NetworkConfigError("NETWORK_CONFIG_PATH is set but NETWORK_ROOT_PUBLIC_KEY is not");
  }

  let raw: string;
  try {
    raw = await readFile(env.NETWORK_CONFIG_PATH, "utf8");
  } catch (err) {
    throw new NetworkConfigError(`Could not read NETWORK_CONFIG_PATH (${env.NETWORK_CONFIG_PATH}): ${String(err)}`);
  }

  let envelope: SignedEnvelope<NetworkConfigPayload>;
  try {
    envelope = JSON.parse(raw);
  } catch (err) {
    throw new NetworkConfigError(`NETWORK_CONFIG_PATH does not contain valid JSON: ${String(err)}`);
  }

  if (!verifySignedEnvelope(envelope, env.NETWORK_ROOT_PUBLIC_KEY)) {
    throw new NetworkConfigError("Signed network config failed signature verification against NETWORK_ROOT_PUBLIC_KEY");
  }

  // The signature proves who wrote the file, not that it is well-formed: refuse a policy that cannot be understood
  // completely instead of applying part of it.
  try {
    parseCountryLevels(envelope.payload.cameraPolicyByCountry);
  } catch (err) {
    if (err instanceof CameraPolicyError) throw new NetworkConfigError(`Signed network config: ${err.message}`);
    throw err;
  }

  return envelope;
}
