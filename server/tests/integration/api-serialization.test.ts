import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { insertSpeedLimitSegment } from "./helpers.js";
import { generateEd25519KeyPair, keyId } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import { generateClientId } from "../../src/modules/auth/credentials.js";
import { bindDevicePublicKey, insertClient } from "../../src/db/queries/clients.js";
import type { DeviceCreateEventPayload } from "../../src/modules/federation/device-event.js";
import type { SpeedLimitVotePayload } from "../../src/modules/speed-limit-corrections/vote.js";
import { positionToRegionTile } from "../../src/lib/h3.js";

/**
 * fix/api-serialization: every raw-SQL read (`db.execute(sql\`...\`)` in `db/queries/*.ts`, which
 * bypasses Drizzle's typed query builder) used to return two things wrong — see
 * src/db/raw-sql-types.ts for the root cause and the fix. This test checks the *actual wire JSON*
 * of several endpoints against what server/docs/api.md documents: not just that a timestamp or a
 * sequence field is present, but that a sequence number is genuinely a JSON number (unquoted in the
 * response text) and a timestamp is RFC 3339, not Postgres's own text form
 * (`"2026-09-27 14:45:15.923718+00"`). Deliberately reads `res.body` (the raw HTTP response text),
 * not just `res.json()` — `JSON.parse` does not distinguish `123` from `"123"` once parsed back into
 * a JS value if the assertion only checks `typeof`, so the raw text is what actually proves the wire
 * shape (a see-through mistake this bug's previous state would have passed).
 */

const RFC3339_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Every occurrence of `"<key>":<value>` in the raw response text, value captured as written on the wire. */
function wireValuesOf(body: string, key: string): string[] {
  const pattern = new RegExp(`"${key}":(null|"[^"]*"|-?\\d+(?:\\.\\d+)?)`, "g");
  return [...body.matchAll(pattern)].map((m) => m[1]!);
}

function expectWireNumber(body: string, key: string, occurrences = 1) {
  const values = wireValuesOf(body, key);
  expect(values.length, `expected "${key}" to appear ${occurrences} time(s) in: ${body}`).toBe(occurrences);
  for (const v of values) {
    expect(v, `"${key}" must be a bare JSON number, not a quoted string`).toMatch(/^-?\d+(?:\.\d+)?$/);
  }
}

function expectRfc3339Timestamps(body: string, key: string, occurrences = 1) {
  const values = wireValuesOf(body, key).filter((v) => v !== "null");
  expect(values.length, `expected ${occurrences} non-null "${key}" value(s) in: ${body}`).toBe(occurrences);
  for (const v of values) {
    const inner = v.slice(1, -1); // strip the surrounding JSON quotes
    expect(inner, `"${key}": "${inner}" is not RFC 3339`).toMatch(RFC3339_MS);
  }
}

