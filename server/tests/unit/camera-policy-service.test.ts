import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { generateEd25519KeyPair, type Ed25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import type { NetworkConfigPayload } from "../../src/modules/network/config.js";
import { buildEffectivePolicy, CameraPolicyService, describePolicy } from "../../src/modules/cameras/policy/policy.js";
import type { CameraLevel } from "../../src/modules/cameras/policy/levels.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function setup(overrides: Record<string, string> = {}) {
  dir = mkdtempSync(path.join(tmpdir(), "camera-policy-test-"));
  const root = generateEd25519KeyPair();
  const file = path.join(dir, "network-config.json");
  resetEnvCache();
  const env = loadEnv({
    DATABASE_URL: "postgres://x",
    JWT_SECRET: "a".repeat(32),
    SPEED_CAMERA_NAMESPACE_ENABLED: "true",
    NETWORK_CONFIG_PATH: file,
    NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw,
    ...overrides,
  });
  return { env, root, file };
}

function sign(root: Ed25519KeyPair, file: string, version: number, policy: Record<string, CameraLevel> | undefined, blitzerEnabled = true) {
  const payload: NetworkConfigPayload = {
    version,
    blitzerEnabled,
    ...(policy ? { cameraPolicyByCountry: policy } : {}),
    eventLogRetentionDaysDynamic: 3,
    eventLogRetentionDaysStatic: 30,
    minVersion: "0.1.0",
    excludedNodeIds: [],
    issuedAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(signEnvelope(payload, root)));
}

describe("effective level of a camera (its country set)", () => {
  const env = (caps = "") => {
    resetEnvCache();
    return loadEnv({ DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(32), SPEED_CAMERA_NAMESPACE_ENABLED: "true", CAMERA_POLICY_LOCAL_CAPS: caps });
  };
  const signed = (policy: Record<string, CameraLevel>) =>
    signEnvelope<NetworkConfigPayload>(
      { version: 1, blitzerEnabled: true, cameraPolicyByCountry: policy, eventLogRetentionDaysDynamic: 3, eventLogRetentionDaysStatic: 30, minVersion: "0.1.0", excludedNodeIds: [], issuedAt: "2026-01-01T00:00:00Z" },
      generateEd25519KeyPair(),
    );

  it("a camera without a known country gets the strictest level any country has - full while nothing is restricted", () => {
    const open = buildEffectivePolicy(env(), signed({ DE: "full" }));
    for (const unknown of [null, undefined, []] as const) expect(open.levelOf(unknown)).toBe("full");
    const zones = buildEffectivePolicy(env(), signed({ FR: "zones" }));
    expect(zones.levelOf(null)).toBe("zones");
    const restricted = buildEffectivePolicy(env(), signed({ FR: "zones", CH: "off" }));
    for (const unknown of [null, undefined, []] as const) expect(restricted.levelOf(unknown)).toBe("off");
  });

  it("the strictest country of a border camera wins, in both directions", () => {
    const policy = buildEffectivePolicy(env(), signed({ DE: "full", FR: "zones", CH: "off" }));
    expect(policy.levelOf(["DE"])).toBe("full");
    expect(policy.levelOf(["DE", "FR"])).toBe("zones");
    expect(policy.levelOf(["FR", "DE"])).toBe("zones");
    expect(policy.levelOf(["DE", "CH"])).toBe("off");
    expect(policy.levelOf(["DE", "XX"])).toBe("full"); // a neighbour the policy does not list is full, like any other
    expect(policy.levelOf(["XX", "CH"])).toBe("off");
  });
});

describe("the policy fingerprint", () => {
  const base = () => {
    resetEnvCache();
    return loadEnv({ DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(32), SPEED_CAMERA_NAMESPACE_ENABLED: "true" });
  };
  const withPolicy = (env: Env, policy: Record<string, CameraLevel>) =>
    buildEffectivePolicy(
      env,
      signEnvelope<NetworkConfigPayload>(
        { version: 1, blitzerEnabled: true, cameraPolicyByCountry: policy, eventLogRetentionDaysDynamic: 3, eventLogRetentionDaysStatic: 30, minVersion: "0.1.0", excludedNodeIds: [], issuedAt: "2026-01-01T00:00:00Z" },
        generateEd25519KeyPair(),
      ),
    );

  it("changes exactly when what would be delivered changes", () => {
    const env = base();
    const a = withPolicy(env, {});
    expect(withPolicy(env, { DE: "full" }).fingerprint).toBe(a.fingerprint); // listing a country as full is no exception: nothing changes
    expect(withPolicy(env, { CH: "off" }).fingerprint).not.toBe(a.fingerprint);
    expect(withPolicy(env, { CH: "zones" }).fingerprint).not.toBe(withPolicy(env, { CH: "off" }).fingerprint);
    expect(withPolicy(env, { CH: "off", FR: "zones" }).fingerprint).not.toBe(withPolicy(env, { CH: "off" }).fingerprint);
    resetEnvCache();
    const otherResolution = loadEnv({ DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(32), SPEED_CAMERA_NAMESPACE_ENABLED: "true", CAMERA_ZONE_H3_RESOLUTION: "7" });
    expect(withPolicy(otherResolution, {}).fingerprint).not.toBe(a.fingerprint);
  });

  it("describes the effective levels for GET /v1/config: the default and the exceptions", () => {
    const described = describePolicy(withPolicy(base(), { DE: "full", FR: "zones", CH: "off" }));
    expect(described.byCountry).toEqual({ FR: "zones", CH: "off" });
    expect(described.defaultLevel).toBe("full");
    expect(described.namespaceEnabled).toBe(true);
    expect(described.zoneResolution).toBe(6);
    expect(described.notice.text.de.length).toBeGreaterThan(0);
    expect(described.notice.text.en.length).toBeGreaterThan(0);
  });
});

