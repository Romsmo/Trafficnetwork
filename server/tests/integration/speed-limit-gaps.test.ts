import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { cellToLatLng, latLngToCell } from "h3-js";
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
import { ingestSpeedLimitVote } from "../../src/modules/speed-limit-corrections/ingest.js";
import { gapGeometry, gapRef, placeOf } from "../../src/modules/speed-limit-corrections/gap.js";
import { flagGapsNeedingReview } from "../../src/modules/speed-limit-corrections/gap-review.js";
import { resetCorrection } from "../../src/modules/speed-limit-corrections/operator.js";

/**
 * "This road has no speed limit on record" (docs/speed-limit-corrections.md D13) end to end on one server: a proposal
 * names a place and a direction, three distinct devices make it a short stretch of road with the value on it, it
 * is served by every read path and announced like any other static data, an objection takes it away again, and
 * an import that later brings a road of its own marks it "needs review" instead of replacing it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

describe("community speed limits for roads with none on record (D13)", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;
  let env: Env;

  const baseEnv = () => ({
    DATABASE_URL: testDb.container.getConnectionUri(),
    JWT_SECRET: "a".repeat(32),
    LOG_LEVEL: "silent",
    COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX: "100",
    WEB_REPORT_LIMIT_PER_SESSION: "100000",
    WEB_REPORT_LIMIT_PER_IP_PER_HOUR: "100000",
    WEB_REPORT_LIMIT_NODE_PER_HOUR: "100000",
  });

  async function startApp(overrides: Record<string, string> = {}) {
    resetEnvCache();
    const appEnv = loadEnv({ ...baseEnv(), ...overrides });
    return { app: await buildApp({ env: appEnv, db: testDb.db }), env: appEnv };
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ app, env } = await startApp());
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  // ---------------------------------------------------------------- helpers

  let counter = 0;
  /** A patch of ground of its own (a resolution-10 cell), so tests never share a gap. */
  function newPlace(bearing = 90) {
    counter += 1;
    const lat = 50.0 + counter * 0.01;
    const lng = 9.0 + counter * 0.013;
    const place = placeOf(lat, lng, bearing);
    const [cellLat, cellLng] = cellToLatLng(place.cell);
    return { lat: cellLat, lng: cellLng, bearing, place, gap: gapGeometry(place) };
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
  async function webCaller() {
    counter += 1;
    return { headers: authHeader(await testToken(env, { sub: `web:gap-${counter}` })) };
  }
  const reader = async () => authHeader(await testToken(env));

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

  type Place = ReturnType<typeof newPlace>;

  async function proposeGap(p: Place, who: Device | { headers: { authorization: string } }, value = 50, extra: Record<string, unknown> = {}) {
    const body: Record<string, unknown> = { lat: p.lat, lng: p.lng, bearingDegrees: p.bearing, value, unit: "kmh", ...extra };
    if ("key" in who && !("deviceAssertion" in extra)) body.deviceAssertion = signVote(who, gapRef(p.place), { value });
    return app.inject({ method: "POST", url: "/v1/speed-limit-gaps", headers: who.headers, payload: body });
  }

  async function vote(correctionId: string, kind: "confirm" | "deny", who: Device, p: Place, value = 50) {
    return app.inject({
      method: "POST",
      url: `/v1/speed-limit-corrections/${correctionId}/confirmations`,
      headers: who.headers,
      payload: { kind, deviceAssertion: signVote(who, p.gap.segmentKey, { vote: kind === "confirm" ? "support" : "deny", value }) },
    });
  }

  async function lookup(p: Place) {
    return app.inject({ method: "GET", url: `/v1/speed-limit?lat=${p.lat}&lng=${p.lng}`, headers: await reader() });
  }

  async function eventSequence(): Promise<number> {
    return (await app.inject({ method: "GET", url: "/v1/snapshot?staticData=false", headers: await reader() })).json().snapshotSequence as number;
  }

  async function staticVersion(): Promise<number> {
    return (await app.inject({ method: "GET", url: "/v1/static-data/manifest", headers: await reader() })).json().staticDataVersion;
  }

  async function communityRows(p: Place) {
    return testDb.db.execute<{ id: string; speed_limit: number; geometry_key: string; source: string } & Record<string, unknown>>(
      sql`select id, speed_limit, geometry_key, source from speed_limit_segments where geometry_key = ${p.gap.segmentKey}`,
    );
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

  // ---------------------------------------------------------------- the road appears at the threshold

  describe("threshold", () => {
    it("one or two devices change nothing; the third puts a stretch of road with the value on it everywhere", async () => {
      const p = newPlace(90);
      const versionBefore = await staticVersion();
      const seqBefore = await eventSequence();
      const [d1, d2, d3] = [await createDevice(), await createDevice(), await createDevice()];

      const first = await proposeGap(p, d1);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({
        recorded: true,
        merged: false,
        segment: null,
        correction: { status: "proposed", confirmations: 1, value: 50, unit: "kmh", source: "community", segmentId: null },
        gap: { segmentKey: p.gap.segmentKey, ref: gapRef(p.place) },
      });
      expect((await lookup(p)).statusCode).toBe(404); // nothing is served below the threshold
      expect(await communityRows(p)).toHaveLength(0);
      expect(await staticVersion()).toBe(versionBefore);

      // two more devices at slightly different spots of the same cell, one driving the other way: the same proposal
      const second = await proposeGap({ ...p, lat: p.lat + 0.0001, lng: p.lng + 0.00008, bearing: 270 }, d2);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ merged: true, correction: { status: "proposed", confirmations: 2 }, segment: null });

      const third = await proposeGap(p, d3);
      expect(third.json()).toMatchObject({ merged: true, correction: { status: "applied", confirmations: 3 } });
      const segment = third.json().segment as Json;
      expect(segment).toMatchObject({ speedLimit: 50, speedLimitUnit: "kmh", source: "community", correctedBy: "community", segmentKey: p.gap.segmentKey });
      expect(segment.importedSpeedLimit).toBeUndefined(); // nothing was imported
      expect(segment.correction).toMatchObject({ confirmations: 3, denials: 0, needsReview: false });
      expect(await staticVersion()).toBeGreaterThan(versionBefore);

      // the row is an ordinary segment, and its stored key is the one the devices derived
      const rows = await communityRows(p);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ speed_limit: 50, source: "community", geometry_key: p.gap.segmentKey });

      // every read path says the same
      const found = (await lookup(p)).json();
      expect(found).toMatchObject({ speedLimit: 50, segmentKey: p.gap.segmentKey, correctedBy: "community" });
      const nearby = (await app.inject({ method: "GET", url: `/v1/speed-limit-segments/nearby?lat=${p.lat}&lng=${p.lng}&radiusM=100`, headers: await reader() })).json();
      expect(nearby.segments.find((s: { id: string }) => s.id === rows[0]!.id)).toMatchObject({ speedLimit: 50, source: "community" });
      const snapshot = (await app.inject({ method: "GET", url: "/v1/snapshot", headers: await reader() })).json();
      expect(snapshot.speedLimitSegments.find((s: { id: string }) => s.id === rows[0]!.id)).toMatchObject({ speedLimit: 50, correctedBy: "community" });
      expect(await segmentInPackages(rows[0]!.id)).toMatchObject({ speedLimit: 50, source: "community" });

      // and it is announced like any other change of static data
      const delta = (await app.inject({ method: "GET", url: `/v1/delta?since=${seqBefore}`, headers: await reader() })).json();
      const event = delta.events.find((e: { entityId: string }) => e.entityId === rows[0]!.id);
      expect(event).toMatchObject({ type: "StaticDataUpdated", entityType: "speedLimitSegment", source: "community" });
      expect(event.payload).toMatchObject({ speedLimit: 50, source: "community" });
    });

    it("a pending proposal is discoverable by area, with its place, so a client can show and confirm it", async () => {
      const p = newPlace(0);
      await proposeGap(p, await createDevice());
      const res = await app.inject({
        method: "GET",
        url: `/v1/speed-limit-corrections?tiles=${gapTile(p)}&status=proposed`,
        headers: await reader(),
      });
      expect(res.statusCode).toBe(200);
      const found = (res.json().corrections as Json[]).find((c) => c.segmentKey === p.gap.segmentKey);
      expect(found).toMatchObject({ status: "proposed", value: 50, confirmations: 1, segmentId: null, importedSpeedLimit: null });
      expect(found!.geometry).toMatchObject({ type: "LineString" });
    });

    it("counts devices, not votes: one device naming the place again is a no-op", async () => {
      const p = newPlace(45);
      const d = await createDevice();
      expect((await proposeGap(p, d)).statusCode).toBe(201);
      for (let i = 0; i < 3; i++) {
        const again = await proposeGap(p, d);
        expect(again.json().recorded).toBe(false);
      }
      expect((await communityRows(p)).length).toBe(0);
    });

    it("another direction at the same place is another stretch of road", async () => {
      const p = newPlace(0);
      const q = { ...p, bearing: 90, place: placeOf(p.lat, p.lng, 90) };
      expect(gapGeometry(q.place).segmentKey).not.toBe(p.gap.segmentKey);
      for (let i = 0; i < 3; i++) await proposeGap(p, await createDevice(), 30);
      expect((await communityRows(p)).length).toBe(1);
      expect((await communityRows({ ...q, gap: gapGeometry(q.place) })).length).toBe(0);
    });
  });

  // ---------------------------------------------------------------- confirm, deny, compete

  describe("objections and competing values", () => {
    it("denials take the road away again, the removal is announced, and new confirmation brings it back", async () => {
      const p = newPlace(90);
      const devices = [await createDevice(), await createDevice(), await createDevice()];
      let id = "";
      for (const d of devices) id = (await proposeGap(p, d)).json().correction.id;
      expect((await lookup(p)).statusCode).toBe(200);
      const rowId = (await communityRows(p))[0]!.id;
      const seq = await eventSequence();

      // two objections: net 3 - 2 = 1 < 3
      const [obj1, obj2] = [await createDevice(), await createDevice()];
      expect((await vote(id, "deny", obj1, p)).statusCode).toBe(200);
      const flipped = await vote(id, "deny", obj2, p);
      expect(flipped.json()).toMatchObject({ correction: { status: "reverted", confirmations: 3, denials: 2 }, segment: null });

      expect((await lookup(p)).statusCode).toBe(404);
      expect(await communityRows(p)).toHaveLength(0);
      const delta = (await app.inject({ method: "GET", url: `/v1/delta?since=${seq}`, headers: await reader() })).json();
      expect(delta.events.filter((e: { entityId: string }) => e.entityId === rowId).at(-1)).toMatchObject({
        type: "StaticDataRemoved",
        entityType: "speedLimitSegment",
      });

      // one more supporter: net 4 - 2 = 2 < 3 still; two more: 5 - 2 = 3 again
      await vote(id, "confirm", await createDevice(), p);
      expect((await lookup(p)).statusCode).toBe(404);
      await vote(id, "confirm", await createDevice(), p);
      const back = await lookup(p);
      expect(back.statusCode).toBe(200);
      expect(back.json()).toMatchObject({ speedLimit: 50, segmentKey: p.gap.segmentKey });
      expect(await communityRows(p)).toHaveLength(1);
    });

    it("two values with the same support: a tie has no winner, so nothing is served", async () => {
      const p = newPlace(90);
      for (let i = 0; i < 3; i++) await proposeGap(p, await createDevice(), 30);
      expect((await lookup(p)).json().speedLimit).toBe(30);
      for (let i = 0; i < 3; i++) await proposeGap(p, await createDevice(), 50);
      expect((await lookup(p)).statusCode).toBe(404);
      expect(await communityRows(p)).toHaveLength(0);
      // one more for 50 and it wins
      await proposeGap(p, await createDevice(), 50);
      expect((await lookup(p)).json().speedLimit).toBe(50);
      expect(await communityRows(p)).toHaveLength(1);
    });

    it("a value that overtakes the winner replaces it: still one row, with the new value", async () => {
      const p = newPlace(90);
      for (let i = 0; i < 3; i++) await proposeGap(p, await createDevice(), 30);
      expect(await communityRows(p)).toHaveLength(1);
      // 3 for 70 is a tie with 30 (no winner, so no road); the fourth decides it
      for (let i = 0; i < 4; i++) await proposeGap(p, await createDevice(), 70);
      const rows = await communityRows(p);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ speed_limit: 70 });
      expect((await lookup(p)).json().speedLimit).toBe(70);
    });

    it("the operator can reset it, and the road is taken away", async () => {
      const p = newPlace(90);
      let id = "";
      for (let i = 0; i < 3; i++) id = (await proposeGap(p, await createDevice())).json().correction.id;
      expect(await communityRows(p)).toHaveLength(1);
      await resetCorrection(testDb.db, env, id, "test reset");
      expect(await communityRows(p)).toHaveLength(0);
      expect((await lookup(p)).statusCode).toBe(404);
    });
  });

  // ---------------------------------------------------------------- what is refused

  describe("what is refused", () => {
    it("a road with a limit on record that runs the same way is not missing: 422, and it names the segment to correct", async () => {
      const p = newPlace(90);
      const id = await insertSpeedLimitSegment(testDb.db, {
        lineString: [[p.lng - 0.002, p.lat + 0.00005], [p.lng + 0.002, p.lat + 0.00005]],
        speedLimit: 30,
      });
      const res = await proposeGap(p, await webCaller());
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("ROAD_ALREADY_HAS_LIMIT");
      expect(res.json().error.details).toMatchObject({ segmentId: id, speedLimit: 30, unit: "kmh" });
      expect(await communityRows(p)).toHaveLength(0);
    });

    it("a crossing road does not block it: a side street next to a road with a limit is still missing", async () => {
      const p = newPlace(0); // proposed: north-south
      await insertSpeedLimitSegment(testDb.db, {
        lineString: [[p.lng - 0.002, p.lat + 0.00005], [p.lng + 0.002, p.lat + 0.00005]], // east-west, 5 m away
        speedLimit: 30,
      });
      const res = await proposeGap(p, await webCaller());
      expect(res.statusCode).toBe(201);
    });

    it("implausible values and shapes", async () => {
      const p = newPlace(90);
      const who = await webCaller();
      expect((await proposeGap(p, who, 33)).json().error.code).toBe("CORRECTION_VALUE_NOT_ON_STEP");
      expect((await proposeGap(p, who, 400)).json().error.code).toBe("CORRECTION_VALUE_OUT_OF_RANGE");
      const noBearing = await app.inject({
        method: "POST",
        url: "/v1/speed-limit-gaps",
        headers: who.headers,
        payload: { lat: p.lat, lng: p.lng, value: 50, unit: "kmh" },
      });
      expect(noBearing.statusCode).toBe(400);
      const island = await app.inject({
        method: "POST",
        url: "/v1/speed-limit-gaps",
        headers: who.headers,
        payload: { lat: 0, lng: 0, bearingDegrees: 10, value: 50, unit: "kmh" },
      });
      expect(island.statusCode).toBe(400);
    });

    it("a signed vote must name the place it is submitted for", async () => {
      const p = newPlace(90);
      const other = newPlace(90);
      const d = await createDevice();
      const wrong = await proposeGap(p, d, 50, { deviceAssertion: signVote(d, gapRef(other.place)) });
      expect(wrong.statusCode).toBe(400);
      const rightKey = await proposeGap(p, d, 50, { deviceAssertion: signVote(d, p.gap.segmentKey) });
      expect(rightKey.statusCode).toBe(201);
    });
  });

  // ---------------------------------------------------------------- replication path

  describe("signed votes arriving from another node", () => {
    it("a place reference resolves to the same stretch of road, and three distinct devices make it effective here too", async () => {
      const p = newPlace(135);
      const devices = [await createDevice(), await createDevice(), await createDevice()];
      for (const d of devices) {
        const outcome = await ingestSpeedLimitVote(testDb.db, env, signVote(d, gapRef(p.place)), "peer-node-1");
        expect(outcome.status).toBe("recorded");
      }
      const rows = await communityRows(p);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ speed_limit: 50, source: "community", geometry_key: p.gap.segmentKey });
      // votes are stored under the derived key, whichever form the device signed
      const keys = await testDb.db.execute<{ segment_key: string } & Record<string, unknown>>(
        sql`select distinct segment_key from speed_limit_correction_votes where segment_key = ${p.gap.segmentKey}`,
      );
      expect(keys).toHaveLength(1);
    });

    it("a reference that is not a resolution-10 cell is rejected as implausible", async () => {
      const d = await createDevice();
      const outcome = await ingestSpeedLimitVote(testDb.db, env, signVote(d, "gap:85283473fffffff:0"), "peer-node-1");
      expect(outcome.status).toBe("rejected");
    });

    it("a vote that arrives by key before the place is known is kept and counts once the place arrives", async () => {
      const p = newPlace(90);
      const [a, b, c] = [await createDevice(), await createDevice(), await createDevice()];
      // two by derived key first (this node has never heard of the place) ...
      for (const d of [a, b]) {
        expect((await ingestSpeedLimitVote(testDb.db, env, signVote(d, p.gap.segmentKey), "peer-node-2")).status).toBe("recorded");
      }
      expect(await communityRows(p)).toHaveLength(0);
      // ... the third names the place: the stretch of road can now be written
      expect((await ingestSpeedLimitVote(testDb.db, env, signVote(c, gapRef(p.place)), "peer-node-2")).status).toBe("recorded");
      expect(await communityRows(p)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------- the import comes later

  describe("an import that brings a road of its own", () => {
    it("never replaces or removes the community value; it is marked as needing review", async () => {
      const p = newPlace(90);
      for (let i = 0; i < 3; i++) await proposeGap(p, await createDevice(), 50);
      const [row] = await communityRows(p);
      expect((await lookup(p)).json().correction).toMatchObject({ needsReview: false });

      // the import now has this road, with another value
      const importedId = await insertSpeedLimitSegment(testDb.db, {
        lineString: [[p.lng - 0.002, p.lat + 0.00003], [p.lng + 0.002, p.lat + 0.00003]],
        speedLimit: 70,
      });
      expect(await flagGapsNeedingReview(testDb.db)).toBe(1);

      const rows = await communityRows(p);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: row!.id, speed_limit: 50 }); // the community's number stays
      const nearby = (await app.inject({ method: "GET", url: `/v1/speed-limit-segments/nearby?lat=${p.lat}&lng=${p.lng}&radiusM=100`, headers: await reader() })).json();
      const community = nearby.segments.find((s: { id: string }) => s.id === row!.id);
      expect(community).toMatchObject({ speedLimit: 50, correctedBy: "community", correction: { needsReview: true } });
      expect(nearby.segments.find((s: { id: string }) => s.id === importedId)).toMatchObject({ speedLimit: 70 });
      // flagging again is a no-op
      expect(await flagGapsNeedingReview(testDb.db)).toBe(0);
    });
  });

  // ---------------------------------------------------------------- the feature switch

  describe("the feature switch", () => {
    it("off: the stretch of road is not served and clients are told it is gone; on again: it is back", async () => {
      const p = newPlace(90);
      for (let i = 0; i < 3; i++) await proposeGap(p, await createDevice());
      const [row] = await communityRows(p);
      expect((await lookup(p)).statusCode).toBe(200);
      const seqOn = await eventSequence();

      const off = await startApp({ COMMUNITY_CORRECTIONS_ENABLED: "false" });
      try {
        const get = async (url: string) => off.app.inject({ method: "GET", url, headers: authHeader(await testToken(off.env)) });
        expect((await get(`/v1/speed-limit?lat=${p.lat}&lng=${p.lng}`)).statusCode).toBe(404);
        const snapshot = (await get("/v1/snapshot")).json();
        expect(snapshot.speedLimitSegments.find((s: { id: string }) => s.id === row!.id)).toBeUndefined();
        const delta = (await get(`/v1/delta?since=${seqOn}`)).json();
        expect(delta.events.filter((e: { entityId: string }) => e.entityId === row!.id).at(-1)).toMatchObject({ type: "StaticDataRemoved" });
        const post = await off.app.inject({
          method: "POST",
          url: "/v1/speed-limit-gaps",
          headers: (await webCaller()).headers,
          payload: { lat: p.lat, lng: p.lng, bearingDegrees: 90, value: 50, unit: "kmh" },
        });
        expect(post.statusCode).toBe(404);
        // kept, only hidden
        expect(await communityRows(p)).toHaveLength(1);
      } finally {
        await off.app.close();
      }

      const on = await startApp();
      try {
        const back = await on.app.inject({ method: "GET", url: `/v1/speed-limit?lat=${p.lat}&lng=${p.lng}`, headers: authHeader(await testToken(on.env)) });
        expect(back.statusCode).toBe(200);
        expect(back.json()).toMatchObject({ speedLimit: 50, correctedBy: "community" });
      } finally {
        await on.app.close();
        resetEnvCache();
        env = loadEnv(baseEnv());
      }
    });
  });

  /** The partition tile (H3 at the static-data resolution) the stretch of road lies in — what `?tiles=` filters by. */
  function gapTile(p: Place): string {
    const lat = (p.gap.coordinates[0][1] + p.gap.coordinates[1][1]) / 2;
    const lng = (p.gap.coordinates[0][0] + p.gap.coordinates[1][0]) / 2;
    return latLngToCell(lat, lng, env.STATIC_DATA_PARTITION_H3_RESOLUTION);
  }
});

