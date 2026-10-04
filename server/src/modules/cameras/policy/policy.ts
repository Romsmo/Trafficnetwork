import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Env } from "../../../config/env.js";
import { toCanonicalJson } from "../../crypto/canonical.js";
import type { SignedEnvelope } from "../../crypto/envelope.js";
import { loadSignedNetworkConfig, type NetworkConfigPayload } from "../../network/config.js";
import { CAMERA_NOTICE } from "./notice.js";
import { capFor, parseCountryLevels, parseLocalCaps, stricter, strictest, type CameraLevel } from "./levels.js";

/**
 * The country-based camera policy as it applies right now (docs/camera-country-policy.md, section 1).
 *
 *   effective level of a country = the strictest of
 *     the signed network policy (a country it does not list is `full`), this node's local cap, and the emergency brake.
 *
 * Cameras are released by default; the policy is how an operator takes single countries back (`zones`, `off`) without touching code.
 *
 * Immutable: a request takes `service.current()` once and uses that one object throughout, so it never sees half of a
 * policy change. Everything that delivers camera data asks *this* object and nothing else.
 */
export interface EffectiveCameraPolicy {
  /** Fingerprint of everything that decides what is delivered (levels, brake, zone resolution). Changes exactly when delivery would. */
  readonly fingerprint: string;
  /** The brake: the node's SPEED_CAMERA_NAMESPACE_ENABLED, the signed `blitzerEnabled` and a readable signed config. false = every country is off. */
  readonly namespaceEnabled: boolean;
  /** Level of every country the policy and the local caps do not name: `full`, unless the brake is on or a local `*=` cap lowers it. */
  readonly defaultLevel: CameraLevel;
  /** Level of a camera whose country is not known (no boundary data, outside every boundary): the strictest level any country could have, so a restriction cannot be escaped by a camera that could not be placed. */
  readonly unknownLevel: CameraLevel;
  /** Effective levels of the countries that differ from `defaultLevel` (the operator's exceptions); every other country has `defaultLevel`. */
  readonly byCountry: Readonly<Record<string, CameraLevel>>;
  readonly zoneResolution: number;
  /** True while the signed config could not be read or verified after start-up: delivery is off until it can. */
  readonly failedClosed: string | null;
  /** The verified signed config this policy was derived from (null when the node has none). */
  readonly envelope: SignedEnvelope<NetworkConfigPayload> | null;
  /** Some camera may be delivered at all: some level (default, unknown or a listed country) is above `off`. */
  readonly deliversAnything: boolean;
  /** Some level is `zones` (zone queries are skipped entirely otherwise). */
  readonly anyZones: boolean;
  /** Some level is `full`. */
  readonly anyFull: boolean;
  levelOfCountry(country: string): CameraLevel;
  /** Level of a camera with this country set: the strictest of its countries; an unknown (null/empty) set has `unknownLevel`. */
  levelOf(countries: readonly string[] | null | undefined): CameraLevel;
}

type PolicyEnv = Pick<Env, "SPEED_CAMERA_NAMESPACE_ENABLED" | "CAMERA_POLICY_LOCAL_CAPS" | "CAMERA_ZONE_H3_RESOLUTION">;

