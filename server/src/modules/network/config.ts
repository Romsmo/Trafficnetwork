import { readFile } from "node:fs/promises";
import type { Env } from "../../config/env.js";
import { verifySignedEnvelope, type SignedEnvelope } from "../crypto/envelope.js";

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
  blitzerEnabled: boolean;
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

  return envelope;
}

/**
 * Mutates env in place — deliberately narrow (touches only this one field)
 * rather than a generic "apply all overrides" mechanism, so the one thing
 * that changes (the camera-namespace flag) stays easy to find and audit.
 * AND-gated, not OR-gated: per docs/prompt-rework-server-federation.md's
 * binding decision, "ein lokales Env-Flag darf die Netzwerkvorgabe nicht
 * aufheben" — a signed config saying `blitzerEnabled: true` never forces a
 * solo/non-federating operator's own `false` on; it can only ever prevent an
 * operator's local `true` from taking effect, never grant one.
 */
export function applyNetworkConfigCameraOverride(env: Env, networkConfig: NetworkConfigPayload | null): void {
  if (!networkConfig) return;
  env.SPEED_CAMERA_NAMESPACE_ENABLED = env.SPEED_CAMERA_NAMESPACE_ENABLED && networkConfig.blitzerEnabled;
}
