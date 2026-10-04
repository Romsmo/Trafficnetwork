import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader } from "./auth-helper.js";
import { createPolicyFixture, loadBoundaries, type PolicyFixture } from "./camera-policy-helper.js";
import type { CameraLevel } from "../../src/modules/cameras/policy/levels.js";

/**
 * What a browser (an anonymous web session) sees of the country-based camera policy (docs/camera-country-policy.md, docs/web-ui.md):
 * the config the page reads, cameras and areas on the read side, and honest answers to a camera report on the write side. The
 * country of the test town is a synthetic rectangle: the server ships no geodata.
 */

const MUNICH = { lat: 48.1374, lng: 11.5755 };

describe("web sessions and the camera policy", () => {
  let testDb: TestDatabase;
  const fixtures: PolicyFixture[] = [];
  const open: FastifyInstance[] = [];

  async function node(levels: Record<string, CameraLevel> | null, extra: Record<string, string> = {}): Promise<FastifyInstance> {
    let policyEnv: Record<string, string> = {};
    if (levels) {
      const fixture = createPolicyFixture();
      fixtures.push(fixture);
      fixture.write(levels);
      policyEnv = fixture.env();
    }
    resetEnvCache();
    const env = loadEnv({ DATABASE_URL: testDb.container.getConnectionUri(), JWT_SECRET: "a".repeat(32), LOG_LEVEL: "silent", ...policyEnv, ...extra });
    const app = await buildApp({ env, db: testDb.db });
    open.push(app);
    return app;
  }

  const session = async (app: FastifyInstance): Promise<string> => {
    const res = await app.inject({ method: "POST", url: "/v1/web/session", remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(200);
    return res.json().accessToken as string;
  };

  const camera = (app: FastifyInstance, token: string, type = "mobileSpeedCamera") =>
    app.inject({ method: "POST", url: "/v1/hazard-reports", headers: authHeader(token), payload: { type, ...MUNICH }, remoteAddress: "127.0.0.1" });

  const nearby = async (app: FastifyInstance, token: string) => {
    const res = await app.inject({ method: "GET", url: `/v1/speed-cameras/nearby?lat=${MUNICH.lat}&lng=${MUNICH.lng}&radiusM=3000`, headers: authHeader(token), remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(200);
    return res.json() as { cameras: Array<{ lat: number; lng: number; type: string }>; zones: Array<Record<string, any>> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  const config = async (app: FastifyInstance, token: string) => {
    const res = await app.inject({ method: "GET", url: "/v1/config", headers: authHeader(token), remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(200);
    return res.json() as { speedCameraNamespaceEnabled: boolean; cameraPolicy: { defaultLevel: string; byCountry: Record<string, string>; namespaceEnabled: boolean; notice: { version: number } } };
  };

  beforeAll(async () => {
    testDb = await startTestDatabase();
    await loadBoundaries(testDb.db, [{ iso2: "DE", west: 11, south: 47.7, east: 12.2, north: 48.6 }]);
  }, 90_000);

  afterAll(async () => {
    for (const app of open) await app.close().catch(() => undefined);
    for (const fixture of fixtures) fixture.cleanup();
    await testDb.teardown();
  });

  it("by default cameras are delivered in full: the page is told, a report is a normal one, the camera is a spot", async () => {
    const app = await node(null);
    const token = await session(app);
    const cfg = await config(app, token);
    expect(cfg.speedCameraNamespaceEnabled).toBe(true);
    expect(cfg.cameraPolicy).toMatchObject({ namespaceEnabled: true, defaultLevel: "full", byCountry: {} });
    expect(cfg.cameraPolicy.notice.version).toBeGreaterThan(0);

    const written = await camera(app, token, "fixedSpeedCamera");
    expect(written.statusCode).toBe(201);
    const seen = await nearby(app, token);
    expect(seen.cameras.some((c) => c.type === "fixedSpeedCamera")).toBe(true);
    expect(seen.zones).toEqual([]);
  });

  it("where the signed policy says zones, the page gets an area and no spot, and the camera report is accepted without coordinates in the answer", async () => {
    const app = await node({ DE: "zones" });
    const token = await session(app);
    const cfg = await config(app, token);
    expect(cfg.cameraPolicy.byCountry).toEqual({ DE: "zones" });
    expect(cfg.speedCameraNamespaceEnabled).toBe(true);

    const written = await camera(app, token, "mobileSpeedCamera");
    expect(written.statusCode).toBe(202);
    expect(written.json()).toMatchObject({ accepted: true });
    expect(JSON.stringify(written.json())).not.toContain(String(MUNICH.lat));

    const seen = await nearby(app, token);
    expect(seen.cameras).toEqual([]);
    expect(seen.zones.length).toBeGreaterThan(0);
    for (const zone of seen.zones) {
      expect(zone.boundary.type).toBe("Polygon");
      expect(zone).not.toHaveProperty("lat");
      expect(zone).not.toHaveProperty("lng");
    }
  });

  it("where the signed policy says off, the page gets nothing, and a report is still answered as accepted", async () => {
    const app = await node({ DE: "off" });
    const token = await session(app);
    const written = await camera(app, token, "trailerCamera");
    expect(written.statusCode).toBe(202);
    expect(written.json()).toMatchObject({ accepted: true });
    expect(written.json()).not.toHaveProperty("zone");
    const seen = await nearby(app, token);
    expect(seen.cameras).toEqual([]);
    expect(seen.zones).toEqual([]);
  });

  it("a node-local cap on every country makes the page's camera category disappear, and the API refuses the types", async () => {
    const app = await node(null, { CAMERA_POLICY_LOCAL_CAPS: "*=off" });
    const token = await session(app);
    const cfg = await config(app, token);
    expect(cfg.cameraPolicy.defaultLevel).toBe("off");
    const refused = await camera(app, token, "mobileSpeedCamera");
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(refused.statusCode).toBeLessThan(500);
  });

  it("the emergency brake is the master switch: config says so and the page's camera types are refused", async () => {
    const app = await node(null, { SPEED_CAMERA_NAMESPACE_ENABLED: "false" });
    const token = await session(app);
    const cfg = await config(app, token);
    expect(cfg.speedCameraNamespaceEnabled).toBe(false);
    expect(cfg.cameraPolicy.namespaceEnabled).toBe(false);
    const refused = await camera(app, token, "fixedSpeedCamera");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("WEB_TYPE_NOT_ALLOWED");
  });
});
