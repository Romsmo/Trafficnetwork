/**
 * B2 (client-lib add-on): a small admin server that starts and controls
 * *real* Trafficnetwork server processes — real `buildApp`, real Postgres
 * (Testcontainers), real federation workers — for client-lib's Rust
 * integration test (`client-lib/core/tests/multi_node.rs`) to drive with a
 * real `TrafficNetworkClient`, over real HTTP, exactly like a host app
 * would. This is deliberately the *only* place client-lib's own tests touch
 * `server/` code, and only as a test harness — no application code here.
 *
 * Modelled on `tests/integration/federation-multi-node.test.ts` (the
 * server-side equivalent), reused as a long-running process instead of a
 * single vitest file: `buildApp`/`startTestDatabase`/`startFederationWorkers`
 * are the same real building blocks, just started and stopped through an
 * admin HTTP API instead of a fixed beforeAll/afterAll.
 *
 * A node's own address doubles as its federation identity, so ports are
 * assigned up front (`nextPort()`) rather than left to the OS — the address
 * has to be known *before* `buildApp()`/`listen()` (see
 * `federation-multi-node.test.ts`'s own header comment for why). Two ports
 * per node: the real server, and a small fault-injection proxy in front of
 * it that the Rust test can use for the "malicious server" scenario without
 * this harness ever patching server code to misbehave on purpose.
 *
 * Run: `npm run test:support:multi-node` (in `server/`). Listens on
 * `MULTI_NODE_HARNESS_PORT` (default 4100). `GET /health` for readiness.
 */
import http from "node:http";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "../integration/setup.js";
import { generateClientId, generateClientSecret, hashSecret } from "../../src/modules/auth/credentials.js";
import { insertClient } from "../../src/db/queries/clients.js";
import { startFederationWorkers, type FederationWorkersHandle } from "../../src/modules/federation/workers.js";
import { generateEd25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import type { DeviceCreateEventPayload } from "../../src/modules/federation/device-event.js";
import type { CameraLevel } from "../../src/modules/cameras/policy/levels.js";
import { createPolicyFixture, EUROPE_BOXES, loadBoundaries, WORLD_AS_DE, type PolicyFixture } from "../integration/camera-policy-helper.js";

const ADMIN_PORT = Number(process.env.MULTI_NODE_HARNESS_PORT ?? 4100);
let nextPort = 19100;
const allocatePort = () => nextPort++;

interface Fault {
  /** Matched as a substring of the request path. */
  pathIncludes: string;
  kind: "corrupt-body" | "drop-event";
  /** For `drop-event`: the `id` of the event to remove from `events[]`. */
  eventId?: string;
  /** How many further matching requests this applies to. */
  remaining: number;
}

interface Node {
  id: string;
  app: FastifyInstance;
  testDb: TestDatabase;
  env: Env;
  port: number;
  proxyPort: number;
  proxyServer: http.Server;
  federation: FederationWorkersHandle | null;
  faults: Fault[];
  /** Present when the node was started with a camera policy: the signed config it reads, rewritten by `/camera-policy`. */
  policy?: PolicyFixture;
}

const nodes = new Map<string, Node>();
let nextNodeId = 1;

function corruptOneByte(body: Buffer): Buffer {
  if (body.length === 0) return body;
  const copy = Buffer.from(body);
  const i = Math.floor(copy.length / 2);
  copy.writeUInt8(copy.readUInt8(i) ^ 0xff, i);
  return copy;
}

function dropEvent(body: Buffer, eventId: string): Buffer {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (Array.isArray(parsed.events)) {
      parsed.events = parsed.events.filter((e: { entityId?: string }) => e.entityId !== eventId);
    }
    return Buffer.from(JSON.stringify(parsed), "utf8");
  } catch {
    return body; // not JSON (or not the shape expected) — pass through unchanged
  }
}

/** A transparent reverse proxy to `targetPort`, applying `node`'s queued faults. */
function startFaultProxy(node: Pick<Node, "port" | "faults">): http.Server {
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { host: "127.0.0.1", port: node.port, path: req.url, method: req.method, headers: req.headers },
      (upstreamRes) => {
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          let body: Buffer<ArrayBufferLike> = Buffer.concat(chunks);
          const path = req.url ?? "";
          const fault = node.faults.find((f) => f.remaining > 0 && path.includes(f.pathIncludes));
          if (fault) {
            body = fault.kind === "corrupt-body" ? corruptOneByte(body) : dropEvent(body, fault.eventId ?? "");
            fault.remaining -= 1;
          }
          const headers = { ...upstreamRes.headers, "content-length": String(body.length) };
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          res.end(body);
        });
      },
    );
    upstream.on("error", () => {
      res.writeHead(502).end();
    });
    req.pipe(upstream);
  });
  return server;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

