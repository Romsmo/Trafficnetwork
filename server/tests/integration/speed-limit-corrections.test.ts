import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { insertSpeedLimitSegment } from "./helpers.js";
import { generateClientId } from "../../src/modules/auth/credentials.js";
import { bindDevicePublicKey, insertClient } from "../../src/db/queries/clients.js";
import { generateEd25519KeyPair, type Ed25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import type { SpeedLimitVotePayload } from "../../src/modules/speed-limit-corrections/vote.js";
import { correctionId } from "../../src/modules/speed-limit-corrections/tally.js";
import { ingestSpeedLimitVote } from "../../src/modules/speed-limit-corrections/ingest.js";
import {
  banReporter,
  resetAllApplied,
  resetCorrection,
  restoreCorrection,
  showSegment,
  unbanReporter,
} from "../../src/modules/speed-limit-corrections/operator.js";
import { listCorrections, listOrphanCorrections } from "../../src/db/queries/speed-limit-corrections.js";
import { deviceReporterId } from "../../src/modules/speed-limit-corrections/vote.js";
import { syncCorrectionsOverlaySwitch } from "../../src/modules/speed-limit-corrections/switch.js";

/**
 * Community speed-limit corrections (add-on K-A) end to end on one server:
 * threshold, merge, competing values, denial, plausibility, the per-client
 * rate limit, "an import never overwrites", distribution (lookup / nearby /
 * snapshot / packages / delta / events), the feature switch and the operator
 * tools. Replication across servers is in federation-multi-node.test.ts.
 */
// Parsed JSON response bodies: deliberately loose — the assertions in each test are the schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

describe("community speed-limit corrections (K-A)", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;
  let env: Env;

  const baseEnv = () => ({
    DATABASE_URL: testDb.container.getConnectionUri(),
    JWT_SECRET: "a".repeat(32),
    LOG_LEVEL: "silent",
    // This suite's test builder calls the correction endpoints as web callers (`sub: web:…`), which now also
    // count against the web-UI write limits (docs/status.md, "Kopplung mit K-A") — raise them here so the
    // many calls in this file don't trip WEB_REPORT_LIMIT_PER_IP_PER_HOUR (default 10) and come back 429.
    WEB_REPORT_LIMIT_PER_SESSION: "100000",
    WEB_REPORT_LIMIT_PER_IP_PER_HOUR: "100000",
    WEB_REPORT_LIMIT_NODE_PER_HOUR: "100000",
  });

  async function startApp(overrides: Record<string, string> = {}): Promise<{ app: FastifyInstance; env: Env }> {
    resetEnvCache();
    const appEnv = loadEnv({ ...baseEnv(), ...overrides });
    return { app: await buildApp({ env: appEnv, db: testDb.db }), env: appEnv };
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ app, env } = await startApp({ COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX: "50" }));
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  // ---------------------------------------------------------------- helpers

  let segmentCounter = 0;
  /** A segment on its own patch of ground, so tests never see each other's votes. */
  async function newSegment(speedLimit = 30): Promise<{ id: string; key: string; lat: number; lng: number }> {
    segmentCounter += 1;
    const lng = 8 + segmentCounter * 0.02;
    const lat = 49 + segmentCounter * 0.01;
    const id = await insertSpeedLimitSegment(testDb.db, { lineString: [[lng, lat], [lng + 0.001, lat + 0.001]], speedLimit });
    const rows = await testDb.db.execute<{ geometry_key: string } & Record<string, unknown>>(sql`select geometry_key from speed_limit_segments where id = ${id}`);
    return { id, key: rows[0]!.geometry_key, lat: lat + 0.0005, lng: lng + 0.0005 };
  }

  interface Device {
    clientId: string;
    key: Ed25519KeyPair;
    headers: { authorization: string };
  }
  async function createDevice(): Promise<Device> {
    const clientId = generateClientId();
    await insertClient(testDb.db, { clientId, clientSecretHash: "unused-in-these-tests", scopes: ["client"], name: "device" });
    const key = generateEd25519KeyPair();
    await bindDevicePublicKey(testDb.db, clientId, key.publicKeyRaw);
    return { clientId, key, headers: authHeader(await testToken(env, { sub: clientId })) };
  }
  /** A web-style caller: authenticated, but with no client row and no device key — votes are unsigned and count on this server only. */
  async function webCaller(name: string) {
    return authHeader(await testToken(env, { sub: `web:${name}-${segmentCounter}` }));
  }

  function signVote(device: Device, segmentKey: string, over: Partial<SpeedLimitVotePayload> = {}) {
    const payload: SpeedLimitVotePayload = {
      kind: "speedLimitVote",
      vote: "support",
      segmentKey,
      value: 50,
      unit: "kmh",
      devicePublicKey: device.key.publicKeyRaw,
      timestamp: new Date().toISOString(),
      ...over,
    };
    return signEnvelope(payload, device.key);
  }

  async function propose(seg: { id: string; key: string }, who: Device | { headers: { authorization: string } }, value = 50, extra: Record<string, unknown> = {}) {
    const body: Record<string, unknown> = { value, unit: "kmh", ...extra };
    if ("key" in who && !("deviceAssertion" in extra)) body.deviceAssertion = signVote(who, seg.key, { value });
    return app.inject({ method: "POST", url: `/v1/speed-limit-segments/${seg.id}/corrections`, headers: who.headers, payload: body });
  }

  async function vote(correctionIdValue: string, kind: "confirm" | "deny", who: Device | { headers: { authorization: string } }, seg?: { key: string }, value = 50) {
    const body: Record<string, unknown> = { kind };
    if ("key" in who && seg) body.deviceAssertion = signVote(who, seg.key, { vote: kind === "confirm" ? "support" : "deny", value });
    return app.inject({ method: "POST", url: `/v1/speed-limit-corrections/${correctionIdValue}/confirmations`, headers: who.headers, payload: body });
  }

  const reader = async () => authHeader(await testToken(env));

  /** Current end of the event log — the `since` for a delta read (static data left out: only the sequence is wanted). */
  async function eventSequence(): Promise<number> {
    return (await app.inject({ method: "GET", url: "/v1/snapshot?staticData=false", headers: await reader() })).json().snapshotSequence as number;
  }

  async function nearby(seg: { lat: number; lng: number; id: string }) {
    const res = await app.inject({ method: "GET", url: `/v1/speed-limit-segments/nearby?lat=${seg.lat}&lng=${seg.lng}&radiusM=100`, headers: await reader() });
    expect(res.statusCode).toBe(200);
    return (res.json().segments as Json[]).find((s) => s.id === seg.id)!;
  }

  async function staticVersion(): Promise<number> {
    const res = await app.inject({ method: "GET", url: "/v1/static-data/manifest", headers: await reader() });
    return res.json().staticDataVersion;
  }

  async function segmentInPackages(id: string): Promise<Json | undefined> {
    const manifest = (await app.inject({ method: "GET", url: "/v1/static-data/manifest", headers: await reader() })).json();
    for (const partition of manifest.partitions as { tile: string }[]) {
      const res = await app.inject({ method: "GET", url: `/v1/static-data/partitions/${partition.tile}`, headers: await reader() });
      const found = (res.json().speedLimitSegments as Json[]).find((s) => s.id === id);
      if (found) return found;
    }
    return undefined;
  }

  async function correctionsOf(seg: { id: string }, status = "proposed,applied,superseded,reverted") {
    const res = await app.inject({ method: "GET", url: `/v1/speed-limit-corrections?segmentId=${seg.id}&status=${status}`, headers: await reader() });
    expect(res.statusCode).toBe(200);
    return res.json().corrections as Json[];
  }

  // ---------------------------------------------------------------- threshold & merge

  describe("threshold and merging", () => {
    it("one or two devices change nothing; the third makes the correction effective everywhere", async () => {
      const seg = await newSegment(30);
      const versionBefore = await staticVersion();
      const [d1, d2, d3] = [await createDevice(), await createDevice(), await createDevice()];

      const first = await propose(seg, d1);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ recorded: true, merged: false, correction: { status: "proposed", confirmations: 1, value: 50, unit: "kmh", source: "community" } });
      expect(first.json().segment).toMatchObject({ id: seg.id, speedLimit: 30 });
      expect(first.json().segment.correctedBy).toBeUndefined();
      expect(await staticVersion()).toBe(versionBefore);

      const second = await propose(seg, d2);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ recorded: true, merged: true, correction: { status: "proposed", confirmations: 2 } });
      expect((await nearby(seg)).speedLimit).toBe(30);
      expect((await nearby(seg)).correctedBy).toBeUndefined();

      const third = await propose(seg, d3);
      expect(third.json()).toMatchObject({ merged: true, correction: { status: "applied", confirmations: 3 } });
      expect(third.json().segment).toMatchObject({ speedLimit: 50, correctedBy: "community", importedSpeedLimit: 30 });
      expect(third.json().segment.correction).toMatchObject({ confirmations: 3, denials: 0, needsReview: false });
      expect(third.json().segment.correction.appliedAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
      expect(await staticVersion()).toBeGreaterThan(versionBefore);

      // Every read path tells the same, honest story.
      const viaNearby = await nearby(seg);
      expect(viaNearby).toMatchObject({ speedLimit: 50, correctedBy: "community", importedSpeedLimit: 30, segmentKey: seg.key });
      const lookup = await app.inject({ method: "GET", url: `/v1/speed-limit?lat=${seg.lat}&lng=${seg.lng}`, headers: await reader() });
      expect(lookup.json()).toMatchObject({ segmentId: seg.id, speedLimit: 50, correctedBy: "community", importedSpeedLimit: 30 });
      const snapshot = (await app.inject({ method: "GET", url: "/v1/snapshot", headers: await reader() })).json();
      expect(snapshot.speedLimitSegments.find((s: { id: string }) => s.id === seg.id)).toMatchObject({ speedLimit: 50, correctedBy: "community" });
      expect(await segmentInPackages(seg.id)).toMatchObject({ speedLimit: 50, correctedBy: "community", importedSpeedLimit: 30 });

      // The imported row itself was never touched.
      const stored = await testDb.db.execute<{ speed_limit: number } & Record<string, unknown>>(sql`select speed_limit from speed_limit_segments where id = ${seg.id}`);
      expect(stored[0]!.speed_limit).toBe(30);
    });

    it("announces the change through the event log so delta clients get it", async () => {
      const seg = await newSegment(30);
      const before = await eventSequence();
      for (const d of [await createDevice(), await createDevice(), await createDevice()]) await propose(seg, d);

      const delta = (await app.inject({ method: "GET", url: `/v1/delta?since=${before}`, headers: await reader() })).json();
      const event = delta.events.find((e: { entityId: string }) => e.entityId === seg.id);
      expect(event).toMatchObject({ type: "StaticDataUpdated", entityType: "speedLimitSegment", source: "community", regionTile: null });
      expect(event.payload).toMatchObject({ speedLimit: 50, correctedBy: "community", importedSpeedLimit: 30 });
    });

    it("counts devices, not votes: one device repeating itself is a no-op and never reaches the threshold", async () => {
      const seg = await newSegment(30);
      const d = await createDevice();
      for (let i = 0; i < 4; i++) {
        const res = await propose(seg, d);
        expect(res.statusCode).toBe(i === 0 ? 201 : 200);
        expect(res.json().recorded).toBe(i === 0);
      }
      expect((await correctionsOf(seg))[0]).toMatchObject({ status: "proposed", confirmations: 1 });
      expect((await nearby(seg)).speedLimit).toBe(30);
    });

    it("unsigned votes (web-style callers) count on this server", async () => {
      const seg = await newSegment(30);
      for (const name of ["a", "b", "c"]) expect((await propose(seg, { headers: await webCaller(name) })).statusCode).toBeLessThan(300);
      expect(await nearby(seg)).toMatchObject({ speedLimit: 50, correctedBy: "community" });
    });

    it("a client with a bound key is one device whether it signs or not — it cannot vote twice by mixing", async () => {
      const seg = await newSegment(30);
      const d = await createDevice();
      await propose(seg, d); // signed
      const unsigned = await app.inject({ method: "POST", url: `/v1/speed-limit-segments/${seg.id}/corrections`, headers: d.headers, payload: { value: 50, unit: "kmh" } });
      expect(unsigned.json().recorded).toBe(false);
      expect((await correctionsOf(seg))[0]!.confirmations).toBe(1);
    });

    it("lets a reporter change their mind: a later proposal withdraws the earlier one", async () => {
      const seg = await newSegment(30);
      const d = await createDevice();
      await propose(seg, d, 50);
      await propose(seg, d, 60);
      // Clients see only what someone currently supports...
      const listed = await correctionsOf(seg);
      expect(listed.map((c) => c.value)).toEqual([60]);
      expect(listed[0]!.confirmations).toBe(1);
      // ...while the operator's view still shows the withdrawn value with no supporters.
      const report = await showSegment(testDb.db, env, seg.key);
      expect(report.corrections.find((c) => c.value === 50)).toMatchObject({ confirmations: 0 });
    });
  });

  // ---------------------------------------------------------------- competing values

  describe("competing values", () => {
    it("the value with the most independent confirmations wins once it is at the threshold", async () => {
      const seg = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 50);
      expect((await nearby(seg)).speedLimit).toBe(50);

      for (let i = 0; i < 4; i++) await propose(seg, await createDevice(), 60);
      expect(await nearby(seg)).toMatchObject({ speedLimit: 60, correctedBy: "community", importedSpeedLimit: 30 });
      const all = await correctionsOf(seg);
      expect(all.find((c) => c.value === 60)!.status).toBe("applied");
      expect(all.find((c) => c.value === 50)!.status).toBe("superseded");
    });

    it("a tie for first place applies nothing — the imported value is served until one side pulls ahead", async () => {
      const seg = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 50);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 60);
      expect((await nearby(seg)).speedLimit).toBe(30);
      expect((await nearby(seg)).correctedBy).toBeUndefined();

      await propose(seg, await createDevice(), 60);
      expect((await nearby(seg)).speedLimit).toBe(60);
    });
  });

  // ---------------------------------------------------------------- denial

  describe("denial", () => {
    it("an objection can tip an applied correction back to the imported value, and another confirmation restores it", async () => {
      const seg = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 50);
      expect((await nearby(seg)).speedLimit).toBe(50);
      const id = correctionId(seg.key, "kmh", 50);
      const before = await eventSequence();

      const denier = await createDevice();
      const denied = await vote(id, "deny", denier, seg);
      expect(denied.statusCode).toBe(200);
      expect(denied.json()).toMatchObject({ recorded: true, correction: { status: "reverted", confirmations: 3, denials: 1 } });
      expect(denied.json().segment).toMatchObject({ speedLimit: 30 });
      expect((await nearby(seg)).speedLimit).toBe(30);
      expect((await nearby(seg)).correctedBy).toBeUndefined();

      // The flip is announced too: delta clients see the segment back at its imported value.
      const delta = (await app.inject({ method: "GET", url: `/v1/delta?since=${before}`, headers: await reader() })).json();
      const flip = delta.events.filter((e: { entityId: string }) => e.entityId === seg.id).at(-1);
      expect(flip.payload.speedLimit).toBe(30);
      expect(flip.payload.correctedBy).toBeUndefined();

      const confirmer = await createDevice();
      const confirmed = await vote(id, "confirm", confirmer, seg);
      expect(confirmed.json()).toMatchObject({ correction: { status: "applied", confirmations: 4, denials: 1 } });
      expect((await nearby(seg)).speedLimit).toBe(50);
    });

    it("the same device can take its denial back by confirming", async () => {
      const seg = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 50);
      const id = correctionId(seg.key, "kmh", 50);
      const d = await createDevice();
      await vote(id, "deny", d, seg);
      expect((await nearby(seg)).speedLimit).toBe(30);
      await vote(id, "confirm", d, seg);
      expect(await nearby(seg)).toMatchObject({ speedLimit: 50 });
    });

    it("answers 404 for an unknown correction id and 400 for a malformed one", async () => {
      const d = await createDevice();
      expect((await vote(correctionId("f".repeat(32), "kmh", 50), "deny", d)).statusCode).toBe(404);
      expect((await vote("not-a-uuid", "deny", d)).statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------- plausibility

  describe("plausibility limits", () => {
    it.each([
      [0, "CORRECTION_VALUE_OUT_OF_RANGE"],
      [2, "CORRECTION_VALUE_OUT_OF_RANGE"],
      [500, "CORRECTION_VALUE_OUT_OF_RANGE"],
      [155, "CORRECTION_VALUE_OUT_OF_RANGE"],
      [-30, "CORRECTION_VALUE_OUT_OF_RANGE"],
      [33, "CORRECTION_VALUE_NOT_ON_STEP"],
      [55, null],
    ])("value %s → %s", async (value, code) => {
      const seg = await newSegment(30);
      const res = await app.inject({
        method: "POST",
        url: `/v1/speed-limit-segments/${seg.id}/corrections`,
        headers: await webCaller("plaus"),
        payload: { value, unit: "kmh" },
      });
      if (code) {
        expect(res.statusCode).toBe(422);
        expect(res.json().error.code).toBe(code);
        expect(res.json().error.details).toMatchObject({ unit: "kmh", min: 5, max: 150, step: 5 });
      } else {
        expect(res.statusCode).toBe(201);
      }
    });

    it("rejects a non-integer value at the schema", async () => {
      const seg = await newSegment(30);
      const res = await app.inject({ method: "POST", url: `/v1/speed-limit-segments/${seg.id}/corrections`, headers: await webCaller("frac"), payload: { value: 50.5, unit: "kmh" } });
      expect(res.statusCode).toBe(400);
    });

    it("requires the unit of the source — a km/h segment cannot be corrected in mph", async () => {
      const seg = await newSegment(30);
      const res = await app.inject({ method: "POST", url: `/v1/speed-limit-segments/${seg.id}/corrections`, headers: await webCaller("unit"), payload: { value: 30, unit: "mph" } });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatchObject({ code: "CORRECTION_UNIT_MISMATCH", details: { segmentUnit: "kmh" } });
    });

    it("rejects a 'correction' that equals the imported value", async () => {
      const seg = await newSegment(30);
      const res = await app.inject({ method: "POST", url: `/v1/speed-limit-segments/${seg.id}/corrections`, headers: await webCaller("noop"), payload: { value: 30, unit: "kmh" } });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("CORRECTION_NO_CHANGE");
    });

    it("requires a concrete, existing segment", async () => {
      const missing = await app.inject({
        method: "POST",
        url: "/v1/speed-limit-segments/00000000-0000-4000-8000-000000000000/corrections",
        headers: await webCaller("missing"),
        payload: { value: 50, unit: "kmh" },
      });
      expect(missing.statusCode).toBe(404);
      const malformed = await app.inject({ method: "POST", url: "/v1/speed-limit-segments/nope/corrections", headers: await webCaller("bad"), payload: { value: 50, unit: "kmh" } });
      expect(malformed.statusCode).toBe(400);
    });

    it("stores the optional reason", async () => {
      const seg = await newSegment(30);
      const res = await propose(seg, { headers: await webCaller("why") }, 50, { reason: "sign_missing_or_new" });
      expect(res.json().correction.reason).toBe("sign_missing_or_new");
      const bad = await propose(seg, { headers: await webCaller("why2") }, 50, { reason: "because" });
      expect(bad.statusCode).toBe(400);
    });

    it("honours per-unit bounds for mph segments", async () => {
      const id = await (async () => {
        segmentCounter += 1;
        const lng = 8 + segmentCounter * 0.02;
        const lat = 49 + segmentCounter * 0.01;
        return (
          await testDb.db.execute<{ id: string } & Record<string, unknown>>(sql`
            insert into speed_limit_segments (geometry, speed_limit, speed_limit_unit, source)
            values (ST_SetSRID(ST_GeomFromText(${`LINESTRING(${lng} ${lat}, ${lng + 0.001} ${lat + 0.001})`}), 4326), 30, 'mph', 'test') returning id
          `)
        )[0]!.id;
      })();
      const post = async (value: number) =>
        app.inject({ method: "POST", url: `/v1/speed-limit-segments/${id}/corrections`, headers: await webCaller("mph"), payload: { value, unit: "mph" } });
      expect((await post(100)).statusCode).toBe(422); // fine in km/h, not a posted mph limit
      expect((await post(40)).statusCode).toBe(201);
    });
  });

  // ---------------------------------------------------------------- device signature

  describe("device signature", () => {
    it("accepts a correctly signed vote and stores it as a signed one", async () => {
      const seg = await newSegment(30);
      const d = await createDevice();
      const res = await propose(seg, d);
      expect(res.statusCode).toBe(201);
      const stored = await testDb.db.execute<{ reporter_id: string; has_envelope: boolean } & Record<string, unknown>>(sql`
        select reporter_id, envelope is not null as has_envelope from speed_limit_correction_votes where segment_key = ${seg.key}
      `);
      expect(stored[0]!.has_envelope).toBe(true);
      expect(stored[0]!.reporter_id).toMatch(/^device:[0-9a-f]{16}$/);
    });

    it("rejects an assertion whose payload does not match the submitted vote", async () => {
      const seg = await newSegment(30);
      const d = await createDevice();
      const res = await propose(seg, d, 50, { deviceAssertion: signVote(d, seg.key, { value: 60 }) });
      expect(res.statusCode).toBe(400);
      const wrongSegment = await propose(seg, d, 50, { deviceAssertion: signVote(d, "a".repeat(32)) });
      expect(wrongSegment.statusCode).toBe(400);
    });

    it("rejects a forged signature", async () => {
      const seg = await newSegment(30);
      const d = await createDevice();
      const forged = signVote(d, seg.key);
      forged.signature = signVote(await createDevice(), seg.key).signature;
      expect((await propose(seg, d, 50, { deviceAssertion: forged })).statusCode).toBe(400);
    });

    it("rejects a stale assertion (replay protection)", async () => {
      const seg = await newSegment(30);
      const d = await createDevice();
      const stale = signVote(d, seg.key, { timestamp: new Date(Date.now() - 10 * 60_000).toISOString() });
      expect((await propose(seg, d, 50, { deviceAssertion: stale })).statusCode).toBe(400);
    });

    it("rejects a key that is not the one bound to the calling client — otherwise one client could mint unlimited 'devices'", async () => {
      const seg = await newSegment(30);
      const d = await createDevice();
      const other = { ...d, key: generateEd25519KeyPair() };
      const res = await propose(seg, d, 50, { deviceAssertion: signVote(other, seg.key) });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("DEVICE_KEY_NOT_BOUND");

      const unbound = await app.inject({
        method: "POST",
        url: `/v1/speed-limit-segments/${seg.id}/corrections`,
        headers: await webCaller("nokey"),
        payload: { value: 50, unit: "kmh", deviceAssertion: signVote(d, seg.key) },
      });
      expect(unbound.statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------- rate limit

  describe("rate limit", () => {
    it("is per client, stricter than report limits, and does not charge no-ops", async () => {
      const limited = await startApp({ COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX: "2", COMMUNITY_CORRECTIONS_RATE_LIMIT_WINDOW_MINUTES: "60" });
      try {
        const d = await createDevice();
        const segs = [await newSegment(30), await newSegment(30), await newSegment(30)];
        const send = (seg: (typeof segs)[number], value = 50) =>
          limited.app.inject({
            method: "POST",
            url: `/v1/speed-limit-segments/${seg.id}/corrections`,
            headers: d.headers,
            payload: { value, unit: "kmh", deviceAssertion: signVote(d, seg.key, { value }) },
          });
        expect((await send(segs[0]!)).statusCode).toBe(201);
        expect((await send(segs[0]!)).statusCode).toBe(200); // no-op: not charged
        expect((await send(segs[1]!)).statusCode).toBe(201);
        const over = await send(segs[2]!);
        expect(over.statusCode).toBe(429);
        expect(over.json().error.message).toMatch(/2 speed-limit corrections per 60 minutes/);
        // Nothing was stored for the refused attempt.
        const stored = await testDb.db.execute(sql`select 1 from speed_limit_correction_votes where segment_key = ${segs[2]!.key}`);
        expect(stored).toHaveLength(0);
      } finally {
        await limited.app.close();
        // The shared app keeps its own env for the remaining tests.
        resetEnvCache();
        env = loadEnv({ ...baseEnv(), COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX: "50" });
      }
    });

    it("also budgets denials and confirmations, and mixing signed/unsigned does not double the budget", async () => {
      const limited = await startApp({ COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX: "2" });
      try {
        const d = await createDevice();
        const [s1, s2, s3] = [await newSegment(30), await newSegment(30), await newSegment(30)];
        const unsigned = (seg: typeof s1) => limited.app.inject({ method: "POST", url: `/v1/speed-limit-segments/${seg.id}/corrections`, headers: d.headers, payload: { value: 50, unit: "kmh" } });
        const signed = (seg: typeof s1) =>
          limited.app.inject({ method: "POST", url: `/v1/speed-limit-segments/${seg.id}/corrections`, headers: d.headers, payload: { value: 50, unit: "kmh", deviceAssertion: signVote(d, seg.key) } });
        expect((await unsigned(s1)).statusCode).toBe(201);
        expect((await signed(s2)).statusCode).toBe(201);
        expect((await unsigned(s3)).statusCode).toBe(429);
      } finally {
        await limited.app.close();
        resetEnvCache();
        env = loadEnv({ ...baseEnv(), COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX: "50" });
      }
    });
  });

  // ---------------------------------------------------------------- imports

  describe("bulk import never overwrites a correction", () => {
    async function importSegment(seg: { lat: number; lng: number }, speedLimit: number) {
      const token = authHeader(await testToken(env, { scopes: ["bulk-import"] }));
      const lng = seg.lng - 0.0005;
      const lat = seg.lat - 0.0005;
      return app.inject({
        method: "POST",
        url: "/v1/bulk-import/speed-limit-segments",
        headers: token,
        payload: { rows: [{ lineString: [[lng, lat], [lng + 0.001, lat + 0.001]], speedLimit, speedLimitUnit: "kmh", source: "osm-reimport" }] },
      });
    }
    type Rec = Json;
    async function rowsAt(seg: { lat: number; lng: number }): Promise<Rec[]> {
      const res = await app.inject({ method: "GET", url: `/v1/speed-limit-segments/nearby?lat=${seg.lat}&lng=${seg.lng}&radiusM=50`, headers: await reader() });
      return (res.json().segments as Rec[]).sort((a, b) => a.importedAt.localeCompare(b.importedAt));
    }

    it("keeps the correction when the same geometry is imported again with a changed value, and flags it for review", async () => {
      const seg = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 50);

      expect((await importSegment(seg, 40)).statusCode).toBe(200);

      const [original, reimported] = (await rowsAt(seg)) as [Rec, Rec];
      // Both raw imported values are intact...
      const raw = await testDb.db.execute<{ speed_limit: number } & Record<string, unknown>>(sql`select speed_limit from speed_limit_segments where geometry_key = ${seg.key} order by imported_at`);
      expect(raw.map((r) => r.speed_limit)).toEqual([30, 40]);
      // ...and both still serve the community value; only the one whose import changed asks for review.
      expect(original).toMatchObject({ speedLimit: 50, correctedBy: "community", importedSpeedLimit: 30 });
      expect(original.correction.needsReview).toBe(false);
      expect(reimported).toMatchObject({ speedLimit: 50, correctedBy: "community", importedSpeedLimit: 40 });
      expect(reimported.correction.needsReview).toBe(true);

      const listed = await correctionsOf(seg);
      expect(listed[0]).toMatchObject({ status: "applied", needsReview: true });
    });

    it("re-importing the same wrong value is not a change — no review flag", async () => {
      const seg = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 50);
      await importSegment(seg, 30);
      const rows = await rowsAt(seg);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({ speedLimit: 50, correctedBy: "community" });
        expect(row.correction.needsReview).toBe(false);
      }
    });

    it("an import that already agrees with the community makes the overlay redundant", async () => {
      const seg = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 50);
      await importSegment(seg, 50);
      const [, reimported] = (await rowsAt(seg)) as [Rec, Rec];
      expect(reimported.speedLimit).toBe(50);
      expect(reimported.correctedBy).toBeUndefined();
    });

    it("a wipe-and-reimport (new row ids) falls back to the correction by geometry, not by id", async () => {
      const seg = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 50);
      await testDb.db.execute(sql`delete from speed_limit_segments where id = ${seg.id}`);
      await importSegment(seg, 30);
      const [fresh] = (await rowsAt(seg)) as [Rec];
      expect(fresh.id).not.toBe(seg.id);
      expect(fresh).toMatchObject({ speedLimit: 50, correctedBy: "community", importedSpeedLimit: 30 });
    });

    it("votes that arrive before the segment exists are kept, and pick up the import value as their reference when it appears", async () => {
      const lng = 30.5;
      const lat = 50.5;
      const orphanKey = (
        await testDb.db.execute<{ key: string } & Record<string, unknown>>(sql`
          select speed_limit_geometry_key(ST_SetSRID(ST_GeomFromText(${`LINESTRING(${lng} ${lat}, ${lng + 0.001} ${lat + 0.001})`}), 4326)) as key
        `)
      )[0]!.key;
      for (let i = 0; i < 3; i++) {
        const d = await createDevice();
        const outcome = await ingestSpeedLimitVote(testDb.db, env, signVote(d, orphanKey), "remote-node");
        expect(outcome.status).toBe("recorded");
      }
      expect((await listOrphanCorrections(testDb.db, 100)).some((c) => c.segmentKey === orphanKey)).toBe(true);

      await importSegment({ lat: lat + 0.0005, lng: lng + 0.0005 }, 30);
      const [row] = (await rowsAt({ lat: lat + 0.0005, lng: lng + 0.0005 })) as [Rec];
      expect(row).toMatchObject({ speedLimit: 50, correctedBy: "community", importedSpeedLimit: 30 });
      expect(row.correction.needsReview).toBe(false);
      expect((await listOrphanCorrections(testDb.db, 100)).some((c) => c.segmentKey === orphanKey)).toBe(false);

      // The reference value was learned from that first import, so a later change is detected.
      await importSegment({ lat: lat + 0.0005, lng: lng + 0.0005 }, 40);
      const rows = await rowsAt({ lat: lat + 0.0005, lng: lng + 0.0005 });
      expect(rows.map((r) => r.correction.needsReview)).toEqual([false, true]);
    });

    it("an objection that arrives before anything is proposed leaves no record of its own, yet counts once supporters show up", async () => {
      const seg = await newSegment(30);
      const objector = await createDevice();
      const outcome = await ingestSpeedLimitVote(testDb.db, env, signVote(objector, seg.key, { vote: "deny", value: 60 }), "remote-node");
      expect(outcome.status).toBe("recorded");
      expect(await correctionsOf(seg)).toEqual([]);
      expect(await testDb.db.execute(sql`select 1 from speed_limit_corrections where segment_key = ${seg.key}`)).toHaveLength(0);

      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 60);
      // 3 supporters − 1 earlier objection = net 2: still below the threshold, whichever order the votes arrived in.
      expect((await correctionsOf(seg))[0]).toMatchObject({ value: 60, status: "proposed", confirmations: 3, denials: 1 });
      expect((await nearby(seg)).speedLimit).toBe(30);
      await propose(seg, await createDevice(), 60);
      expect((await nearby(seg)).speedLimit).toBe(60);
    });

    it("a correction in another unit never overlays the segment (units are joined, not converted)", async () => {
      const seg = await newSegment(30); // km/h
      for (let i = 0; i < 3; i++) {
        const d = await createDevice();
        const outcome = await ingestSpeedLimitVote(testDb.db, env, signVote(d, seg.key, { value: 50, unit: "mph" }), "remote-node");
        expect(outcome.status).toBe("recorded");
      }
      const row = await nearby(seg);
      expect(row.speedLimit).toBe(30);
      expect(row.correctedBy).toBeUndefined();
      // The mph proposal exists (and is applied for mph segments, should this server have any)...
      const stored = await testDb.db.execute<{ status: string } & Record<string, unknown>>(sql`
        select status from speed_limit_corrections where segment_key = ${seg.key} and unit = 'mph'
      `);
      expect(stored[0]!.status).toBe("applied");
    });
  });

  // ---------------------------------------------------------------- reads

  describe("reading corrections", () => {
    it("lists proposals and applied corrections by tile, with geometry, for discovery", async () => {
      const seg = await newSegment(30);
      await propose(seg, await createDevice(), 50);
      const { latLngToCell } = await import("h3-js");
      const tile = latLngToCell(seg.lat, seg.lng, 7);
      const res = await app.inject({ method: "GET", url: `/v1/speed-limit-corrections?tiles=${tile}`, headers: await reader() });
      expect(res.statusCode).toBe(200);
      const found = res.json().corrections.find((c: { segmentId: string }) => c.segmentId === seg.id);
      expect(found).toMatchObject({ status: "proposed", value: 50, unit: "kmh", confirmations: 1, denials: 0, importedSpeedLimit: 30, needsReview: false, source: "community" });
      expect(found.geometry.type).toBe("LineString");
      expect(found.id).toBe(correctionId(seg.key, "kmh", 50));
    });

    it("defaults to proposed+applied and filters by status", async () => {
      const seg = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 50);
      await propose(seg, await createDevice(), 60);
      const dflt = await correctionsOf(seg, "proposed,applied");
      expect(dflt.map((c) => c.value).sort()).toEqual([50, 60]);
      const onlyApplied = await app.inject({ method: "GET", url: `/v1/speed-limit-corrections?segmentId=${seg.id}&status=applied`, headers: await reader() });
      expect(onlyApplied.json().corrections.map((c: { value: number }) => c.value)).toEqual([50]);
    });

    it("validates its query: a scope is required, tiles must be H3 cells, status must be known", async () => {
      const h = await reader();
      expect((await app.inject({ method: "GET", url: "/v1/speed-limit-corrections", headers: h })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/v1/speed-limit-corrections?tiles=nonsense", headers: h })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/v1/speed-limit-corrections?segmentId=00000000-0000-4000-8000-000000000000&status=bogus", headers: h })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/v1/speed-limit-corrections?segmentId=00000000-0000-4000-8000-000000000000", headers: h })).statusCode).toBe(404);
    });

    it("GET /v1/speed-limit-segments/:id/corrections returns the segment summary and its corrections", async () => {
      const seg = await newSegment(30);
      await propose(seg, await createDevice(), 50);
      const res = await app.inject({ method: "GET", url: `/v1/speed-limit-segments/${seg.id}/corrections`, headers: await reader() });
      expect(res.statusCode).toBe(200);
      expect(res.json().segment).toMatchObject({ id: seg.id, segmentKey: seg.key, speedLimit: 30 });
      expect(res.json().segment.geometry).toBeUndefined();
      expect(res.json().corrections).toHaveLength(1);
    });

    it("exposes the policy in /v1/config so clients can hide the feature and mirror the limits", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/config", headers: await reader() });
      expect(res.json().communityCorrections).toEqual({
        enabled: true,
        confirmationsRequired: 3,
        valueRange: { kmh: { min: 5, max: 150 }, mph: { min: 5, max: 85 } },
        valueStep: 5,
        rateLimit: { max: 50, windowMinutes: 60 },
      });
    });

    it("keeps the pre-existing segment fields exactly as they were (additive change)", async () => {
      const seg = await newSegment(30);
      const row = await nearby(seg);
      for (const field of ["id", "geometry", "speedLimit", "speedLimitUnit", "source", "sourceLicense", "importedAt", "lastConfirmedAt"]) {
        expect(row, field).toHaveProperty(field);
      }
      expect(Object.keys(row).sort()).toEqual(
        ["geometry", "id", "importedAt", "lastConfirmedAt", "segmentKey", "source", "sourceLicense", "speedLimit", "speedLimitUnit"],
      );
    });
  });

  // ---------------------------------------------------------------- feature switch

  describe("the feature switch", () => {
    it("off: overlay disappears from every read, endpoints are gone, votes are kept — and back on restores it", async () => {
      const seg = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 50);
      expect((await nearby(seg)).speedLimit).toBe(50);
      const versionOn = await staticVersion();
      const seqOn = await eventSequence();
      let versionOff = versionOn;

      const off = await startApp({ COMMUNITY_CORRECTIONS_ENABLED: "false" });
      try {
        const get = async (url: string) => (await off.app.inject({ method: "GET", url, headers: authHeader(await testToken(off.env)) }));
        const nearbyOff = (await get(`/v1/speed-limit-segments/nearby?lat=${seg.lat}&lng=${seg.lng}&radiusM=100`)).json().segments.find((s: { id: string }) => s.id === seg.id);
        expect(nearbyOff.speedLimit).toBe(30);
        expect(nearbyOff.correctedBy).toBeUndefined();
        expect((await get(`/v1/speed-limit?lat=${seg.lat}&lng=${seg.lng}`)).json().speedLimit).toBe(30);
        const snap = (await get("/v1/snapshot")).json();
        expect(snap.speedLimitSegments.find((s: { id: string }) => s.id === seg.id).speedLimit).toBe(30);

        expect((await get("/v1/config")).json().communityCorrections.enabled).toBe(false);
        expect((await get(`/v1/speed-limit-corrections?segmentId=${seg.id}`)).statusCode).toBe(404);
        const post = await off.app.inject({ method: "POST", url: `/v1/speed-limit-segments/${seg.id}/corrections`, headers: await webCaller("off"), payload: { value: 50, unit: "kmh" } });
        expect(post.statusCode).toBe(404);

        // The flip itself was announced: the package version rose and delta clients see the imported value again.
        versionOff = (await get("/v1/static-data/manifest")).json().staticDataVersion as number;
        expect(versionOff).toBeGreaterThan(versionOn);
        const delta = (await get(`/v1/delta?since=${seqOn}`)).json();
        const flip = delta.events.filter((e: { entityId: string }) => e.entityId === seg.id).at(-1);
        expect(flip.payload.speedLimit).toBe(30);
        expect(flip.payload.correctedBy).toBeUndefined();

        // The data is still there.
        const kept = await testDb.db.execute(sql`select 1 from speed_limit_correction_votes where segment_key = ${seg.key}`);
        expect(kept).toHaveLength(3);
      } finally {
        await off.app.close();
      }

      // Switching it back on brings the correction back, with another version bump.
      const on = await startApp({ COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX: "50" });
      try {
        const restored = (await on.app.inject({ method: "GET", url: `/v1/speed-limit-segments/nearby?lat=${seg.lat}&lng=${seg.lng}&radiusM=100`, headers: authHeader(await testToken(on.env)) })).json();
        expect(restored.segments.find((s: { id: string }) => s.id === seg.id)).toMatchObject({ speedLimit: 50, correctedBy: "community" });
        expect((await on.app.inject({ method: "GET", url: "/v1/static-data/manifest", headers: authHeader(await testToken(on.env)) })).json().staticDataVersion).toBeGreaterThan(versionOff);
      } finally {
        await on.app.close();
        resetEnvCache();
        env = loadEnv({ ...baseEnv(), COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX: "50" });
      }
    });

    it("a boot with an unchanged switch does not touch the package version", async () => {
      const before = await staticVersion();
      expect(await syncCorrectionsOverlaySwitch(testDb.db, env)).toBe(false);
      expect(await staticVersion()).toBe(before);
    });

    it("a higher threshold from the environment is honoured — the number lives in configuration, not in code", async () => {
      const strict = await startApp({ COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED: "5", COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX: "50" });
      try {
        const seg = await newSegment(30);
        for (let i = 0; i < 4; i++) {
          const d = await createDevice();
          await strict.app.inject({ method: "POST", url: `/v1/speed-limit-segments/${seg.id}/corrections`, headers: d.headers, payload: { value: 50, unit: "kmh", deviceAssertion: signVote(d, seg.key) } });
        }
        const read = async () => (await strict.app.inject({ method: "GET", url: `/v1/speed-limit-segments/nearby?lat=${seg.lat}&lng=${seg.lng}&radiusM=100`, headers: authHeader(await testToken(strict.env)) })).json().segments.find((s: { id: string }) => s.id === seg.id);
        expect((await read()).speedLimit).toBe(30);
        const d = await createDevice();
        await strict.app.inject({ method: "POST", url: `/v1/speed-limit-segments/${seg.id}/corrections`, headers: d.headers, payload: { value: 50, unit: "kmh", deviceAssertion: signVote(d, seg.key) } });
        expect((await read()).speedLimit).toBe(50);
      } finally {
        await strict.app.close();
        resetEnvCache();
        env = loadEnv({ ...baseEnv(), COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX: "50" });
      }
    });
  });

  // ---------------------------------------------------------------- operator

  describe("operator tools", () => {
    it("shows a segment's rows, corrections and votes", async () => {
      const seg = await newSegment(30);
      const devices = [await createDevice(), await createDevice()];
      for (const d of devices) await propose(seg, d, 50);
      await propose(seg, { headers: await webCaller("unsigned") }, 60);

      for (const ref of [seg.id, seg.key]) {
        const report = await showSegment(testDb.db, env, ref);
        expect(report.segmentKey).toBe(seg.key);
        expect(report.segments.map((s) => s.id)).toContain(seg.id);
        expect(report.corrections.map((c) => c.value).sort()).toEqual([50, 60]);
        expect(report.votes).toHaveLength(3);
        expect(report.votes.filter((v) => v.signed)).toHaveLength(2);
        expect(report.votes.find((v) => !v.signed)!.reporterId).toMatch(/^local:web:/);
      }
      await expect(showSegment(testDb.db, env, "nonsense")).rejects.toThrow(/segment id/);
    });

    it("reset puts the imported value back at once, survives further votes, and restore undoes it", async () => {
      const seg = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 50);
      const id = correctionId(seg.key, "kmh", 50);
      const seq = await eventSequence();

      const outcome = await resetCorrection(testDb.db, env, id, "wrong: 30 zone");
      expect(outcome.changes).toEqual([{ segmentKey: seg.key, unit: "kmh", before: 50, after: null }]);
      expect((await nearby(seg)).speedLimit).toBe(30);
      expect((await nearby(seg)).correctedBy).toBeUndefined();
      expect((await correctionsOf(seg))[0]).toMatchObject({ status: "reverted", confirmations: 3 });
      const delta = (await app.inject({ method: "GET", url: `/v1/delta?since=${seq}`, headers: await reader() })).json();
      expect(delta.events.filter((e: { entityId: string }) => e.entityId === seg.id).at(-1).payload.speedLimit).toBe(30);

      // More agreement does not bring a reset correction back...
      await propose(seg, await createDevice(), 50);
      expect((await nearby(seg)).speedLimit).toBe(30);

      // ...until the operator restores it.
      const restored = await restoreCorrection(testDb.db, env, id);
      expect(restored.changes).toEqual([{ segmentKey: seg.key, unit: "kmh", before: null, after: 50 }]);
      expect((await nearby(seg)).speedLimit).toBe(50);
    });

    it("resetting a winner lets a runner-up that is at the threshold take over — reported as the change, and resettable in turn", async () => {
      const seg = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 50);
      for (let i = 0; i < 4; i++) await propose(seg, await createDevice(), 60);
      expect((await nearby(seg)).speedLimit).toBe(60);

      const outcome = await resetCorrection(testDb.db, env, correctionId(seg.key, "kmh", 60), null);
      expect(outcome.changes).toEqual([{ segmentKey: seg.key, unit: "kmh", before: 60, after: 50 }]);
      expect((await nearby(seg)).speedLimit).toBe(50);

      await resetCorrection(testDb.db, env, correctionId(seg.key, "kmh", 50), null);
      expect((await nearby(seg)).speedLimit).toBe(30);
    });

    it("reset --all rolls back every correction in effect and leaves unconfirmed proposals alone", async () => {
      const applied = await newSegment(30);
      const pending = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(applied, await createDevice(), 50);
      await propose(pending, await createDevice(), 50);

      const { reset } = await resetAllApplied(testDb.db, env, "rollback drill");
      expect(reset).toBeGreaterThanOrEqual(1);
      expect((await nearby(applied)).speedLimit).toBe(30);
      expect((await correctionsOf(pending))[0]!.status).toBe("proposed");
      const stillApplied = await testDb.db.execute(sql`select 1 from speed_limit_corrections where status = 'applied'`);
      expect(stillApplied).toHaveLength(0);
    });

    it("banning a reporter removes their votes from every tally, retroactively; unbanning restores them", async () => {
      const seg = await newSegment(30);
      const [a, b, c] = [await createDevice(), await createDevice(), await createDevice()];
      for (const d of [a, b, c]) await propose(seg, d, 50);
      expect((await nearby(seg)).speedLimit).toBe(50);

      const reporterId = deviceReporterId(a.key.publicKeyRaw);
      const ban = await banReporter(testDb.db, env, reporterId, "spam");
      expect(ban).toEqual({ newlyBanned: true, segmentsRecomputed: 1 });
      expect((await nearby(seg)).speedLimit).toBe(30);
      expect((await correctionsOf(seg))[0]).toMatchObject({ confirmations: 2 });
      expect(await banReporter(testDb.db, env, reporterId, "again")).toMatchObject({ newlyBanned: false });

      // A banned reporter cannot vote any more (the others still can)...
      const bannedAttempt = await app.inject({ method: "POST", url: `/v1/speed-limit-segments/${seg.id}/corrections`, headers: a.headers, payload: { value: 60, unit: "kmh" } });
      expect(bannedAttempt.statusCode).toBe(403);
      expect((await propose(seg, await createDevice(), 60)).statusCode).toBeLessThan(300);

      const unban = await unbanReporter(testDb.db, env, reporterId);
      expect(unban.wasBanned).toBe(true);
      expect((await nearby(seg)).speedLimit).toBe(50);
    });

    it("lists corrections that need review and orphans", async () => {
      const seg = await newSegment(30);
      for (let i = 0; i < 3; i++) await propose(seg, await createDevice(), 50);
      const before = await listCorrections(testDb.db, { statuses: ["applied"], needsReviewOnly: true, limit: 100 });
      expect(before.some((c) => c.segmentKey === seg.key)).toBe(false);
      await testDb.db.execute(sql`
        insert into speed_limit_segments (geometry, speed_limit, speed_limit_unit, source)
        select geometry, 40, speed_limit_unit, 'changed-import' from speed_limit_segments where id = ${seg.id}
      `);
      const after = await listCorrections(testDb.db, { statuses: ["applied"], needsReviewOnly: true, limit: 100 });
      expect(after.some((c) => c.segmentKey === seg.key)).toBe(true);
    });
  });
});
