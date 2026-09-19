import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import {
  applyNetworkConfigCameraOverride,
  loadSignedNetworkConfig,
  NetworkConfigError,
  type NetworkConfigPayload,
} from "../../src/modules/network/config.js";
import { generateEd25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";

describe("applyNetworkConfigCameraOverride", () => {
  const baseEnv = () => {
    resetEnvCache();
    return loadEnv({ DATABASE_URL: "postgres://x", JWT_SECRET: "a".repeat(32) });
  };
  const config = (blitzerEnabled: boolean): NetworkConfigPayload => ({
    version: 1,
    blitzerEnabled,
    eventLogRetentionDaysDynamic: 3,
    eventLogRetentionDaysStatic: 30,
    minVersion: "0.1.0",
    excludedNodeIds: [],
    issuedAt: new Date().toISOString(),
  });

  it("does nothing when there is no network config", () => {
    const env = baseEnv();
    env.SPEED_CAMERA_NAMESPACE_ENABLED = true;
    applyNetworkConfigCameraOverride(env, null);
    expect(env.SPEED_CAMERA_NAMESPACE_ENABLED).toBe(true);
  });

  it("network config can turn a locally-enabled flag off (AND-gate)", () => {
    const env = baseEnv();
    env.SPEED_CAMERA_NAMESPACE_ENABLED = true;
    applyNetworkConfigCameraOverride(env, config(false));
    expect(env.SPEED_CAMERA_NAMESPACE_ENABLED).toBe(false);
  });

  it("network config can never turn a locally-disabled flag on", () => {
    const env = baseEnv();
    env.SPEED_CAMERA_NAMESPACE_ENABLED = false;
    applyNetworkConfigCameraOverride(env, config(true));
    expect(env.SPEED_CAMERA_NAMESPACE_ENABLED).toBe(false);
  });

  it("stays enabled only when both local and network agree", () => {
    const env = baseEnv();
    env.SPEED_CAMERA_NAMESPACE_ENABLED = true;
    applyNetworkConfigCameraOverride(env, config(true));
    expect(env.SPEED_CAMERA_NAMESPACE_ENABLED).toBe(true);
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
