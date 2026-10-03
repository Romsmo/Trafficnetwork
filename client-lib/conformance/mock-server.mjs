// A scripted Trafficnetwork server for the conformance tests — no dependencies,
// only Node's own modules. It speaks just enough of server/docs/api.md for the
// scenarios in scenarios.json (token, config, static package, snapshot, delta,
// hazard reports, directory) and can host several independent "instances" so a
// scenario can have several servers (a failover pair, a seed and its peer).
//
//   node mock-server.mjs [--port 18990]
//
// Admin API (the language runners use it):
//   POST /__instances            body: instance config   -> { url, rootPublicKey }
//   GET  {url}/__log                                     -> [{ key, body, signatureValid }]
//   POST {url}/__fail            body: { route, status, times }
//
// Instance config (all optional):
//   cameraNamespace: bool     the server's SPEED_CAMERA_NAMESPACE_ENABLED
//   networkConfig: { version, blitzerEnabled }   signed with the instance's root key ...
//   signWith: "root" | "impostor"                ... or, for the forgery scenario, another key
//   peers: [url]              other servers listed in the directory
//   nodeId: string
//
// Everything a real server would sign or verify is done with real Ed25519 and
// RFC 8785 canonical JSON (node:crypto), independently of the Rust library.

import crypto from "node:crypto";
import http from "node:http";

const portFlag = process.argv.indexOf("--port");
const PORT = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 18990;

// ---------------------------------------------------------------- crypto

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

function generateKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { publicKey, privateKey, publicRaw: publicKey.export({ format: "jwk" }).x };
}

function keyId(publicRaw) {
  return crypto.createHash("sha256").update(publicRaw).digest("hex").slice(0, 16);
}

function signEnvelope(payload, key) {
  const signature = crypto.sign(null, Buffer.from(canonical(payload)), key.privateKey);
  return { payload, keyId: keyId(key.publicRaw), signature: signature.toString("base64url") };
}