interface StartNodeRequest {
  federationEnabled?: boolean;
  /** Harness node ids of already-running nodes to join at startup. */
  federationSeedIds?: string[];
  /** The node's own emergency brake (SPEED_CAMERA_NAMESPACE_ENABLED). Alone it releases nothing: see `cameraPolicy`. */
  cameraNamespace?: boolean;
  /**
   * Country-based camera policy (docs/camera-country-policy.md): the levels the node's signed network config lists, e.g.
   * `{ "DE": "full", "FR": "zones" }`. Giving it signs a config (blitzerEnabled: true), releases the node's brake and loads
   * synthetic country boundaries (`boundaries`). Change it later with `POST /nodes/:id/camera-policy`.
   */
  cameraPolicy?: Record<string, CameraLevel>;
  /** Which synthetic country rectangles to load: "europe" (DE, FR, CH, AT - see integration/camera-policy-helper.ts) or "worldAsDe" (one country covering every test coordinate). Default "europe". */
  boundaries?: "europe" | "worldAsDe";
  /** CAMERA_POLICY_LOCAL_CAPS of this node, e.g. "DE=zones". */
  cameraLocalCaps?: string;
  /**
   * Reuse this exact credential instead of provisioning a fresh one — for a
   * client that needs the *same* device identity valid on several
   * independently-started real nodes (each has its own `clients` table;
   * real deployments never share one, this is purely to let one test client
   * reach more than one node in this harness). The plaintext secret has to
   * be given again since only its hash is ever stored.
   */
  sharedCredential?: { clientId: string; clientSecret: string };
}

async function startNode(request: StartNodeRequest): Promise<Node> {
  const id = String(nextNodeId++);
  const port = allocatePort();
  const proxyPort = allocatePort();
  const address = `http://127.0.0.1:${port}`;

  const testDb = await startTestDatabase();
  resetEnvCache();
  const seeds = (request.federationSeedIds ?? [])
    .map((seedId) => nodes.get(seedId))
    .filter((n): n is Node => Boolean(n))
    .map((n) => `http://127.0.0.1:${n.port}`);
  let policy: PolicyFixture | undefined;
  if (request.cameraPolicy) {
    policy = createPolicyFixture();
    await loadBoundaries(testDb.db, request.boundaries === "worldAsDe" ? WORLD_AS_DE : EUROPE_BOXES);
    policy.write(request.cameraPolicy);
  }
  const env = loadEnv({
    DATABASE_URL: testDb.container.getConnectionUri(),
    JWT_SECRET: "multi-node-harness-secret-at-least-32-chars",
    FEDERATION_ENABLED: request.federationEnabled ? "true" : "false",
    FEDERATION_PUBLIC_ADDRESS: address,
    FEDERATION_SEEDS: seeds.join(","),
    FEDERATION_HEARTBEAT_INTERVAL_SECONDS: "1",
    FEDERATION_ANTI_ENTROPY_INTERVAL_SECONDS: "1",
    SPEED_CAMERA_NAMESPACE_ENABLED: request.cameraNamespace ? "true" : "false",
    ...(policy ? policy.env() : {}),
    ...(request.cameraLocalCaps ? { CAMERA_POLICY_LOCAL_CAPS: request.cameraLocalCaps } : {}),
  });

  const app = await buildApp({ env, db: testDb.db });
  await app.listen({ port, host: "127.0.0.1" });
  const federation = env.FEDERATION_ENABLED
    ? startFederationWorkers({ db: testDb.db, env, nodeIdentity: app.nodeIdentity, realtime: app.realtime, log: app.log, online: app.online })
    : null;

  // The proxy reads `node.faults` on every request, so it needs the real
  // node object (mutated later by `/fault`), not a snapshot — `proxyServer`
  // is filled in on the next line, before anything can observe it unset.
  const node: Node = {
    id, app, testDb, env, port, proxyPort, federation, faults: [], policy,
    proxyServer: undefined as unknown as http.Server,
  };
  node.proxyServer = startFaultProxy(node);
  await new Promise<void>((resolve) => node.proxyServer.listen(proxyPort, "127.0.0.1", resolve));

  nodes.set(id, node);
  return node;
}

async function stopNode(node: Node): Promise<void> {
  node.federation?.stop();
  await node.app.close();
  await node.testDb.teardown();
  node.policy?.cleanup();
  await new Promise<void>((resolve) => node.proxyServer.close(() => resolve()));
  nodes.delete(node.id);
}