describe("CameraPolicyService (the signed file, re-read while running)", () => {
  it("a node with no signed config delivers every country in full", async () => {
    resetEnvCache();
    const env = loadEnv({ DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(32) });
    const service = await CameraPolicyService.load(env);
    expect(service.current().deliversAnything).toBe(true);
    expect(service.current().levelOfCountry("CH")).toBe("full");
    expect(service.current().envelope).toBeNull();
    expect(await service.reload()).toEqual({ status: "unchanged" });
  });

  it("applies a new version without a restart and tells its listeners", async () => {
    const { env, root, file } = setup();
    sign(root, file, 1, { DE: "zones" });
    const service = await CameraPolicyService.load(env);
    expect(service.current().levelOfCountry("DE")).toBe("zones");

    const seen: string[] = [];
    service.onChange((next, previous) => void seen.push(`${previous.levelOfCountry("DE")}->${next.levelOfCountry("DE")}`));
    sign(root, file, 2, { DE: "full" });
    const result = await service.reload();
    expect(result.status).toBe("applied");
    expect(service.current().levelOfCountry("DE")).toBe("full");
    expect(seen).toEqual(["zones->full"]);
  });

  it("a request keeps the policy object it started with: a swap never changes it half way", async () => {
    const { env, root, file } = setup();
    sign(root, file, 1, { CH: "off" });
    const service = await CameraPolicyService.load(env);
    const held = service.current();
    sign(root, file, 2, {});
    await service.reload();
    expect(held.levelOfCountry("CH")).toBe("off");
    expect(service.current().levelOfCountry("CH")).toBe("full");
  });

  it("refuses an older version (rollback protection) and keeps the running policy", async () => {
    const { env, root, file } = setup();
    sign(root, file, 5, { DE: "zones" });
    const service = await CameraPolicyService.load(env);
    sign(root, file, 4, { DE: "full" }); // an old file, validly signed, more generous
    const result = await service.reload();
    expect(result.status).toBe("refused");
    expect(service.current().levelOfCountry("DE")).toBe("zones");
  });

  it("refuses the same version with different content", async () => {
    const { env, root, file } = setup();
    sign(root, file, 5, { DE: "zones" });
    const service = await CameraPolicyService.load(env);
    sign(root, file, 5, { DE: "full" });
    expect((await service.reload()).status).toBe("refused");
    expect(service.current().levelOfCountry("DE")).toBe("zones");
  });

  it("fails closed while the file is unreadable or not signed by the root key, and recovers with a valid one", async () => {
    const { env, root, file } = setup();
    sign(root, file, 1, { DE: "full" });
    const service = await CameraPolicyService.load(env);
    expect(service.current().levelOfCountry("DE")).toBe("full");

    sign(generateEd25519KeyPair(), file, 2, { DE: "full" }); // wrong signer
    expect((await service.reload()).status).toBe("failed-closed");
    expect(service.current().deliversAnything).toBe(false);
    expect(service.current().failedClosed).not.toBeNull();

    writeFileSync(file, "not json at all");
    expect(["failed-closed", "refused"]).toContain((await service.reload()).status); // still failed closed
    expect(service.current().deliversAnything).toBe(false);

    sign(root, file, 3, { DE: "zones" });
    const recovered = await service.reload();
    expect(recovered.status).toBe("applied");
    expect(service.current().levelOfCountry("DE")).toBe("zones");
    expect(service.current().failedClosed).toBeNull();
  });

  it("a lifted restriction is full again after the reload, and 'unchanged' when nothing changed", async () => {
    const { env, root, file } = setup();
    sign(root, file, 1, { CH: "off", FR: "zones" });
    const service = await CameraPolicyService.load(env);
    expect((await service.reload()).status).toBe("unchanged");
    sign(root, file, 2, { CH: "off" });
    await service.reload();
    expect(service.current().levelOfCountry("FR")).toBe("full");
    expect(service.current().levelOfCountry("CH")).toBe("off");
  });

  it("refuses to start on a config it cannot authenticate", async () => {
    const { env, file } = setup();
    writeFileSync(file, "{}");
    await expect(CameraPolicyService.load(env)).rejects.toThrow();
  });
});
