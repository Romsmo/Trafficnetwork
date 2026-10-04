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

describe("the emergency brake (local flag AND signed blitzerEnabled) and the default level", () => {
  const baseEnv = (flag?: boolean, caps = "") => {
    resetEnvCache();
    return loadEnv({
      DATABASE_URL: "postgres://x",
      JWT_SECRET: "a".repeat(32),
      ...(flag === undefined ? {} : { SPEED_CAMERA_NAMESPACE_ENABLED: String(flag) }),
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

  it("without a signed config - and with the defaults - every country is full", () => {
    const policy = buildEffectivePolicy(baseEnv(), null);
    expect(policy.namespaceEnabled).toBe(true);
    expect(policy.deliversAnything).toBe(true);
    expect(policy.defaultLevel).toBe("full");
    expect(policy.unknownLevel).toBe("full");
    expect(policy.levelOfCountry("DE")).toBe("full");
    expect(policy.levelOfCountry("CH")).toBe("full");
    expect(policy.byCountry).toEqual({});
  });

  it("the local brake turns every country off, signed config or not", () => {
    for (const envelope of [null, signed(true), signed(true, { DE: "full" })]) {
      const policy = buildEffectivePolicy(baseEnv(false), envelope);
      expect(policy.namespaceEnabled).toBe(false);
      expect(policy.deliversAnything).toBe(false);
      expect(policy.levelOfCountry("DE")).toBe("off");
      expect(policy.unknownLevel).toBe("off");
    }
  });

  it("the network can pull the brake (AND-gate): blitzerEnabled false turns every country off even where the node's flag is on", () => {
    const policy = buildEffectivePolicy(baseEnv(true), signed(false, { CH: "off" }));
    expect(policy.namespaceEnabled).toBe(false);
    expect(policy.deliversAnything).toBe(false);
    expect(policy.levelOfCountry("DE")).toBe("off");
  });

  it("a signed config without exceptions leaves every country full", () => {
    const policy = buildEffectivePolicy(baseEnv(), signed(true));
    expect(policy.levelOfCountry("DE")).toBe("full");
    expect(policy.unknownLevel).toBe("full");
  });

  it("the signed exceptions take single countries back; every other country stays full", () => {
    const policy = buildEffectivePolicy(baseEnv(), signed(true, { CH: "off", FR: "zones", DE: "full" }));
    expect(policy.levelOfCountry("CH")).toBe("off");
    expect(policy.levelOfCountry("FR")).toBe("zones");
    expect(policy.levelOfCountry("DE")).toBe("full");
    expect(policy.levelOfCountry("AT")).toBe("full");
    expect(policy.defaultLevel).toBe("full");
    // listing a country as full is no exception, so it is not reported as one
    expect(policy.byCountry).toEqual({ CH: "off", FR: "zones" });
  });

  it("a camera whose country is unknown gets the strictest level any country has, so a restriction cannot be escaped by it", () => {
    expect(buildEffectivePolicy(baseEnv(), signed(true, { CH: "off", FR: "zones" })).unknownLevel).toBe("off");
    expect(buildEffectivePolicy(baseEnv(), signed(true, { FR: "zones" })).unknownLevel).toBe("zones");
    expect(buildEffectivePolicy(baseEnv(), signed(true, {})).unknownLevel).toBe("full");
  });

  it("a local cap can only withhold more, never grant more", () => {
    const policy = buildEffectivePolicy(baseEnv(true, "DE=zones,FR=full,AT=off"), signed(true, { DE: "full", FR: "zones", IT: "off" }));
    expect(policy.levelOfCountry("DE")).toBe("zones"); // capped down
    expect(policy.levelOfCountry("FR")).toBe("zones"); // a cap above the network level changes nothing
    expect(policy.levelOfCountry("IT")).toBe("off"); // the network's restriction stays
    expect(policy.levelOfCountry("AT")).toBe("off"); // a cap restricts a country the network does not list
    expect(policy.levelOfCountry("NL")).toBe("full");
  });

  it("a catch-all cap lowers every country, listed or not", () => {
    const policy = buildEffectivePolicy(baseEnv(true, "*=zones"), signed(true, { CH: "off", DE: "full" }));
    expect(policy.defaultLevel).toBe("zones");
    expect(policy.levelOfCountry("DE")).toBe("zones");
    expect(policy.levelOfCountry("CH")).toBe("off");
    expect(policy.levelOfCountry("NL")).toBe("zones");
    expect(buildEffectivePolicy(baseEnv(true, "*=off"), signed(true, { DE: "full" })).deliversAnything).toBe(false);
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