function verifyEnvelope(envelope, publicRaw) {
  try {
    const publicKey = crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicRaw },
      format: "jwk",
    });
    return crypto.verify(
      null,
      Buffer.from(canonical(envelope.payload)),
      publicKey,
      Buffer.from(envelope.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

// -------------------------------------------------------------- instances

const instances = new Map();
let nextId = 1;
const rootKey = generateKey();
const impostorKey = generateKey();

function createInstance(config) {
  const id = nextId++;
  const url = `http://127.0.0.1:${PORT}/i/${id}`;
  const pkg = {
    tile: "t1",
    speedLimitSegments: [
      {
        id: "seg1",
        geometry: {
          type: "LineString",
          coordinates: [
            [13.0, 52.0],
            [13.01, 52.0],
          ],
        },
        speedLimit: 50,
        speedLimitUnit: "kmh",
        source: "osm",
        sourceLicense: "ODbL",
        importedAt: "2027-01-01T00:00:00Z",
        lastConfirmedAt: null,
      },
    ],
    staticSigns: [
      {
        id: "sign1",
        position: { type: "Point", coordinates: [13.0, 52.0005] },
        signType: "DE:274",
        source: "osm",
        sourceLicense: null,
        importedAt: "2027-01-01T00:00:00Z",
      },
    ],
    fixedSpeedCameras: [],
  };
  const packageText = JSON.stringify(pkg);
  const instance = {
    id,
    url,
    config,
    packageText,
    packageHash: crypto.createHash("sha256").update(packageText).digest("hex"),
    hazards: [],
    events: [],
    sequence: 0,
    log: [],
    failures: [],
    nodeId: config.nodeId ?? `mock-node-${id}`,
  };
  instances.set(id, instance);
  return instance;
}

// CORS: a browser binding (WebAssembly, `bindings/wasm`) calls this server
// with `fetch()` from a page served from another origin, so it needs
// preflight answers and an allow-origin header on every response. Harmless
// to the native bindings, which ignore both.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

function json(res, status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function clientConfig(instance) {
  let networkConfig = null;
  if (instance.config.networkConfig) {
    const signer = instance.config.signWith === "impostor" ? impostorKey : rootKey;
    networkConfig = signEnvelope(
      {
        version: instance.config.networkConfig.version,
        blitzerEnabled: instance.config.networkConfig.blitzerEnabled,
        eventLogRetentionDaysDynamic: 7,
        eventLogRetentionDaysStatic: 30,
        minVersion: "0.1.0",
        excludedNodeIds: [],
        directoryKeyId: null,
        importKeyId: null,
        issuedAt: "2027-01-01T00:00:00.000Z",
      },
      signer,
    );
  }
  return {
    regionTileH3Resolution: 7,
    staticDataPartitionH3Resolution: 4,
    speedCameraNamespaceEnabled: Boolean(instance.config.cameraNamespace),
    cameraNamespaceHazardTypes: [
      "fixedSpeedCamera",
      "mobileSpeedCamera",
      "trailerCamera",
      "redLightCamera",
      "distanceControl",
    ],
    duplicateMergeRadiusMeters: 100,
    speedLimitLookupMaxDistanceMeters: 50,
    hazardExpiryMsByType: { traffic: 900000, ice: 900000, accident: 900000 },
    reportRateLimitMax: 10,
    reportRateLimitWindowMinutes: 10,
    cameraRemovalThreshold: 3,
    staticDataVersion: 1,
    federationEnabled: false,
    networkConfig,
  };
}

function directory(instance) {
  const peer = (address, index) => ({
    nodeId: `peer-${index}`,
    publicKey: "peer-key",
    address,
    tier: "active",
    discoveredVia: "seed",
    joinedAt: "2027-01-01T00:00:00.000Z",
    lastSeenAt: "2027-01-01T00:00:00.000Z",
    lastKnownVersion: "0.1.0",
  });
  return {
    self: { nodeId: instance.nodeId, publicKey: "node-key", address: instance.url, federationEnabled: false },
    peers: (instance.config.peers ?? []).map(peer),
    generatedAt: "2027-01-01T00:00:00.000Z",
  };
}

function addHazard(instance, body) {
  const now = new Date();
  const hazard = {
    id: `hz-${instance.hazards.length + 1}`,
    type: body.type,
    position: { type: "Point", coordinates: [body.lng, body.lat] },
    regionTile: "871f1d489ffffff",
    reportedAt: now.toISOString(),
    reporterId: "mock-reporter",
    speedKmh: body.speedKmh ?? null,
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    status: "active",
    source: "community",
    sourceLicense: null,
    confirmCount: 0,
    denyCount: 0,
  };
  instance.hazards.push(hazard);
  instance.sequence += 1;
  instance.events.push({
    sequence: instance.sequence,
    occurredAt: now.toISOString(),
    type: "ReportCreated",
    entityType: "hazardReport",
    entityId: hazard.id,
    payload: hazard,
    regionTile: hazard.regionTile,
    source: "community",
  });
  return hazard;
}

/** Whether a report's device assertion is what the server would accept. */
function assertionValid(body) {
  const assertion = body.deviceAssertion;
  if (!assertion) return null;
  const p = assertion.payload ?? {};
  const matches =
    p.kind === "create" &&
    p.type === body.type &&
    p.lat === body.lat &&
    p.lng === body.lng &&
    (p.speedKmh ?? null) === (body.speedKmh ?? null);
  const fresh = Math.abs(Date.now() - Date.parse(p.timestamp)) <= 60_000;
  return matches && fresh && verifyEnvelope(assertion, p.devicePublicKey);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __unparseable: text };
  }
}

function handleInstance(instance, req, res, path, query, body) {
  const key = `${req.method} ${path}`;
  const entry = { key, body };

  if (path === "/__log" && req.method === "GET") return json(res, 200, instance.log);
  if (path === "/__fail" && req.method === "POST") {
    instance.failures.push({ route: body.route, status: body.status, times: body.times ?? 1 });
    return json(res, 200, {});
  }

  if (key === "POST /v1/hazard-reports") entry.signatureValid = assertionValid(body ?? {});
  instance.log.push(entry);

  const failure = instance.failures.find((f) => f.route === key && f.times > 0);
  if (failure) {
    failure.times -= 1;
    return json(res, failure.status, { error: { code: "SCRIPTED_FAILURE", message: "scripted" } });
  }

  switch (key) {
    case "POST /v1/auth/token":
      return json(res, 200, { accessToken: "mock-token", tokenType: "Bearer", expiresIn: 3600, scopes: ["client"] });
    case "POST /v1/devices/register":
      return json(res, 201, { clientId: "mock-device", clientSecret: "mock-device-secret" });
    case "POST /v1/devices/bind-key":
      return json(res, 200, { bound: true, publicKey: body?.assertion?.payload?.publicKey ?? "" });
    case "GET /v1/config":
      return json(res, 200, clientConfig(instance));
    case "GET /v1/network/directory":
      return json(res, 200, directory(instance));
    case "GET /v1/network/node-info":
      return json(res, 200, { nodeId: instance.nodeId, publicKey: "node-key", federationEnabled: false });
    case "GET /v1/static-data/manifest":
      return json(res, 200, {
        staticDataVersion: 1,
        generatedAt: "2027-01-01T00:00:00.000Z",
        partitions: [
          { tile: "t1", hash: instance.packageHash, sizeBytes: Buffer.byteLength(instance.packageText) },
        ],
      });
    case "GET /v1/static-data/partitions/t1":
      return json(res, 200, instance.packageText);
    case "GET /v1/snapshot":
      return json(res, 200, {
        snapshotSequence: instance.sequence,
        speedLimitSegments: [],
        staticSigns: [],
        hazardReports: instance.hazards,
        fixedSpeedCameras: [],
      });
    case "GET /v1/delta": {
      const since = Number(query.get("since") ?? 0);
      const events = instance.events.filter((e) => e.sequence > since);
      return json(res, 200, {
        events,
        nextSince: events.length ? events[events.length - 1].sequence : null,
        hasMore: false,
      });
    }
    case "POST /v1/hazard-reports": {
      if (!body || !body.type || typeof body.lat !== "number" || typeof body.lng !== "number") {
        return json(res, 400, { error: { code: "VALIDATION_ERROR", message: "bad body" } });
      }
      return json(res, 201, { report: addHazard(instance, body), merged: false });
    }
    default: {
      const confirm = /^POST \/v1\/hazard-reports\/([^/]+)\/confirmations$/.exec(key);
      if (confirm) {
        const hazard = instance.hazards.find((h) => h.id === confirm[1]);
        if (!hazard) return json(res, 404, { error: { code: "NOT_FOUND", message: "no such report" } });
        return json(res, 200, { report: hazard, recorded: true });
      }
      return json(res, 404, { error: { code: "NOT_FOUND", message: key } });
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const body = await readBody(req);
    if (req.method === "POST" && url.pathname === "/__instances") {
      const instance = createInstance(body ?? {});
      return json(res, 201, { url: instance.url, rootPublicKey: rootKey.publicRaw, impostorPublicKey: impostorKey.publicRaw });
    }
    const match = /^\/i\/(\d+)(\/.*)$/.exec(url.pathname);
    const instance = match && instances.get(Number(match[1]));
    if (!instance) return json(res, 404, { error: { code: "NO_SUCH_INSTANCE", message: url.pathname } });
    return handleInstance(instance, req, res, match[2], url.searchParams, body);
  } catch (error) {
    return json(res, 500, { error: { code: "MOCK_ERROR", message: String(error) } });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(JSON.stringify({ listening: PORT }));
});
