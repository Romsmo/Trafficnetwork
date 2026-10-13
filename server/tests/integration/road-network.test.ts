import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { cellToLatLng, latLngToCell } from "h3-js";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { insertSpeedLimitSegment, insertStaticSign } from "./helpers.js";
import { generateClientId } from "../../src/modules/auth/credentials.js";
import { bindDevicePublicKey, insertClient } from "../../src/db/queries/clients.js";
import { generateEd25519KeyPair, type Ed25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import type { SpeedLimitVotePayload } from "../../src/modules/speed-limit-corrections/vote.js";
import { ingestSpeedLimitVote } from "../../src/modules/speed-limit-corrections/ingest.js";
import { gapGeometry, gapRef, placeOf } from "../../src/modules/speed-limit-corrections/gap.js";
import { stretchOfGap } from "../../src/modules/speed-limit-corrections/stretch.js";
import { insertCommunitySegment, upsertGap } from "../../src/db/queries/speed-limit-gaps.js";
import { attachAll } from "../../src/modules/roads/attach.js";
import { intervalRef } from "../../src/modules/roads/geo.js";
import { settlePendingIntervals } from "../../src/modules/roads/pending.js";
import { restoreRemoval } from "../../src/modules/defects/service.js";
import { findStaticSignsNearby } from "../../src/db/queries/static-signs.js";
import { resetCorrection } from "../../src/modules/speed-limit-corrections/operator.js";
import { bulkInsertSpeedLimitSegments } from "../../src/db/queries/bulk-import.js";

/**
 * The road network end to end on one server (docs/road-network.md): a stretch of road is named by two points on it and
 * resolved to the road's own shape; three devices make it the limit there (replacing what was imported underneath, and giving it
 * back when the stretch is taken away again); signs and cameras are tied to roads and what is off the road is not served; and
 * entries that enough visitors mark as wrong are taken out and stay out.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

describe("road network", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;
  let env: Env;

  const baseEnv = () => ({
    DATABASE_URL: testDb.container.getConnectionUri(),
    JWT_SECRET: "a".repeat(32),
    LOG_LEVEL: "silent",
    ROAD_LOOKUP_URL: "none",
    COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX: "200",
    WEB_REPORT_LIMIT_PER_SESSION: "100000",
    WEB_REPORT_LIMIT_PER_IP_PER_HOUR: "100000",
    WEB_REPORT_LIMIT_NODE_PER_HOUR: "100000",
  });

  beforeAll(async () => {
    testDb = await startTestDatabase();
    resetEnvCache();
    env = loadEnv(baseEnv());
    app = await buildApp({ env, db: testDb.db });
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
  });

  // ---------------------------------------------------------------- helpers

  let counter = 0;

  /** A straight east-west road of about 1 km of its own, imported as a way. */
  interface Road {
    lat: number;
    west: number;
    east: number;
    name: string;
  }
  async function seedRoad(opts: { name?: string; withLimit?: number; crooked?: boolean } = {}): Promise<Road> {
    counter += 1;
    const lat = 50.1 + counter * 0.02;
    const west = 9.1;
    const east = 9.114; // ~1 km at this latitude
    const name = opts.name ?? `Teststrasse ${counter}`;
    const line: [number, number][] = opts.crooked
      ? [
          [west, lat],
          [(west + east) / 2, lat],
          [(west + east) / 2 + 0.0004, lat + 0.0006],
          [east, lat + 0.0006],
        ]
      : [
          [west, lat],
          [east, lat],
        ];
    const res = await app.inject({
      method: "POST",
      url: "/v1/bulk-import/roads",
      headers: authHeader(await testToken(env, { scopes: ["bulk-import"] })),
      payload: { rows: [{ externalId: `way-${counter}`, lineString: line, highway: "residential", name }] },
    });
    expect(res.statusCode).toBe(200);
    if (opts.withLimit !== undefined) await insertSpeedLimitSegment(testDb.db, { lineString: line, speedLimit: opts.withLimit });
    return { lat, west, east, name };
  }
  /** Marks the res-8 areas around a road as completely known. */
  async function coverAround(lat: number, lng: number, rings = 1) {
    const { gridDisk } = await import("h3-js");
    const tiles = gridDisk(latLngToCell(lat, lng, 8), rings);
    const res = await app.inject({
      method: "POST",
      url: "/v1/bulk-import/road-coverage",
      headers: authHeader(await testToken(env, { scopes: ["bulk-import"] })),
      payload: { tiles },
    });
    expect(res.statusCode).toBe(200);
  }

  const at = (road: Road, fraction: number, dLat = 0) => ({ lat: road.lat + dLat, lng: road.west + (road.east - road.west) * fraction });

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
    return { headers: authHeader(await testToken(env, { sub: `web:road-${counter}` })) };
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

  async function resolve(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
    return app.inject({ method: "POST", url: "/v1/roads/resolve", headers: await reader(), payload: { from, to } });
  }

  async function propose(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
    who: Device | { headers: { authorization: string } },
    value = 50,
    extra: Record<string, unknown> = {},
  ) {
    const body: Record<string, unknown> = { from, to, value, unit: "kmh", ...extra };
    if ("key" in who && !("deviceAssertion" in extra)) body.deviceAssertion = signVote(who, intervalRef(from, to), { value });
    return app.inject({ method: "POST", url: "/v1/speed-limit-intervals", headers: who.headers, payload: body });
  }

  async function limitAt(p: { lat: number; lng: number }): Promise<number | null> {
    const res = await app.inject({ method: "GET", url: `/v1/speed-limit?lat=${p.lat}&lng=${p.lng}`, headers: await reader() });
    return res.statusCode === 200 ? (res.json().speedLimit as number) : null;
  }

  async function staticVersion(): Promise<number> {
    return (await app.inject({ method: "GET", url: "/v1/static-data/manifest", headers: await reader() })).json().staticDataVersion;
  }
  async function eventSequence(): Promise<number> {
    return (await app.inject({ method: "GET", url: "/v1/snapshot?staticData=false", headers: await reader() })).json().snapshotSequence as number;
  }

  const attachEnv = () => ({
    ROAD_SNAP_TOLERANCE_M: env.ROAD_SNAP_TOLERANCE_M,
    CAMERA_POLICY_BORDER_MARGIN_M: env.CAMERA_POLICY_BORDER_MARGIN_M,
    STATIC_DATA_PARTITION_H3_RESOLUTION: env.STATIC_DATA_PARTITION_H3_RESOLUTION,
    CAMERA_ZONE_H3_RESOLUTION: env.CAMERA_ZONE_H3_RESOLUTION,
  });

  // ---------------------------------------------------------------- two points, one stretch of road

  describe("resolving two picked points", () => {
    it("gives the road's own shape between them, with the road's name, whatever order the points come in", async () => {
      const road = await seedRoad({ crooked: true });
      const a = at(road, 0.1, 0.00004); // a few metres beside the road is still "on" it
      const b = at(road, 0.9, 0.0006 + 0.00005); // the way ends on the kinked part, 66 m further north
      const res = await resolve(a, b);
      expect(res.statusCode).toBe(200);
      const body = res.json() as Json;
      expect(body.road).toMatchObject({ name: road.name, class: "residential" });
      expect(body.geometry.type).toBe("LineString");
      // the shape follows the way, including its kink - not the straight line between the two taps
      const lats = (body.geometry.coordinates as [number, number][]).map(([, lat]) => lat);
      expect(body.geometry.coordinates.length).toBeGreaterThanOrEqual(3);
      expect(Math.max(...lats)).toBeGreaterThan(road.lat + 0.0005);
      expect(body.lengthM).toBeGreaterThan(700);
      expect(body.lengthM).toBeLessThan(1000);
      expect(body.ref).toMatch(/^ivl:/);

      // the same stretch, picked from the other end: the same key
      const reversed = (await resolve(b, a)).json() as Json;
      expect(reversed.segmentKey).toBe(body.segmentKey);
      expect(reversed.ref).toBe(body.ref);
    });

    it("says what is on record under the stretch and what has been proposed for it", async () => {
      const road = await seedRoad({ withLimit: 100 });
      const a = at(road, 0.2);
      const b = at(road, 0.6);
      const first = await resolve(a, b);
      expect(first.json().covered).toHaveLength(1);
      expect(first.json().covered[0]).toMatchObject({ speedLimit: 100, unit: "kmh" });
      expect(first.json().proposals).toEqual([]);

      await propose(a, b, await createDevice(), 50);
      const second = (await resolve(a, b)).json() as Json;
      expect(second.proposals).toHaveLength(1);
      expect(second.proposals[0]).toMatchObject({ status: "proposed", value: 50, confirmations: 1 });
    });

    it("refuses with a reason a client can show", async () => {
      const road = await seedRoad();
      const near = await resolve(at(road, 0.3), at(road, 0.3 + 0.00001));
      expect(near.statusCode).toBe(422);
      expect(near.json().error.code).toBe("INTERVAL_TOO_SHORT");

      const far = await resolve(at(road, 0), { lat: road.lat, lng: road.west + 0.1 });
      expect(far.statusCode).toBe(422);
      expect(far.json().error.code).toBe("INTERVAL_TOO_LONG");

      // 300 m from the road, but inside the area the node knows roads for: "no road here"
      const away = await resolve(at(road, 0.2, 0.0027), at(road, 0.5, 0.0027));
      expect(away.statusCode).toBe(422);
      expect(away.json().error.code).toBe("NO_ROAD_FOUND");

      // an area it has no road data for, and cannot look up
      const unknown = await resolve({ lat: 48.0, lng: 11.0 }, { lat: 48.0, lng: 11.003 });
      expect(unknown.statusCode).toBe(422);
      expect(unknown.json().error.code).toBe("NO_ROAD_DATA");

      const island = await resolve({ lat: 0, lng: 0 }, { lat: 0, lng: 0.003 });
      expect(island.statusCode).toBe(400);
    });

    it("tells clients how far a stretch may reach", async () => {
      const config = (await app.inject({ method: "GET", url: "/v1/config", headers: await reader() })).json() as Json;
      expect(config.roadNetwork).toMatchObject({ intervalMaxMeters: env.ROAD_INTERVAL_MAX_M, pickToleranceMeters: env.ROAD_PICK_TOLERANCE_M, lookup: false });
      expect(config.defectReports).toMatchObject({ enabled: true, removalThreshold: env.DEFECT_REMOVAL_THRESHOLD });
    });
  });

  // ---------------------------------------------------------------- the limit is written along the road

  describe("a limit for a stretch", () => {
    it("one or two devices change nothing; the third writes the limit along the road and cuts the imported way open under it", async () => {
      const road = await seedRoad({ withLimit: 100, name: "Hauptstrasse" });
      const a = at(road, 0.3);
      const b = at(road, 0.6);
      const outside = [at(road, 0.1), at(road, 0.9)];
      const middle = at(road, 0.45);
      const versionBefore = await staticVersion();
      const seqBefore = await eventSequence();
      const [d1, d2, d3] = [await createDevice(), await createDevice(), await createDevice()];

      const first = await propose(a, b, d1, 50);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({
        recorded: true,
        merged: false,
        segment: null,
        correction: { status: "proposed", confirmations: 1, value: 50, source: "community", segmentId: null },
        interval: { road: { name: "Hauptstrasse" } },
      });
      expect(first.json().interval.replaces[0]).toMatchObject({ speedLimit: 100 });
      expect(await limitAt(middle)).toBe(100); // below the threshold nothing is served
      expect(await staticVersion()).toBe(versionBefore);

      // a second device taps the same two spots in the other order: the same stretch, the same proposal
      const second = await propose(b, a, d2, 50);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ merged: true, correction: { status: "proposed", confirmations: 2 } });
      expect(await limitAt(middle)).toBe(100);

      const third = await propose(a, b, d3, 50);
      expect(third.json()).toMatchObject({ merged: true, correction: { status: "applied", confirmations: 3 } });
      const segment = third.json().segment as Json;
      expect(segment).toMatchObject({ speedLimit: 50, source: "community", correctedBy: "community" });
      expect(await staticVersion()).toBeGreaterThan(versionBefore);

      // inside: the community's value; outside: the import's - one limit per metre of road
      expect(await limitAt(middle)).toBe(50);
      for (const p of outside) expect(await limitAt(p)).toBe(100);

      // the imported way is now in pieces that together are the road, none of them under the stretch
      const pieces = await testDb.db.execute<{ speed_limit: number; source: string; visible: boolean; len: number } & Record<string, unknown>>(sql`
        select speed_limit, source, visible, ST_Length(geometry::geography)::float8 as len from speed_limit_segments
        where ST_DWithin(geometry::geography, ST_SetSRID(ST_MakePoint(${road.west}, ${road.lat}), 4326)::geography, 1500) and visible
        order by ST_XMin(geometry)
      `);
      expect(pieces.map((p) => p.speed_limit)).toEqual([100, 50, 100]);
      expect(pieces.map((p) => p.source)).toEqual(["seed", "community", "seed"]);
      const total = pieces.reduce((s, p) => s + p.len, 0);
      expect(total).toBeGreaterThan(950);
      expect(total).toBeLessThan(1050);

      // announced like any other change of static data: the whole way goes, its pieces and the stretch arrive
      const delta = (await app.inject({ method: "GET", url: `/v1/delta?since=${seqBefore}`, headers: await reader() })).json();
      const types = (delta.events as { type: string; entityType: string }[]).filter((e) => e.entityType === "speedLimitSegment").map((e) => e.type);
      expect(types).toContain("StaticDataRemoved");
      expect(types.filter((t) => t === "StaticDataUpdated").length).toBeGreaterThanOrEqual(3);
    });

    it("the proposal survives a package rebuild: packages hold the stretch and the pieces, not the whole way", async () => {
      const road = await seedRoad({ withLimit: 100 });
      const a = at(road, 0.25);
      const b = at(road, 0.55);
      for (let i = 0; i < 3; i++) await propose(a, b, await createDevice(), 30);
      const manifest = (await app.inject({ method: "GET", url: "/v1/static-data/manifest", headers: await reader() })).json();
      const found: Json[] = [];
      for (const partition of manifest.partitions as { tile: string }[]) {
        const res = await app.inject({ method: "GET", url: `/v1/static-data/partitions/${partition.tile}`, headers: await reader() });
        for (const s of res.json().speedLimitSegments as Json[]) {
          if (Math.abs(s.geometry.coordinates[0][1] - road.lat) < 0.0002) found.push(s);
        }
      }
      expect(found.map((s) => s.speedLimit).sort()).toEqual([100, 100, 30]);
    });

    it("denials take the stretch away again and the road is whole as before; support brings it back", async () => {
      const road = await seedRoad({ withLimit: 100 });
      const a = at(road, 0.3);
      const b = at(road, 0.6);
      const devices = [await createDevice(), await createDevice(), await createDevice()];
      let id = "";
      for (const d of devices) id = (await propose(a, b, d, 50)).json().correction.id;
      const middle = at(road, 0.45);
      expect(await limitAt(middle)).toBe(50);
      const key = (await resolve(a, b)).json().segmentKey as string;

      const vote = async (kind: "confirm" | "deny", who: Device) =>
        app.inject({
          method: "POST",
          url: `/v1/speed-limit-corrections/${id}/confirmations`,
          headers: who.headers,
          payload: { kind, deviceAssertion: signVote(who, key, { vote: kind === "confirm" ? "support" : "deny", value: 50 }) },
        });
      await vote("deny", await createDevice());
      await vote("deny", await createDevice());
      expect(await limitAt(middle)).toBe(100); // net 3 - 2 = 1 < 3

      // the imported way is one piece again, with its limit
      const visible = await testDb.db.execute<{ speed_limit: number; source: string } & Record<string, unknown>>(sql`
        select speed_limit, source from speed_limit_segments
        where ST_DWithin(geometry::geography, ST_SetSRID(ST_MakePoint(${road.west}, ${road.lat}), 4326)::geography, 1500) and visible
      `);
      expect(visible).toHaveLength(1);
      expect(visible[0]).toMatchObject({ speed_limit: 100, source: "seed" });

      await vote("confirm", await createDevice());
      await vote("confirm", await createDevice());
      expect(await limitAt(middle)).toBe(50);
    });

    it("a value that overtakes another replaces it; a tie serves nothing of the community", async () => {
      const road = await seedRoad({ withLimit: 100 });
      const a = at(road, 0.2);
      const b = at(road, 0.5);
      const middle = at(road, 0.35);
      for (let i = 0; i < 3; i++) await propose(a, b, await createDevice(), 30);
      expect(await limitAt(middle)).toBe(30);
      for (let i = 0; i < 3; i++) await propose(a, b, await createDevice(), 70);
      expect(await limitAt(middle)).toBe(100); // a tie: no winner, the import stands
      await propose(a, b, await createDevice(), 70);
      expect(await limitAt(middle)).toBe(70);
    });

    it("works for a road the import has no limit for: the road gets one, and it is a stretch of that road", async () => {
      const road = await seedRoad({ name: "Feldweg" });
      const a = at(road, 0.15);
      const b = at(road, 0.35);
      for (let i = 0; i < 3; i++) await propose(a, b, await createDevice(), 30);
      expect(await limitAt(at(road, 0.25))).toBe(30);
      expect(await limitAt(at(road, 0.8))).toBeNull();
    });

    it("a limit equal to what the whole stretch already has changes nothing", async () => {
      const road = await seedRoad({ withLimit: 50 });
      const res = await propose(at(road, 0.2), at(road, 0.5), await webCaller(), 50);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("CORRECTION_NO_CHANGE");
    });

    it("counts devices, not votes", async () => {
      const road = await seedRoad({ withLimit: 100 });
      const d = await createDevice();
      const a = at(road, 0.2);
      const b = at(road, 0.5);
      expect((await propose(a, b, d, 30)).statusCode).toBe(201);
      for (let i = 0; i < 3; i++) expect((await propose(a, b, d, 30)).json().recorded).toBe(false);
      expect(await limitAt(at(road, 0.35))).toBe(100);
    });

    it("implausible values and a signature for another stretch are refused", async () => {
      const road = await seedRoad({ withLimit: 100 });
      const who = await webCaller();
      const a = at(road, 0.2);
      const b = at(road, 0.5);
      expect((await propose(a, b, who, 33)).json().error.code).toBe("CORRECTION_VALUE_NOT_ON_STEP");
      expect((await propose(a, b, who, 400)).json().error.code).toBe("CORRECTION_VALUE_OUT_OF_RANGE");
      const d = await createDevice();
      const wrong = await propose(a, b, d, 30, { deviceAssertion: signVote(d, intervalRef(at(road, 0.6), at(road, 0.8)), { value: 30 }) });
      expect(wrong.statusCode).toBe(400);
      // the old way of naming a place no longer exists
      const old = await app.inject({
        method: "POST",
        url: "/v1/speed-limit-gaps",
        headers: who.headers,
        payload: { lat: a.lat, lng: a.lng, bearingDegrees: 90, value: 50, unit: "kmh" },
      });
      expect([403, 404]).toContain(old.statusCode);
    });

    it("the operator can reset it, and the road is whole again", async () => {
      const road = await seedRoad({ withLimit: 100 });
      const a = at(road, 0.3);
      const b = at(road, 0.6);
      let id = "";
      for (let i = 0; i < 3; i++) id = (await propose(a, b, await createDevice(), 50)).json().correction.id;
      expect(await limitAt(at(road, 0.45))).toBe(50);
      await resetCorrection(testDb.db, env, id, "test reset");
      expect(await limitAt(at(road, 0.45))).toBe(100);
    });
  });

  // ---------------------------------------------------------------- signed votes arriving from another node

  describe("signed votes from another node", () => {
    it("an interval reference resolves against this node's roads, and three distinct devices make it effective here too", async () => {
      const road = await seedRoad({ withLimit: 100 });
      const a = at(road, 0.2);
      const b = at(road, 0.45);
      const ref = intervalRef(a, b);
      for (let i = 0; i < 3; i++) {
        const outcome = await ingestSpeedLimitVote(testDb.db, env, signVote(await createDevice(), ref), "peer-node-1");
        expect(outcome.status).toBe("recorded");
      }
      expect(await limitAt(at(road, 0.3))).toBe(50);
    });

    it("a reference to a road this node does not know yet is kept, and counts once the road is here", async () => {
      // the roads of the place are not imported yet
      const lat = 52.3 + (counter += 1) * 0.01;
      const a = { lat, lng: 10.1 };
      const b = { lat, lng: 10.104 };
      const ref = intervalRef(a, b);
      for (let i = 0; i < 3; i++) {
        expect((await ingestSpeedLimitVote(testDb.db, env, signVote(await createDevice(), ref), "peer-node-2")).status).toBe("recorded");
      }
      expect(await limitAt({ lat, lng: 10.102 })).toBeNull();
      const kept = await testDb.db.execute(sql`select 1 from speed_limit_correction_votes where segment_key = ${ref}`);
      expect(kept).toHaveLength(3);

      // the import arrives with the road
      const res = await app.inject({
        method: "POST",
        url: "/v1/bulk-import/roads",
        headers: authHeader(await testToken(env, { scopes: ["bulk-import"] })),
        payload: { rows: [{ externalId: `late-${counter}`, lineString: [[10.09, lat], [10.115, lat]], highway: "residential" }] },
      });
      expect(res.statusCode).toBe(200);
      expect(await settlePendingIntervals({ db: testDb.db, env })).toBeGreaterThanOrEqual(1);
      expect(await limitAt({ lat, lng: 10.102 })).toBe(50);
    });

    it("a legacy place reference (before intervals) is still understood and put on its legacy geometry", async () => {
      const place = placeOf(50.9 + (counter += 1) * 0.01, 9.7, 90);
      for (let i = 0; i < 3; i++) {
        expect((await ingestSpeedLimitVote(testDb.db, env, signVote(await createDevice(), gapRef(place)), "peer-node-3")).status).toBe("recorded");
      }
      const rows = await testDb.db.execute(sql`select 1 from speed_limit_segments where geometry_key = ${gapGeometry(place).segmentKey}`);
      expect(rows).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------- everything sits on a road

  describe("attached to a road", () => {
    it("moves a sign that is near a road onto it, and does not serve one that is off every road of a known area", async () => {
      const road = await seedRoad({ withLimit: 100 });
      await coverAround(road.lat, (road.west + road.east) / 2);
      const nearRoad = await insertStaticSign(testDb.db, { lat: road.lat + 0.00008, lng: road.west + 0.004 }); // ~9 m beside
      const offRoad = await insertStaticSign(testDb.db, { lat: road.lat + 0.0016, lng: road.west + 0.004 }); // ~180 m away
      const versionBefore = await staticVersion();

      const report = await attachAll(testDb.db, attachEnv());
      expect(report.signs.attached).toBeGreaterThanOrEqual(1);
      expect(report.signs.offRoad).toBeGreaterThanOrEqual(1);
      expect(await staticVersion()).toBeGreaterThan(versionBefore);

      const rows = await testDb.db.execute<{ id: string; attach_status: string; visible: boolean; lat: number; road_id: string | null } & Record<string, unknown>>(sql`
        select id, attach_status, visible, ST_Y(position) as lat, road_id from static_signs where id in (${nearRoad}::uuid, ${offRoad}::uuid)
      `);
      const near = rows.find((r) => r.id === nearRoad)!;
      const off = rows.find((r) => r.id === offRoad)!;
      expect(near).toMatchObject({ attach_status: "attached", visible: true });
      expect(near.road_id).not.toBeNull();
      expect(near.lat).toBeCloseTo(road.lat, 6); // exactly on the road, not "schief" to it
      expect(off).toMatchObject({ attach_status: "off_road", visible: false });

      // not served anywhere
      const served = await findStaticSignsNearby(testDb.db, road.lat, road.west + 0.004, 400);
      expect(served.map((s) => s.id)).toContain(nearRoad);
      expect(served.map((s) => s.id)).not.toContain(offRoad);
    });

    it("an area that is not known completely cannot say 'off the road': the item stays and is looked at again later", async () => {
      const lat = 51.9 + (counter += 1) * 0.01;
      const id = await insertStaticSign(testDb.db, { lat, lng: 8.2 });
      const versionBefore = await staticVersion();
      await attachAll(testDb.db, attachEnv());
      await attachAll(testDb.db, attachEnv());
      // nothing changed for a client (the sign stays where it is and stays served): no new package version, no rebuilt tile
      expect(await staticVersion()).toBe(versionBefore);
      const [row] = await testDb.db.execute<{ attach_status: string; visible: boolean } & Record<string, unknown>>(sql`select attach_status, visible from static_signs where id = ${id}::uuid`);
      expect(row).toMatchObject({ attach_status: "unknown", visible: true });

      // the area becomes known, and the sign is still not on a road
      await coverAround(lat, 8.2, 1);
      const again = await attachAll(testDb.db, attachEnv());
      expect(again.signs.offRoad).toBeGreaterThanOrEqual(1);
      const [after] = await testDb.db.execute<{ attach_status: string; visible: boolean } & Record<string, unknown>>(sql`select attach_status, visible from static_signs where id = ${id}::uuid`);
      expect(after).toMatchObject({ attach_status: "off_road", visible: false });
    });

    it("a camera is moved onto its road, too", async () => {
      const road = await seedRoad();
      await coverAround(road.lat, (road.west + road.east) / 2);
      const rows = await testDb.db.execute<{ id: string } & Record<string, unknown>>(sql`
        insert into fixed_speed_cameras (position, camera_type, source, countries)
        values (ST_SetSRID(ST_MakePoint(${road.west + 0.005}, ${road.lat + 0.00009}), 4326), 'fixedSpeedCamera', 'seed', array['DE']::text[])
        returning id
      `);
      const id = rows[0]!.id;
      await attachAll(testDb.db, attachEnv());
      const [c] = await testDb.db.execute<{ attach_status: string; visible: boolean; lat: number } & Record<string, unknown>>(sql`
        select attach_status, visible, ST_Y(position) as lat from fixed_speed_cameras where id = ${id}::uuid
      `);
      expect(c).toMatchObject({ attach_status: "attached", visible: true });
      expect(c!.lat).toBeCloseTo(road.lat, 6);
    });

    it("the legacy 120 m line that does not run along a road of a known area is hidden; one that does stays", async () => {
      const onRoadPlace = placeOf(50.5 + (counter += 1) * 0.01, 9.5, 90);
      const [cLat, cLng] = cellToLatLng(onRoadPlace.cell);
      const res = await app.inject({
        method: "POST",
        url: "/v1/bulk-import/roads",
        headers: authHeader(await testToken(env, { scopes: ["bulk-import"] })),
        payload: { rows: [{ externalId: `legacy-${counter}`, lineString: [[cLng - 0.006, cLat], [cLng + 0.006, cLat]], highway: "residential" }] },
      });
      expect(res.statusCode).toBe(200);
      const fieldPlace = placeOf(cLat + 0.003, cLng, 90); // ~330 m north of that road, in a field
      await coverAround(cLat, cLng, 2);

      for (const place of [onRoadPlace, fieldPlace]) {
        const stretch = stretchOfGap(gapGeometry(place));
        await upsertGap(testDb.db, stretch);
        await insertCommunitySegment(testDb.db, stretch.segmentKey, "kmh", 50);
      }
      const report = await attachAll(testDb.db, attachEnv());
      expect(report.stretchesHidden).toBe(1);

      const visibility = async (place: ReturnType<typeof placeOf>) =>
        (await testDb.db.execute<{ visible: boolean } & Record<string, unknown>>(sql`select visible from speed_limit_segments where geometry_key = ${gapGeometry(place).segmentKey}`))[0]!.visible;
      expect(await visibility(onRoadPlace)).toBe(true);
      expect(await visibility(fieldPlace)).toBe(false);
      // looked at once; the next pass does not look again
      expect((await attachAll(testDb.db, attachEnv())).stretchesHidden).toBe(0);
    });

    it("bulk import brings no events; a run of the attach step is followed by a new package version", async () => {
      const seq = await eventSequence();
      const road = await seedRoad();
      await coverAround(road.lat, (road.west + road.east) / 2);
      await insertStaticSign(testDb.db, { lat: road.lat + 0.0001, lng: road.west + 0.003 });
      const before = await staticVersion();
      await attachAll(testDb.db, attachEnv());
      expect(await staticVersion()).toBeGreaterThan(before);
      expect(await eventSequence()).toBe(seq); // catching up is the packages' job
    });
  });

  // ---------------------------------------------------------------- "this entry is wrong"

  describe("defect reports", () => {
    async function nearItems(p: { lat: number; lng: number }, radius = 60): Promise<Json[]> {
      const res = await app.inject({ method: "GET", url: `/v1/data-defects/near?lat=${p.lat}&lng=${p.lng}&radiusM=${radius}`, headers: await reader() });
      expect(res.statusCode).toBe(200);
      return res.json().items as Json[];
    }
    async function report(targetType: string, targetId: string, who: { headers: { authorization: string } }, reason = "not_on_a_road") {
      return app.inject({ method: "POST", url: "/v1/data-defects", headers: who.headers, payload: { targetType, targetId, reason } });
    }

    it("lists what can be marked near a point, with how many have marked it", async () => {
      const road = await seedRoad({ withLimit: 80 });
      const sign = await insertStaticSign(testDb.db, { lat: road.lat + 0.0001, lng: road.west + 0.002 });
      const items = await nearItems({ lat: road.lat, lng: road.west + 0.002 }, 80);
      expect(items.find((i) => i.targetId === sign)).toMatchObject({ targetType: "staticSign", reports: 0, threshold: env.DEFECT_REMOVAL_THRESHOLD });
      expect(items.find((i) => i.targetType === "speedLimitSegment")).toMatchObject({ speedLimit: 80 });
    });

    it("hides a speed-limit line when enough distinct reporters mark it, announces it, and keeps it hidden after a re-import", async () => {
      const road = await seedRoad({ withLimit: 80 });
      const point = at(road, 0.5);
      const item = (await nearItems(point, 30)).find((i) => i.targetType === "speedLimitSegment")!;
      const seq = await eventSequence();
      const before = await staticVersion();

      const first = await report("speedLimitSegment", item.targetId, await webCaller());
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ recorded: true, reports: 1, removed: false });
      // the same reporter again changes nothing
      const sameCaller = await webCaller();
      expect((await report("speedLimitSegment", item.targetId, sameCaller)).json()).toMatchObject({ reports: 2, removed: false });
      const again = await report("speedLimitSegment", item.targetId, sameCaller);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ recorded: false, reports: 2, removed: false });
      expect(await limitAt(point)).toBe(80);

      const third = await report("speedLimitSegment", item.targetId, await webCaller());
      expect(third.json()).toMatchObject({ recorded: true, reports: 3, removed: true });
      expect(await limitAt(point)).toBeNull();
      expect(await staticVersion()).toBeGreaterThan(before);
      const delta = (await app.inject({ method: "GET", url: `/v1/delta?since=${seq}`, headers: await reader() })).json();
      expect((delta.events as { entityId: string; type: string }[]).find((e) => e.entityId === item.targetId)).toMatchObject({ type: "StaticDataRemoved" });
      expect((await nearItems(point, 30)).find((i) => i.targetId === item.targetId)).toBeUndefined();

      // the next import brings the same line again: it stays out
      const line = item.geometry.coordinates as [number, number][];
      await bulkInsertSpeedLimitSegments(testDb.db, [{ lineString: line, speedLimit: 80, speedLimitUnit: "kmh", source: "seed" }], {
        partitionResolution: env.STATIC_DATA_PARTITION_H3_RESOLUTION,
      });
      expect(await limitAt(point)).toBeNull();

      // an operator can bring it back
      const removed = await testDb.db.execute<{ match_key: string } & Record<string, unknown>>(sql`select match_key from data_defect_removals where target_type = 'speedLimitSegment' order by id desc limit 1`);
      const match_key = removed[0]!.match_key;
      expect(await restoreRemoval(testDb.db, env, "speedLimitSegment", match_key)).toBeGreaterThanOrEqual(1);
      expect(await limitAt(point)).toBe(80);
      // the marks that took it out are spent: it shows with none, and one new mark does not hide it again
      const respawned = (await nearItems(point, 30)).find((i) => i.targetType === "speedLimitSegment" && i.speedLimit === 80)!;
      expect(respawned.reports).toBe(0);
      expect((await report("speedLimitSegment", respawned.targetId, await webCaller())).json()).toMatchObject({ reports: 1, removed: false });
      expect(await limitAt(point)).toBe(80);
    });

    it("a sign is taken out the same way", async () => {
      const road = await seedRoad();
      const sign = await insertStaticSign(testDb.db, { lat: road.lat + 0.0001, lng: road.west + 0.002 });
      for (let i = 0; i < 2; i++) await report("staticSign", sign, await webCaller());
      expect((await findStaticSignsNearby(testDb.db, road.lat, road.west + 0.002, 100)).map((s) => s.id)).toContain(sign);
      expect((await report("staticSign", sign, await webCaller())).json()).toMatchObject({ removed: true });
      expect((await findStaticSignsNearby(testDb.db, road.lat, road.west + 0.002, 100)).map((s) => s.id)).not.toContain(sign);
      // gone is gone: a further mark is a 404, not a second removal
      expect((await report("staticSign", sign, await webCaller())).statusCode).toBe(404);
    });

    it("refuses what is not a target type", async () => {
      const res = await report("hazard", "00000000-0000-4000-8000-000000000000", await webCaller());
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------- the feature switch

  describe("switches", () => {
    it("with defect reports off the endpoints do not exist; resolution stays", async () => {
      resetEnvCache();
      const off = loadEnv({ ...baseEnv(), DEFECT_REPORTS_ENABLED: "false" });
      const other = await buildApp({ env: off, db: testDb.db });
      try {
        const headers = authHeader(await testToken(off));
        expect((await other.inject({ method: "GET", url: "/v1/data-defects/near?lat=50&lng=9", headers })).statusCode).toBe(404);
        expect((await other.inject({ method: "POST", url: "/v1/data-defects", headers, payload: {} })).statusCode).toBe(404);
        expect((await other.inject({ method: "POST", url: "/v1/roads/resolve", headers, payload: { from: { lat: 50, lng: 9 }, to: { lat: 50, lng: 9.004 } } })).statusCode).toBe(422);
        const config = (await other.inject({ method: "GET", url: "/v1/config", headers })).json() as Json;
        expect(config.defectReports).toBeUndefined();
      } finally {
        await other.close();
        resetEnvCache();
        env = loadEnv(baseEnv());
      }
    });
  });
});