export function buildEffectivePolicy(
  env: PolicyEnv,
  envelope: SignedEnvelope<NetworkConfigPayload> | null,
  failedClosed: string | null = null,
): EffectiveCameraPolicy {
  const payload = envelope?.payload ?? null;
  const networkLevels = parseCountryLevels(payload?.cameraPolicyByCountry);
  const caps = parseLocalCaps(env.CAMERA_POLICY_LOCAL_CAPS);
  // The brake is released when this node's flag is on and the network (if there is a signed config) has not pulled it.
  const namespaceEnabled = env.SPEED_CAMERA_NAMESPACE_ENABLED && (payload === null || payload.blitzerEnabled === true) && failedClosed === null;

  let defaultLevel: CameraLevel = "off";
  const byCountry: Record<string, CameraLevel> = {};
  if (namespaceEnabled) {
    // A country the network does not list is full; a local cap (`*=` for all, `CC=` for one) can only lower it.
    defaultLevel = caps.fallback ?? "full";
    const named = new Set([...Object.keys(networkLevels), ...Object.keys(caps.byCountry)]);
    for (const country of named) {
      const level = stricter(networkLevels[country] ?? "full", capFor(caps, country));
      if (level !== defaultLevel) byCountry[country] = level;
    }
  }
  // A camera that could not be placed in a country might be in any of them: it gets the strictest level there is.
  const unknownLevel = strictest([defaultLevel, ...Object.values(byCountry)]);

  const levels = new Set<CameraLevel>([defaultLevel, unknownLevel, ...Object.values(byCountry)]);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        defaultLevel,
        unknownLevel,
        byCountry: Object.entries(byCountry).sort(([a], [b]) => a.localeCompare(b)),
        zoneResolution: env.CAMERA_ZONE_H3_RESOLUTION,
      }),
    )
    .digest("hex")
    .slice(0, 16);

  const levelOfCountry = (country: string): CameraLevel => byCountry[country] ?? defaultLevel;
  return {
    fingerprint,
    namespaceEnabled,
    defaultLevel,
    unknownLevel,
    byCountry,
    zoneResolution: env.CAMERA_ZONE_H3_RESOLUTION,
    failedClosed,
    envelope,
    deliversAnything: levels.has("zones") || levels.has("full"),
    anyZones: levels.has("zones"),
    anyFull: levels.has("full"),
    levelOfCountry,
    levelOf(countries) {
      if (!countries || countries.length === 0) return unknownLevel;
      return strictest(countries.map(levelOfCountry));
    },
  };
}

/**
 * `cameraPolicy` of `GET /v1/config` (docs/camera-country-policy.md, 5.1): the effective levels, never more than the signed network policy.
 * A client reads the level of a country as `byCountry[country] ?? defaultLevel`.
 */
export function describePolicy(policy: EffectiveCameraPolicy): {
  version: string;
  namespaceEnabled: boolean;
  defaultLevel: CameraLevel;
  byCountry: Record<string, CameraLevel>;
  zoneResolution: number;
  notice: typeof CAMERA_NOTICE;
} {
  return {
    version: policy.fingerprint,
    namespaceEnabled: policy.namespaceEnabled,
    defaultLevel: policy.defaultLevel,
    byCountry: { ...policy.byCountry },
    zoneResolution: policy.zoneResolution,
    notice: CAMERA_NOTICE,
  };
}

export type ReloadResult =
  | { status: "unchanged" }
  | { status: "applied"; previous: EffectiveCameraPolicy; next: EffectiveCameraPolicy }
  | { status: "refused"; reason: string }
  | { status: "failed-closed"; reason: string; previous: EffectiveCameraPolicy; next: EffectiveCameraPolicy };

type Listener = (next: EffectiveCameraPolicy, previous: EffectiveCameraPolicy) => void | Promise<void>;

interface Log {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/**
 * Holds the current policy and swaps it when the signed config file changes — no restart (section 7).
 *
 * - At start a config that cannot be read, parsed or verified stops the server (`load` throws), exactly as before.
 * - While running, a file that cannot be read or verified makes the policy **fail closed** (all off) until a valid
 *   file is read again; nothing else on the node is affected.
 * - A file whose `version` is lower than one already accepted is refused (the running policy stays): an old, still
 *   validly signed, more generous file must not be replayed. The same version with different content is refused too.
 */
export class CameraPolicyService {
  private policy: EffectiveCameraPolicy;
  private highestVersion: number;
  private fileSignature: string | null = null;
  private lastProblem: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private reloading: Promise<ReloadResult> | undefined;
  private readonly listeners = new Set<Listener>();

  private constructor(
    private readonly env: Env,
    envelope: SignedEnvelope<NetworkConfigPayload> | null,
    private readonly log?: Log,
  ) {
    this.policy = buildEffectivePolicy(env, envelope);
    this.highestVersion = envelope?.payload.version ?? 0;
  }

