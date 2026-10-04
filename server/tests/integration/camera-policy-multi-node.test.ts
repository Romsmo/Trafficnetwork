import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { generateEd25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import { joinSeeds, pullFromPeers, type FederationWorkerDeps } from "../../src/modules/federation/workers.js";
import { createPolicyFixture, EUROPE_BOXES, loadBoundaries, type PolicyFixture } from "./camera-policy-helper.js";
import { latLngToCell } from "h3-js";

/**
 * Three real nodes of one network (real HTTP, one Postgres each) that read the same root-signed policy but differ in what
 * their operators allow locally: A follows the network, B caps Germany at `zones`, C refuses every camera. Cameras are
 * written on A in Germany (full), France (zones) and Switzerland (off). What federates is decided by A's own delivery
 * level; what each node serves is decided by its own effective level (docs/camera-country-policy.md, section 4).
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BERLIN = { lat: 52.52, lng: 13.405 }; // DE
const PARIS = { lat: 48.8566, lng: 2.3522 }; // FR
const ZURICH = { lat: 47.3769, lng: 8.5417 }; // CH

describe("camera policy across a network of nodes with different local limits", () => {
  const PORTS = { a: 18841, b: 18842, c: 18843 };

  interface Node {
    name: string;
    testDb: TestDatabase;
    app: FastifyInstance;
    env: Env;
    address: string;
    policy: PolicyFixture;
    workerDeps: FederationWorkerDeps;
  }

  const root = generateEd25519KeyPair();
  let a: Node, b: Node, c: Node;

  async function startNode(name: string, port: number, extra: Record<string, string> = {}): Promise<Node> {
    const testDb = await startTestDatabase();
    await loadBoundaries(testDb.db, EUROPE_BOXES);
    const policy = createPolicyFixture(root); // one network, one root key; every node reads its own copy of the signed file
    policy.write({ DE: "full", FR: "zones", CH: "off" });
    const address = `http://127.0.0.1:${port}`;
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      LOG_LEVEL: "silent",
      FEDERATION_ENABLED: "true",
      FEDERATION_PUBLIC_ADDRESS: address,
      DUPLICATE_MERGE_RADIUS_METERS: "500",
      ...policy.env(),
      ...extra,
    });
    const app = await buildApp({ env, db: testDb.db });
    await app.listen({ port, host: "127.0.0.1" });
    const workerDeps: FederationWorkerDeps = { db: testDb.db, env, nodeIdentity: app.nodeIdentity, realtime: app.realtime, log: app.log, online: app.online };
    return { name, testDb, app, env, address, policy, workerDeps };
  }

  async function stopNode(node: Node) {
    await node.app.close();
    node.policy.cleanup();
    await node.testDb.teardown();
  }

  async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 8000, intervalMs = 100): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await check();
      if (result !== undefined) return result;
      if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  const cameraReports = async (node: Node) =>
    (await node.testDb.db.execute<{ lat: number } & Record<string, unknown>>(sql`
      select ST_Y(position) as lat from hazard_reports where type = 'mobileSpeedCamera' order by lat`)).map((r) => Number(r.lat));

  const get = async (node: Node, url: string) => (await node.app.inject({ method: "GET", url, headers: authHeader(await testToken(node.env)) })).json() as Json;
  const nearby = (node: Node, site: { lat: number; lng: number }) => get(node, `/v1/speed-cameras/nearby?lat=${site.lat}&lng=${site.lng}&radiusM=5000`);

  function signedCameraReport(site: { lat: number; lng: number }) {
    const device = generateEd25519KeyPair();
    const envelope = signEnvelope(
      { kind: "create" as const, type: "mobileSpeedCamera" as const, lat: site.lat, lng: site.lng, speedKmh: 80, devicePublicKey: device.publicKeyRaw, timestamp: new Date().toISOString() },
      device,
    );
    return { type: "mobileSpeedCamera", lat: site.lat, lng: site.lng, speedKmh: 80, deviceAssertion: envelope };
  }

  beforeAll(async () => {
    [a, b, c] = await Promise.all([
      startNode("A (follows the network)", PORTS.a),
      startNode("B (caps Germany at zones)", PORTS.b, { CAMERA_POLICY_LOCAL_CAPS: "DE=zones" }),
      startNode("C (refuses every camera)", PORTS.c, { CAMERA_POLICY_LOCAL_CAPS: "*=off" }),
    ]);
    await joinSeeds({ ...b.workerDeps, env: { ...b.env, FEDERATION_SEEDS: a.address } });
    await joinSeeds({ ...c.workerDeps, env: { ...c.env, FEDERATION_SEEDS: `${a.address},${b.address}` } });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([stopNode(a), stopNode(b), stopNode(c)]);
  });

  it("a camera report federates only from a node that delivers it individually; each node then serves it at its own level", async () => {
    const submit = async (site: { lat: number; lng: number }, sub: string) =>
      a.app.inject({ method: "POST", url: "/v1/hazard-reports", headers: authHeader(await testToken(a.env, { sub })), payload: signedCameraReport(site) });
    expect((await submit(BERLIN, "dev-de")).statusCode).toBe(201); // Germany: full on A
    expect((await submit(PARIS, "dev-fr")).statusCode).toBe(202); // France: zones
    expect((await submit(ZURICH, "dev-ch")).statusCode).toBe(202); // Switzerland: off
    expect(await cameraReports(a)).toHaveLength(3); // writing is never blocked

    // The German report reaches B and C (gossip, backed by the anti-entropy pull) ...
    await waitFor(async () => {
      await pullFromPeers(b.workerDeps);
      await pullFromPeers(c.workerDeps);
      return (await cameraReports(b)).length === 1 && (await cameraReports(c)).length === 1 ? true : undefined;
    }, 15_000, 250);
    expect(await cameraReports(b)).toEqual([BERLIN.lat]);
    expect(await cameraReports(c)).toEqual([BERLIN.lat]);
    // ... and the French and Swiss ones never leave A, however often the others ask.
    await pullFromPeers(b.workerDeps);
    await pullFromPeers(c.workerDeps);
    await new Promise((r) => setTimeout(r, 500));
    expect(await cameraReports(b)).toEqual([BERLIN.lat]);
    expect(await cameraReports(c)).toEqual([BERLIN.lat]);

    // What each node serves from the same network policy:
    const berlinCell = latLngToCell(BERLIN.lat, BERLIN.lng, 6);
    const onA = await nearby(a, BERLIN);
    expect(onA.cameras).toHaveLength(1);
    expect(onA.zones).toEqual([]);
    const onB = await nearby(b, BERLIN); // capped at zones
    expect(onB.cameras).toEqual([]);
    expect((onB.zones as Json[]).map((z) => z.cell)).toEqual([berlinCell]);
    expect(await nearby(c, BERLIN)).toEqual({ cameras: [], zones: [] }); // refuses every camera
    expect((await nearby(a, PARIS)).zones).toHaveLength(1);
    expect((await nearby(a, PARIS)).cameras).toEqual([]);
    for (const node of [a, b, c]) expect(await nearby(node, ZURICH), node.name).toEqual({ cameras: [], zones: [] });

    // Each node says what it delivers
    expect((await get(a, "/v1/config")).cameraPolicy.byCountry).toEqual({ DE: "full", FR: "zones" });
    expect((await get(b, "/v1/config")).cameraPolicy.byCountry).toEqual({ DE: "zones", FR: "zones" });
    expect((await get(c, "/v1/config")).cameraPolicy.byCountry).toEqual({});
    expect((await get(c, "/v1/config")).speedCameraNamespaceEnabled).toBe(false);
    // the signed network policy is the same raw document everywhere
    expect((await get(c, "/v1/config")).networkConfig.payload.cameraPolicyByCountry).toEqual({ DE: "full", FR: "zones", CH: "off" });
  }, 120_000);

  it("a node passes on only what it may deliver individually: B and C do not hand the German report to a fourth party, A does", async () => {
    const pulledLats = async (node: Node) =>
      (((await node.app.inject({ method: "GET", url: "/v1/federation/events?after=0&limit=200" })).json() as Json).events as Json[])
        .filter((e) => e.envelope.payload.type === "mobileSpeedCamera")
        .map((e) => e.envelope.payload.lat as number);
    expect(await pulledLats(a)).toEqual([BERLIN.lat]);
    expect(await pulledLats(b)).toEqual([]); // zones on B
    expect(await pulledLats(c)).toEqual([]); // off on C
  });

  it("withdrawing Germany on A stops serving and passing it on there, and leaves the nodes with their own files alone", async () => {
    a.policy.write({ FR: "zones", CH: "off" }); // version 2 without DE
    expect((await a.app.cameraPolicy.reload()).status).toBe("applied");
    expect(await nearby(a, BERLIN)).toEqual({ cameras: [], zones: [] });
    const pulled = ((await a.app.inject({ method: "GET", url: "/v1/federation/events?after=0&limit=200" })).json() as Json).events as Json[];
    expect(pulled.some((e) => e.envelope.payload.type === "mobileSpeedCamera")).toBe(false);
    // B still reads its own (unchanged) file
    expect((await nearby(b, BERLIN)).zones).toHaveLength(1);
    // The data is still there: re-releasing it brings it back without anything being re-sent
    a.policy.write({ DE: "full", FR: "zones", CH: "off" });
    await a.app.cameraPolicy.reload();
    expect((await nearby(a, BERLIN)).cameras).toHaveLength(1);
  });
});
