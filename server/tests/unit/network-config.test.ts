import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import {
  loadSignedNetworkConfig,
  NetworkConfigError,
  type NetworkConfigPayload,
} from "../../src/modules/network/config.js";
import { generateEd25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import { buildEffectivePolicy } from "../../src/modules/cameras/policy/policy.js";

describe("the emergency brake (local flag AND signed blitzerEnabled)", () => {
  const baseEnv = (flag: boolean, caps = "") => {
    resetEnvCache();
    return loadEnv({
      DATABASE_URL: "postgres://x",
      JWT_SECRET: "a".repeat(32),
      SPEED_CAMERA_NAMESPACE_ENABLED: String(flag),
      CAMERA_POLICY_LOCAL_CAPS: caps,
    });
  };
  const signed = (blitzerEnabled: boolean, cameraPolicyByCountry?: Record<string, "off" | "zones" | "full">) =>
    signEnvelope<NetworkConfigPayload>(
      {
        version: 1,
        blitzerEnabled,
        ...(cameraPolicyByCountry ? { cameraPolicyByCountry } : {}),
        eventLogRetentionDaysDynamic: 3,
        eventLogRetentionDaysStatic: 30,
        minVersion: "0.1.0",
        excludedNodeIds: [],
        issuedAt: new Date().toISOString(),
      },
      generateEd25519KeyPair(),
    );

  it("without a signed config nothing is delivered, even with the local flag on", () => {
    const policy = buildEffectivePolicy(baseEnv(true), null);
    expect(policy.deliversAnything).toBe(false);
    expect(policy.levelOfCountry("DE")).toBe("off");
  });

  it("the network can switch a locally enabled flag off (AND-gate): every country is off", () => {
    const policy = buildEffectivePolicy(baseEnv(true), signed(false, { DE: "full" }));
    expect(policy.namespaceEnabled).toBe(false);
    expect(policy.levelOfCountry("DE")).toBe("off");
  });

  it("the network can never switch a locally disabled flag on", () => {
    const policy = buildEffectivePolicy(baseEnv(false), signed(true, { DE: "full" }));
    expect(policy.namespaceEnabled).toBe(false);
    expect(policy.levelOfCountry("DE")).toBe("off");
  });

  it("with both agreeing, the signed levels apply and unlisted countries stay off", () => {
    const policy = buildEffectivePolicy(baseEnv(true), signed(true, { DE: "full", FR: "zones", CH: "off" }));
    expect(policy.levelOfCountry("DE")).toBe("full");
    expect(policy.levelOfCountry("FR")).toBe("zones");
    expect(policy.levelOfCountry("CH")).toBe("off");
    expect(policy.levelOfCountry("AT")).toBe("off");
  });

  it("a released brake alone grants nothing: no policy field means every country is off", () => {
    const policy = buildEffectivePolicy(baseEnv(true), signed(true));
    expect(policy.namespaceEnabled).toBe(true);
    expect(policy.deliversAnything).toBe(false);
  });

  it("a local cap can only withhold more, never grant more", () => {
    const policy = buildEffectivePolicy(baseEnv(true, "DE=zones,FR=full,AT=off"), signed(true, { DE: "full", FR: "zones", IT: "full" }));
    expect(policy.levelOfCountry("DE")).toBe("zones"); // capped down
    expect(policy.levelOfCountry("FR")).toBe("zones"); // cap above the network level changes nothing
    expect(policy.levelOfCountry("IT")).toBe("full"); // no cap
    expect(policy.levelOfCountry("AT")).toBe("off"); // a cap on a country the network does not list grants nothing
  });
});

describe("loadSignedNetworkConfig", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when NETWORK_CONFIG_PATH is not set", async () => {
    resetEnvCache();
    const env = loadEnv({ DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(32) });
    expect(await loadSignedNetworkConfig(env)).toBeNull();
  });

  it("loads and verifies a correctly signed config file", async () => {
    const root = generateEd25519KeyPair();
    const payload: NetworkConfigPayload = {
      version: 1,
      blitzerEnabled: false,
      eventLogRetentionDaysDynamic: 3,
      eventLogRetentionDaysStatic: 30,
      minVersion: "0.1.0",
      excludedNodeIds: [],
      issuedAt: new Date().toISOString(),
    };
    const envelope = signEnvelope(payload, root);

    dir = mkdtempSync(path.join(tmpdir(), "network-config-test-"));
    const filePath = path.join(dir, "config.json");
    writeFileSync(filePath, JSON.stringify(envelope));

    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: "postgres://x",
      JWT_SECRET: "a".repeat(32),
      NETWORK_CONFIG_PATH: filePath,
      NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw,
    });

    const loaded = await loadSignedNetworkConfig(env);
    expect(loaded?.payload.blitzerEnabled).toBe(false);
  });

  it("throws if the file's signature doesn't verify against the configured root key", async () => {
    const root = generateEd25519KeyPair();
    const attacker = generateEd25519KeyPair();
    const payload: NetworkConfigPayload = {
      version: 1,
      blitzerEnabled: true, // an attacker trying to force the flag on
      eventLogRetentionDaysDynamic: 3,
      eventLogRetentionDaysStatic: 30,
      minVersion: "0.1.0",
      excludedNodeIds: [],
      issuedAt: new Date().toISOString(),
    };
    const envelope = signEnvelope(payload, attacker); // signed with the WRONG key

    dir = mkdtempSync(path.join(tmpdir(), "network-config-test-"));
    const filePath = path.join(dir, "config.json");
    writeFileSync(filePath, JSON.stringify(envelope));

    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: "postgres://x",
      JWT_SECRET: "a".repeat(32),
      NETWORK_CONFIG_PATH: filePath,
      NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw, // real root key, doesn't match the signer
    });

    await expect(loadSignedNetworkConfig(env)).rejects.toThrow(NetworkConfigError);
  });

  it("rejects a signed config whose camera policy cannot be understood completely", async () => {
    const root = generateEd25519KeyPair();
    dir = mkdtempSync(path.join(tmpdir(), "network-config-test-"));
    const filePath = path.join(dir, "config.json");
    const bad: unknown[] = [{ de: "full" }, { DE: "everything" }, { DEU: "full" }, ["DE"], "DE=full"];
    for (const cameraPolicyByCountry of bad) {
      const payload = {
        version: 1,
        blitzerEnabled: true,
        cameraPolicyByCountry,
        eventLogRetentionDaysDynamic: 3,
        eventLogRetentionDaysStatic: 30,
        minVersion: "0.1.0",
        excludedNodeIds: [],
        issuedAt: new Date().toISOString(),
      } as unknown as NetworkConfigPayload;
      writeFileSync(filePath, JSON.stringify(signEnvelope(payload, root)));
      resetEnvCache();
      const env = loadEnv({ DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(32), NETWORK_CONFIG_PATH: filePath, NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw });
      await expect(loadSignedNetworkConfig(env)).rejects.toThrow(NetworkConfigError);
    }
  });

  it("accepts a well-formed camera policy", async () => {
    const root = generateEd25519KeyPair();
    dir = mkdtempSync(path.join(tmpdir(), "network-config-test-"));
    const filePath = path.join(dir, "config.json");
    const payload: NetworkConfigPayload = {
      version: 1,
      blitzerEnabled: true,
      cameraPolicyByCountry: { DE: "full", FR: "zones", CH: "off" },
      eventLogRetentionDaysDynamic: 3,
      eventLogRetentionDaysStatic: 30,
      minVersion: "0.1.0",
      excludedNodeIds: [],
      issuedAt: new Date().toISOString(),
    };
    writeFileSync(filePath, JSON.stringify(signEnvelope(payload, root)));
    resetEnvCache();
    const env = loadEnv({ DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(32), NETWORK_CONFIG_PATH: filePath, NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw });
    const loaded = await loadSignedNetworkConfig(env);
    expect(loaded?.payload.cameraPolicyByCountry).toEqual({ DE: "full", FR: "zones", CH: "off" });
  });

  it("throws if the file doesn't exist", async () => {
    const root = generateEd25519KeyPair();
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: "postgres://x",
      JWT_SECRET: "a".repeat(32),
      NETWORK_CONFIG_PATH: "/nonexistent/path/config.json",
      NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw,
    });
    await expect(loadSignedNetworkConfig(env)).rejects.toThrow(NetworkConfigError);
  });
});