describe("API responses match server/docs/api.md — type and format, not just presence", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;
  let env: Env;
  let auth: { authorization: string };

  beforeAll(async () => {
    testDb = await startTestDatabase();
    resetEnvCache();
    env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      LOG_LEVEL: "silent",
      FEDERATION_ENABLED: "true",
      FEDERATION_PUBLIC_ADDRESS: "https://node-under-test.example",
      COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED: "3",
    });
    app = await buildApp({ env, db: testDb.db });
    auth = authHeader(await testToken(env));
  });

  afterEach(async () => {
    await testDb.db.execute(sql`
      truncate table hazard_confirmations, hazard_reports, speed_limit_correction_votes, speed_limit_corrections,
      speed_limit_segments, static_signs, fixed_speed_cameras, event_log, clients restart identity cascade
    `);
  });

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  it("POST /v1/hazard-reports: reportedAt/expiresAt are RFC 3339", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: auth,
      payload: { type: "ice", lat: 52.52, lng: 13.405 },
    });
    expect(res.statusCode).toBe(201);
    expectRfc3339Timestamps(res.body, "reportedAt");
    expectRfc3339Timestamps(res.body, "expiresAt");
  });

  it("GET /v1/delta: sequence and nextSince are bare numbers, occurredAt is RFC 3339", async () => {
    const tileA = positionToRegionTile(10, 10, env);
    const tileB = positionToRegionTile(20, 20, env);
    await app.inject({ method: "POST", url: "/v1/hazard-reports", headers: auth, payload: { type: "ice", lat: 10, lng: 10 } });
    await app.inject({ method: "POST", url: "/v1/hazard-reports", headers: auth, payload: { type: "traffic", lat: 20, lng: 20 } });

    const res = await app.inject({ method: "GET", url: `/v1/delta?since=0&tiles=${tileA},${tileB}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toHaveLength(2);
    expectWireNumber(res.body, "sequence", 2);
    expectWireNumber(res.body, "nextSince", 1);
    expectRfc3339Timestamps(res.body, "occurredAt", 2);
  });

  it("GET /v1/snapshot: snapshotSequence is a bare number", async () => {
    await app.inject({ method: "POST", url: "/v1/hazard-reports", headers: auth, payload: { type: "ice", lat: 30, lng: 30 } });
    const res = await app.inject({ method: "GET", url: "/v1/snapshot", headers: auth });
    expect(res.statusCode).toBe(200);
    expectWireNumber(res.body, "snapshotSequence", 1);
  });

  it("GET /v1/static-signs/nearby -> snapshot: importedAt is RFC 3339 (a raw-SQL read the earlier fix never touched)", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/bulk-import/static-signs",
      headers: authHeader(await testToken(env, { scopes: ["bulk-import"] })),
      payload: { rows: [{ lat: 40, lng: 40, signType: "DE:274", source: "osm" }] },
    });
    const res = await app.inject({ method: "GET", url: "/v1/snapshot", headers: auth });
    expect(res.json().staticSigns).toHaveLength(1);
    expectRfc3339Timestamps(res.body, "importedAt", 1);
  });

  it("community speed-limit corrections: firstProposedAt/lastVoteAt/appliedAt are RFC 3339 once applied", async () => {
    const segmentId = await insertSpeedLimitSegment(testDb.db, {
      lineString: [
        [13.4, 52.5],
        [13.41, 52.51],
      ],
      speedLimit: 30,
    });
    const [segmentRow] = await testDb.db.execute<{ geometry_key: string } & Record<string, unknown>>(
      sql`select geometry_key from speed_limit_segments where id = ${segmentId}`,
    );
    const segmentKey = segmentRow!.geometry_key;

    for (const name of ["alice", "bob", "carol"]) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/speed-limit-segments/${segmentId}/corrections`,
        headers: authHeader(await testToken(env, { sub: `web:${name}` })),
        payload: { value: 50, unit: "kmh" },
      });
      expect(res.statusCode, `propose/confirm by ${name}: ${res.body}`).toBeLessThan(300);
    }

    const res = await app.inject({ method: "GET", url: `/v1/speed-limit-corrections?segmentId=${segmentId}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const [correction] = res.json().corrections;
    expect(correction.status).toBe("applied");
    expect(correction.segmentKey).toBe(segmentKey);
    expectRfc3339Timestamps(res.body, "firstProposedAt", 1);
    expectRfc3339Timestamps(res.body, "lastVoteAt", 1);
    expectRfc3339Timestamps(res.body, "appliedAt", 1);
  });

  it("GET /v1/federation/events (pull): sequence/nextAfter are bare numbers, occurredAt is RFC 3339", async () => {
    const device = generateEd25519KeyPair();
    const payload: DeviceCreateEventPayload = {
      kind: "create",
      type: "obstacle",
      lat: 60,
      lng: 60,
      devicePublicKey: device.publicKeyRaw,
      timestamp: new Date().toISOString(),
    };
    const envelope = signEnvelope(payload, device);
    const create = await app.inject({
      method: "POST",
      url: "/v1/hazard-reports",
      headers: auth,
      payload: { type: "obstacle", lat: 60, lng: 60, deviceAssertion: envelope },
    });
    expect(create.statusCode).toBe(201);

    const res = await app.inject({ method: "GET", url: "/v1/federation/events?after=0" });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toHaveLength(1);
    expectWireNumber(res.body, "sequence", 1);
    expectWireNumber(res.body, "nextAfter", 1);
    expectRfc3339Timestamps(res.body, "occurredAt", 1);
  });

  it("GET /v1/federation/speed-limit-votes (pull): sequence/nextAfter are bare numbers, receivedAt is RFC 3339", async () => {
    const segmentId = await insertSpeedLimitSegment(testDb.db, {
      lineString: [
        [14.4, 53.5],
        [14.41, 53.51],
      ],
      speedLimit: 30,
    });
    const [segmentRow] = await testDb.db.execute<{ geometry_key: string } & Record<string, unknown>>(
      sql`select geometry_key from speed_limit_segments where id = ${segmentId}`,
    );
    const segmentKey = segmentRow!.geometry_key;

    const clientId = generateClientId();
    await insertClient(testDb.db, { clientId, clientSecretHash: "unused", scopes: ["client"], name: "device" });
    const deviceKey = generateEd25519KeyPair();
    await bindDevicePublicKey(testDb.db, clientId, deviceKey.publicKeyRaw);

    const votePayload: SpeedLimitVotePayload = {
      kind: "speedLimitVote",
      vote: "support",
      segmentKey,
      value: 50,
      unit: "kmh",
      devicePublicKey: deviceKey.publicKeyRaw,
      timestamp: new Date().toISOString(),
    };
    const res = await app.inject({
      method: "POST",
      url: `/v1/speed-limit-segments/${segmentId}/corrections`,
      headers: authHeader(await testToken(env, { sub: clientId })),
      payload: { value: 50, unit: "kmh", deviceAssertion: signEnvelope(votePayload, deviceKey) },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);

    const pull = await app.inject({ method: "GET", url: "/v1/federation/speed-limit-votes?after=0&limit=500" });
    expect(pull.statusCode).toBe(200);
    expect(pull.json().votes).toHaveLength(1);
    expectWireNumber(pull.body, "sequence", 1);
    expectWireNumber(pull.body, "nextAfter", 1);
    expectRfc3339Timestamps(pull.body, "receivedAt", 1);
  });

  it("GET /v1/network/peers: joinedAt/lastSeenAt are RFC 3339", async () => {
    const peer = generateEd25519KeyPair();
    const nodeId = keyId(peer.publicKeyRaw);
    const payload = { nodeId, publicKey: peer.publicKeyRaw, address: "https://peer.example", requestedAt: new Date().toISOString() };
    const join = await app.inject({ method: "POST", url: "/v1/federation/join", payload: signEnvelope(payload, peer) });
    expect(join.statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: "/v1/federation/peers" });
    expect(res.statusCode).toBe(200);
    expect(res.json().peers).toHaveLength(1);
    expectRfc3339Timestamps(res.body, "joinedAt", 1);
    // lastSeenAt is bumped to now() on every successful exchange, including the join itself.
    expectRfc3339Timestamps(res.body, "lastSeenAt", 1);
  });
});