  /** Reads the signed config once; throws if NETWORK_CONFIG_PATH is set but the file is unusable (start-up must fail loudly). */
  static async load(env: Env, log?: Log): Promise<CameraPolicyService> {
    const envelope = await loadSignedNetworkConfig(env);
    const service = new CameraPolicyService(env, envelope, log);
    service.fileSignature = await service.readFileSignature();
    return service;
  }

  current(): EffectiveCameraPolicy {
    return this.policy;
  }

  /** Called after every swap (policy changed). Errors are logged, never thrown into the reload. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async reload(): Promise<ReloadResult> {
    // One reload at a time; a second caller gets the result of the one in flight.
    this.reloading ??= this.doReload().finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }

  /** Re-reads the file when it changed (or while the policy is failed closed). Does nothing when NETWORK_CONFIG_PATH is unset or the interval is 0. */
  startWatching(): void {
    const seconds = this.env.CAMERA_POLICY_RELOAD_SECONDS;
    if (this.timer || seconds <= 0 || !this.env.NETWORK_CONFIG_PATH) return;
    this.timer = setInterval(() => {
      void (async () => {
        const signature = await this.readFileSignature();
        if (signature !== this.fileSignature || this.policy.failedClosed !== null) await this.reload();
      })().catch((err) => this.log?.error({ err }, "camera policy: reload check failed"));
    }, seconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async readFileSignature(): Promise<string | null> {
    const path = this.env.NETWORK_CONFIG_PATH;
    if (!path) return null;
    try {
      const info = await stat(path);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return "missing";
    }
  }

  private async doReload(): Promise<ReloadResult> {
    if (!this.env.NETWORK_CONFIG_PATH) return { status: "unchanged" };
    this.fileSignature = await this.readFileSignature();

    let envelope: SignedEnvelope<NetworkConfigPayload> | null;
    try {
      envelope = await loadSignedNetworkConfig(this.env);
    } catch (err) {
      return this.failClosed(err instanceof Error ? err.message : String(err));
    }
    if (!envelope) return { status: "unchanged" };

    const previous = this.policy;
    const incoming = envelope.payload;
    const current = previous.envelope?.payload;

    if (incoming.version < this.highestVersion) {
      return this.refuse(`signed network config version ${incoming.version} is older than the version in use (${this.highestVersion}) — refused`);
    }
    if (current && incoming.version === current.version && toCanonicalJson(incoming) !== toCanonicalJson(current)) {
      return this.refuse(`signed network config version ${incoming.version} changed its content without a new version — refused (bump the version)`);
    }

    const next = buildEffectivePolicy(this.env, envelope);
    const unchangedFile = current !== undefined && toCanonicalJson(incoming) === toCanonicalJson(current);
    if (unchangedFile && previous.failedClosed === null) {
      this.lastProblem = null;
      return { status: "unchanged" };
    }

    this.highestVersion = Math.max(this.highestVersion, incoming.version);
    this.lastProblem = null;
    this.policy = next;
    this.log?.info({ version: incoming.version, fingerprint: next.fingerprint }, "camera policy: signed network config applied");
    await this.notify(next, previous);
    return { status: "applied", previous, next };
  }

  private async refuse(reason: string): Promise<ReloadResult> {
    this.warnOnce(reason);
    return { status: "refused", reason };
  }

  private async failClosed(reason: string): Promise<ReloadResult> {
    const previous = this.policy;
    this.warnOnce(`camera policy fails closed — ${reason}`);
    if (previous.failedClosed === reason) return { status: "refused", reason };
    const next = buildEffectivePolicy(this.env, previous.envelope, reason);
    this.policy = next;
    await this.notify(next, previous);
    return { status: "failed-closed", reason, previous, next };
  }

  private warnOnce(message: string): void {
    if (this.lastProblem === message) return;
    this.lastProblem = message;
    this.log?.warn({}, message);
  }

  private async notify(next: EffectiveCameraPolicy, previous: EffectiveCameraPolicy): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(next, previous);
      } catch (err) {
        this.log?.error({ err }, "camera policy: change listener failed");
      }
    }
  }
}