async function provisionClient(
  node: Node,
  reuse?: { clientId: string; clientSecret: string },
): Promise<{ clientId: string; clientSecret: string }> {
  const clientId = reuse?.clientId ?? generateClientId();
  const clientSecret = reuse?.clientSecret ?? generateClientSecret();
  const clientSecretHash = await hashSecret(clientSecret);
  await insertClient(node.testDb.db, { clientId, clientSecretHash, scopes: ["client"], name: "multi-node-harness" });
  return { clientId, clientSecret };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${ADMIN_PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/nodes") {
      const body = (await readBody(req)) as StartNodeRequest;
      const node = await startNode(body);
      const credentials = await provisionClient(node, body.sharedCredential);
      return json(res, 201, {
        id: node.id,
        address: `http://127.0.0.1:${node.port}`,
        proxyAddress: `http://127.0.0.1:${node.proxyPort}`,
        nodeId: node.app.nodeIdentity.nodeId,
        publicKey: node.app.nodeIdentity.publicKeyRaw,
        ...credentials,
      });
    }
    const nodeMatch = /^\/nodes\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const node = nodeMatch && nodes.get(nodeMatch[1]!);
    if (nodeMatch && !node) {
      return json(res, 404, { error: "no such node" });
    }
    if (node && req.method === "POST" && nodeMatch![2] === "/stop") {
      await stopNode(node);
      return json(res, 200, { ok: true });
    }
    if (node && req.method === "POST" && nodeMatch![2] === "/camera-policy") {
      // Signs the next version of the node's network config and makes the running node read it - no restart, like a real reload.
      if (!node.policy) return json(res, 409, { error: "this node was started without a cameraPolicy" });
      const body = (await readBody(req)) as { levels: Record<string, CameraLevel>; blitzerEnabled?: boolean };
      node.policy.write(body.levels, { blitzerEnabled: body.blitzerEnabled ?? true });
      const result = await node.app.cameraPolicy.reload();
      return json(res, 200, { status: result.status, byCountry: node.app.cameraPolicy.current().byCountry });
    }
    if (node && req.method === "POST" && nodeMatch![2] === "/fault") {
      const body = (await readBody(req)) as Omit<Fault, "remaining"> & { times?: number };
      node.faults.push({ ...body, remaining: body.times ?? 1 });
      return json(res, 200, { ok: true });
    }
    if (node && req.method === "POST" && nodeMatch![2] === "/hazard-reports") {
      // Device-signed (not a bare admin insert): only a report with a
      // deviceAssertion gets a `federation_event_id` at all (see
      // db/queries/event-log.ts's getFederationEventsSince — its `where`
      // clause excludes rows without one), so this is the only way to seed a
      // report that anti-entropy will ever actually replicate to a peer. The
      // signing device key is generated fresh per report and only used here —
      // never a "real" key, just this harness playing the role of a device.
      const body = (await readBody(req)) as { type: string; lat: number; lng: number; speedKmh?: number };
      const keyPair = generateEd25519KeyPair();
      const payload: DeviceCreateEventPayload = {
        kind: "create",
        type: body.type as DeviceCreateEventPayload["type"],
        lat: body.lat,
        lng: body.lng,
        ...(body.speedKmh !== undefined ? { speedKmh: body.speedKmh } : {}),
        devicePublicKey: keyPair.publicKeyRaw,
        timestamp: new Date().toISOString(),
      };
      const deviceAssertion = signEnvelope(payload, keyPair);
      const created = await node.app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: { authorization: `Bearer ${await signTestToken(node)}` },
        payload: { ...body, deviceAssertion },
      });
      return json(res, created.statusCode, created.json());
    }
    if (req.method === "POST" && url.pathname === "/shutdown") {
      json(res, 200, { ok: true });
      await Promise.all([...nodes.values()].map(stopNode));
      server.close();
      process.exit(0);
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: String(error) });
  }
});

// Only for the harness's own `/nodes/:id/hazard-reports` convenience route
// (seeding data without going through the client under test) — a minimal
// token, never exposed outside this process.
async function signTestToken(node: Node): Promise<string> {
  const { signToken } = await import("../../src/modules/auth/jwt.js");
  return signToken({ sub: "multi-node-harness", scopes: ["client"] }, node.env);
}

server.listen(ADMIN_PORT, "127.0.0.1", () => {
  console.log(JSON.stringify({ listening: ADMIN_PORT }));
});

process.on("SIGTERM", async () => {
  await Promise.all([...nodes.values()].map(stopNode));
  process.exit(0);
});
