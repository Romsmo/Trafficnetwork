import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache, type Env } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { generateClientId } from "../../src/modules/auth/credentials.js";
import { bindDevicePublicKey, insertClient } from "../../src/db/queries/clients.js";
import { generateEd25519KeyPair, type Ed25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import { getSignedVotesSince, getVersion } from "../../src/db/queries/context-signs.js";
import { ingestContextSignVote } from "../../src/modules/context-signs/ingest.js";
import { banReporter, expireEntries, removeEntry, restoreEntry, unbanReporter } from "../../src/modules/context-signs/service.js";
import type { ContextSignVotePayload } from "../../src/modules/context-signs/vote.js";
import { deviceReporterId } from "../../src/modules/context-signs/vote.js";
import { latLngToCell } from "h3-js";

/**
 * Context signs end to end on one server (docs/context-signs.md): a stretch named on the map is resolved to the road, proposed,
 * confirmed or objected to by other devices, delivered by area and by tile, kept off by the operator, expired, and replicated as
 * signed votes. The feature starts empty and must be quiet then.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

describe("context signs", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;
  let env: Env;
  let counter = 0;
  const closers: (() => Promise<void>)[] = [];

  const baseEnv = (extra: Record<string, string> = {}) => ({
    DATABASE_URL: testDb.container.getConnectionUri(),
    JWT_SECRET: "a".repeat(32),
    LOG_LEVEL: "silent",
    ROAD_LOOKUP_URL: "none",
    WEB_REPORT_LIMIT_PER_SESSION: "100000",
    WEB_REPORT_LIMIT_PER_IP_PER_HOUR: "100000",
    WEB_REPORT_LIMIT_NODE_PER_HOUR: "100000",
    ...extra,
  });
  async function build(extra: Record<string, string> = {}) {
    resetEnvCache();
    const e = loadEnv(baseEnv(extra));
    const a = await buildApp({ env: e, db: testDb.db });
    closers.push(() => a.close());
    return { app: a, env: e };
  }

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ app, env } = await build());
  }, 90_000);

  afterAll(async () => {
    for (const close of closers) await close();
    await testDb.teardown();
  });

  // ---------------------------------------------------------------- helpers

  interface Road {
    lat: number;
    west: number;
    east: number;
  }
  /** A straight east-west road of about 1 km, imported as a way (every test gets its own, far from the others). */
  async function seedRoad(a: FastifyInstance = app, e: Env = env): Promise<Road> {
    counter += 1;
    const lat = 49.0 + counter * 0.05;
    const west = 9.1;
    const east = 9.114;
    const res = await a.inject({
      method: "POST",
      url: "/v1/bulk-import/roads",
      headers: authHeader(await testToken(e, { scopes: ["bulk-import"] })),
      payload: { rows: [{ externalId: `cs-way-${counter}`, lineString: [[west, lat], [east, lat]], highway: "residential", name: `Teststrasse ${counter}` }] },
    });
    expect(res.statusCode).toBe(200);
    return { lat, west, east };
  }
  const at = (road: Road, fraction: number) => ({ lat: road.lat, lng: road.west + (road.east - road.west) * fraction });

  interface Device {
    clientId: string;
    key: Ed25519KeyPair;
    headers: { authorization: string };
    reporterId: string;
  }
  async function createDevice(e: Env = env, bound = true): Promise<Device> {
    const clientId = generateClientId();
    await insertClient(testDb.db, { clientId, clientSecretHash: "unused-in-these-tests", scopes: ["client"], name: "device" });
    const key = generateEd25519KeyPair();
    if (bound) await bindDevicePublicKey(testDb.db, clientId, key.publicKeyRaw);
    return { clientId, key, headers: authHeader(await testToken(e, { sub: clientId })), reporterId: deviceReporterId(key.publicKeyRaw) };
  }
  async function webCaller(e: Env = env) {
    counter += 1;
    return { headers: authHeader(await testToken(e, { sub: `web:cs-${counter}` })) };
  }
  const reader = async (e: Env = env) => authHeader(await testToken(e));

  const sign = (device: Device, payload: Omit<ContextSignVotePayload, "kind" | "devicePublicKey" | "timestamp" | "entry"> & { entry?: Json; timestamp?: string }) =>
    signEnvelope<ContextSignVotePayload>({ kind: "contextSignVote", devicePublicKey: device.key.publicKeyRaw, timestamp: new Date().toISOString(), ...payload } as ContextSignVotePayload, device.key);

  async function resolve(road: Road, body: Json, a: FastifyInstance = app, headers?: { authorization: string }) {
    const res = await a.inject({
      method: "POST",
      url: "/v1/context-signs/resolve",
      headers: headers ?? (await reader()),
      payload: { signType: "DE:142-10", from: at(road, 0.2), to: at(road, 0.35), direction: "both", ...body },
    });
    return res;
  }

  /** Resolve, then propose with a signed vote - what a client library does. */
  async function propose(device: Device, road: Road, body: Json = {}, a: FastifyInstance = app) {
    const resolved = await resolve(road, body, a, device.headers);
    expect(resolved.statusCode).toBe(200);
    const { descriptor, entryKey } = resolved.json() as Json;
    const assertion = sign(device, { vote: "support", entryKey, entry: descriptor });
    const res = await a.inject({ method: "POST", url: "/v1/context-signs", headers: device.headers, payload: { descriptor, deviceAssertion: assertion } });
    return { res, entryKey: entryKey as string, descriptor: descriptor as Json };
  }
  async function vote(device: Device, entryKey: string, descriptor: Json, kind: "confirm" | "deny", a: FastifyInstance = app) {
    const assertion = sign(device, kind === "confirm" ? { vote: "support", entryKey, entry: descriptor } : { vote: "deny", entryKey });
    return a.inject({ method: "POST", url: `/v1/context-signs/${entryKey}/confirmations`, headers: device.headers, payload: { kind, deviceAssertion: assertion } });
  }
  const list = async (road: Road, a: FastifyInstance = app, e: Env = env) => {
    const res = await a.inject({
      method: "GET",
      url: `/v1/context-signs?bbox=${road.west - 0.01},${road.lat - 0.01},${road.east + 0.01},${road.lat + 0.01}`,
      headers: await reader(e),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Json;
  };
  const versionOf = () => getVersion(testDb.db);

  // ---------------------------------------------------------------- tests

  it("starts empty and quiet: lists, tiles and the configuration answer with nothing, never an error", async () => {
    const road = await seedRoad();
    expect((await list(road)).entries).toEqual([]);
    const tile = latLngToCell(road.lat, road.west, env.STATIC_DATA_PARTITION_H3_RESOLUTION);
    const tiles = await app.inject({ method: "GET", url: `/v1/context-signs/tiles?tiles=${tile}`, headers: await reader() });
    expect(tiles.statusCode).toBe(200);
    expect(tiles.json()).toMatchObject({ unchanged: false, tiles: [{ tile, entries: [] }] });
    const near = await app.inject({ method: "GET", url: `/v1/context-signs?lat=${road.lat}&lng=${road.west}&radiusM=2000`, headers: await reader() });
    expect(near.json().entries).toEqual([]);
    const config = await app.inject({ method: "GET", url: "/v1/config", headers: await reader() });
    expect(config.json().contextSigns).toMatchObject({ enabled: true, confirmationsRequired: { prohibition: 3, hazard: 2 } });
  });

  it("resolves two points to the road, oriented in the order picked", async () => {
    const road = await seedRoad();
    const forward = (await resolve(road, { direction: "along" })).json() as Json;
    const backward = (await resolve(road, { direction: "along", from: at(road, 0.35), to: at(road, 0.2) })).json() as Json;
    const g = forward.descriptor.geometry as [number, number][];
    expect(g.length).toBeGreaterThanOrEqual(2);
    expect(g[0]![0]).toBeLessThan(g.at(-1)![0]); // west to east, as picked
    expect(backward.descriptor.geometry[0][0]).toBeGreaterThan(backward.descriptor.geometry.at(-1)[0]);
    expect(forward.entryKey).not.toBe(backward.entryKey); // one way vs the other
    expect(forward.road.name).toMatch(/Teststrasse/);
    expect(forward.timezone).toBe("Europe/Berlin");
    expect(forward.lengthM).toBeGreaterThan(100);

    // a sign that applies both ways is the same entry whichever way it was picked
    const both1 = (await resolve(road, { direction: "both" })).json() as Json;
    const both2 = (await resolve(road, { direction: "both", from: at(road, 0.35), to: at(road, 0.2) })).json() as Json;
    expect(both2.entryKey).toBe(both1.entryKey);
  });

  it("resolves a sign that stands at one place from one point and the direction of travel", async () => {
    const road = await seedRoad();
    const needsHeading = await resolve(road, { signType: "DE:151", to: undefined, direction: "along" });
    expect(needsHeading.statusCode).toBe(422);
    expect(needsHeading.json().error.code).toBe("HEADING_REQUIRED");
    const east = (await resolve(road, { signType: "DE:151", to: undefined, direction: "along", heading: 90 })).json() as Json;
    const west = (await resolve(road, { signType: "DE:151", to: undefined, direction: "along", heading: 270 })).json() as Json;
    expect(east.lengthM).toBeGreaterThan(4);
    expect(east.lengthM).toBeLessThan(12);
    expect(east.descriptor.geometry[0][0]).toBeLessThan(east.descriptor.geometry.at(-1)[0]);
    expect(west.descriptor.geometry[0][0]).toBeGreaterThan(west.descriptor.geometry.at(-1)[0]);
    // a sign that covers a stretch needs two points
    const stretch = await resolve(road, { signType: "DE:276", to: undefined });
    expect(stretch.statusCode).toBe(422);
    expect(stretch.json().error.code).toBe("SIGN_NEEDS_TWO_POINTS");
  });

  it("says why it cannot resolve: unknown sign, no road, no road data", async () => {
    const road = await seedRoad();
    expect((await resolve(road, { signType: "DE:999" })).json().error.code).toBe("UNKNOWN_SIGN");
    expect((await resolve(road, { signType: "FR:276" })).json().error.code).toBe("UNKNOWN_SIGN");
    const farAway = { lat: 40.0, lng: 3.0 };
    const none = await app.inject({ method: "POST", url: "/v1/context-signs/resolve", headers: await reader(), payload: { signType: "DE:142-10", from: farAway, to: { lat: 40.0, lng: 3.001 } } });
    expect(none.statusCode).toBe(422);
    expect(none.json().error.code).toBe("NO_ROAD_DATA");
    const off = await resolve(road, { from: { lat: road.lat + 0.0005, lng: road.west + 0.002 }, to: { lat: road.lat + 0.0005, lng: road.west + 0.004 } }); // about 55 m beside the road
    expect(off.statusCode).toBe(422);
    expect(off.json().error.code).toBe("NO_ROAD_FOUND");
    const wrongZone = await resolve(road, { validity: { tz: "America/New_York" } });
    expect(wrongZone.statusCode).toBe(422);
    expect(wrongZone.json().error.code).toBe("INVALID_TIMEZONE");
  });

  it("a warning is proposed, confirmed by a second device, delivered by area and by tile, and moves the version", async () => {
    const road = await seedRoad();
    const a = await createDevice();
    const b = await createDevice();
    const v0 = await versionOf();

    const first = await propose(a, road);
    expect(first.res.statusCode).toBe(201);
    const created = first.res.json() as Json;
    expect(created).toMatchObject({ recorded: true, created: true, entry: { id: first.entryKey, signType: "DE:142-10", status: "proposed", confirmed: false, confirmations: 1 } });
    expect(await versionOf()).toBeGreaterThan(v0);

    // the same device saying the same again changes nothing
    const again = await propose(a, road);
    expect(again.res.statusCode).toBe(200);
    expect(again.res.json()).toMatchObject({ recorded: false, noop: "already_holds_stance" });

    // listed as unconfirmed, and not at all when only confirmed ones are asked for
    expect((await list(road)).entries).toHaveLength(1);
    const confirmedOnly = await app.inject({ method: "GET", url: `/v1/context-signs?lat=${road.lat}&lng=${road.west + 0.003}&radiusM=2000&confirmed=true`, headers: await reader() });
    expect(confirmedOnly.json().entries).toEqual([]);

    const v1 = await versionOf();
    const confirm = await vote(b, first.entryKey, first.descriptor, "confirm");
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().entry).toMatchObject({ status: "confirmed", confirmed: true, confirmations: 2 });
    expect(await versionOf()).toBeGreaterThan(v1);

    const entry = (await list(road)).entries[0] as Json;
    expect(entry).toMatchObject({ id: first.entryKey, confirmed: true, direction: "both", validity: { tz: "Europe/Berlin" }, value: null });
    expect(entry.geometry.length).toBeGreaterThanOrEqual(2);

    const tile = latLngToCell(road.lat, road.west + 0.003, env.STATIC_DATA_PARTITION_H3_RESOLUTION);
    const tiles = (await app.inject({ method: "GET", url: `/v1/context-signs/tiles?tiles=${tile}`, headers: await reader() })).json() as Json;
    expect(tiles.tiles[0].entries.map((e: Json) => e.id)).toContain(first.entryKey);
    // while the version is the one the client holds, the answer is a few bytes
    const unchanged = await app.inject({ method: "GET", url: `/v1/context-signs/tiles?tiles=${tile}&since=${tiles.version}`, headers: await reader() });
    expect(unchanged.json()).toEqual({ version: tiles.version, unchanged: true, tiles: [] });
  });

  it("a prohibition needs three devices; objections make an entry disputed and take it out of the answers", async () => {
    const road = await seedRoad();
    const [a, b, c, d] = [await createDevice(), await createDevice(), await createDevice(), await createDevice()];
    const p = await propose(a, road, { signType: "DE:276", direction: "along" });
    expect(p.res.statusCode).toBe(201);
    expect((await vote(b, p.entryKey, p.descriptor, "confirm")).json().entry.status).toBe("proposed");
    expect((await vote(c, p.entryKey, p.descriptor, "confirm")).json().entry.status).toBe("confirmed");

    // two objections do not undo three confirmations ...
    await vote(d, p.entryKey, p.descriptor, "deny");
    expect((await list(road)).entries[0].status).toBe("confirmed");

    // ... but on a fresh proposal, two objections against one supporter do
    const road2 = await seedRoad();
    const q = await propose(a, road2, { signType: "DE:276", direction: "along" });
    await vote(b, q.entryKey, q.descriptor, "deny");
    const disputed = await vote(c, q.entryKey, q.descriptor, "deny");
    expect(disputed.json().entry.status).toBe("disputed");
    expect((await list(road2)).entries).toEqual([]);
    // a supporter changing their mind later is counted once
    const one = await app.inject({ method: "GET", url: `/v1/context-signs/${q.entryKey}`, headers: await reader() });
    expect(one.json().entry).toMatchObject({ confirmations: 1, denials: 2 });
  });

  it("web visitors count together as one voice and can never confirm alone", async () => {
    const road = await seedRoad();
    const w1 = await webCaller();
    const resolved = (await resolve(road, {}, app, w1.headers)).json() as Json;
    const post = (caller: { headers: { authorization: string } }) =>
      app.inject({ method: "POST", url: "/v1/context-signs", headers: caller.headers, payload: { descriptor: resolved.descriptor } });
    expect((await post(w1)).statusCode).toBe(201);
    for (let i = 0; i < 3; i++) expect((await post(await webCaller())).statusCode).toBe(200);
    const alone = (await list(road)).entries[0] as Json;
    expect(alone).toMatchObject({ status: "proposed", confirmations: 1 });
    // one device on top makes two voices
    const dev = await createDevice();
    const confirmed = await app.inject({ method: "POST", url: `/v1/context-signs/${resolved.entryKey}/confirmations`, headers: dev.headers, payload: { kind: "confirm" } });
    expect(confirmed.json().entry).toMatchObject({ status: "confirmed", confirmations: 2 });
    // the web cannot sign
    const signed = await app.inject({
      method: "POST",
      url: "/v1/context-signs",
      headers: (await webCaller()).headers,
      payload: { descriptor: resolved.descriptor, deviceAssertion: sign(dev, { vote: "support", entryKey: resolved.entryKey, entry: resolved.descriptor }) },
    });
    expect(signed.statusCode).toBe(403);
    expect(signed.json().error.code).toBe("WEB_NO_DEVICE_SIGNATURE");
  });

  it("refuses a proposal that is not on a road this node knows, and a signature that is not the caller's", async () => {
    const road = await seedRoad();
    const a = await createDevice();
    const resolved = (await resolve(road, {})).json() as Json;
    const moved = { ...resolved.descriptor, geometry: resolved.descriptor.geometry.map(([lng, lat]: number[]) => [lng, (lat ?? 0) + 0.0003]) };
    const off = await app.inject({ method: "POST", url: "/v1/context-signs", headers: a.headers, payload: { descriptor: moved } });
    expect(off.statusCode).toBe(422);
    expect(off.json().error.code).toBe("SHAPE_OFF_ROAD");
    const nowhere = { ...resolved.descriptor, geometry: [[3.0, 40.0], [3.001, 40.0]] };
    expect((await app.inject({ method: "POST", url: "/v1/context-signs", headers: a.headers, payload: { descriptor: nowhere } })).json().error.code).toBe("NO_ROAD_DATA");
    // too long for the sign
    const tooLong = { ...resolved.descriptor, signType: "DE:280" };
    expect((await app.inject({ method: "POST", url: "/v1/context-signs", headers: a.headers, payload: { descriptor: tooLong } })).json().error.code).toBe("STRETCH_TOO_LONG");

    // a device key that is not the one bound to the calling client
    const stranger = await createDevice(env, false);
    const assertion = sign(stranger, { vote: "support", entryKey: resolved.entryKey, entry: resolved.descriptor });
    const wrong = await app.inject({ method: "POST", url: "/v1/context-signs", headers: a.headers, payload: { descriptor: resolved.descriptor, deviceAssertion: assertion } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe("DEVICE_KEY_NOT_BOUND");
    // a signature over another sign
    const other = (await resolve(road, { signType: "DE:101-15" })).json() as Json;
    const mismatched = sign(a, { vote: "support", entryKey: other.entryKey, entry: other.descriptor });
    const bad = await app.inject({ method: "POST", url: "/v1/context-signs", headers: a.headers, payload: { descriptor: resolved.descriptor, deviceAssertion: mismatched } });
    expect(bad.statusCode).toBe(400);
  });

  it("finds similar entries so that a second proposal becomes a vote for the first", async () => {
    const road = await seedRoad();
    const a = await createDevice();
    const first = await propose(a, road, { from: at(road, 0.2), to: at(road, 0.5), direction: "both" });
    expect(first.res.statusCode).toBe(201);
    const near = (await resolve(road, { from: at(road, 0.21), to: at(road, 0.49), direction: "both" })).json() as Json;
    expect(near.entryKey).not.toBe(first.entryKey);
    expect(near.similar).toHaveLength(1);
    expect(near.similar[0]).toMatchObject({ sameDirection: true, entry: { id: first.entryKey } });
    expect(near.similar[0].overlapOfNew).toBeGreaterThan(0.8);
    expect(near.existing).toBeNull();
    const same = (await resolve(road, { from: at(road, 0.2), to: at(road, 0.5), direction: "both" })).json() as Json;
    expect(same.existing).toMatchObject({ id: first.entryKey });
  });

  it("an entry with a time window and a value is stored and delivered as signed", async () => {
    const road = await seedRoad();
    const a = await createDevice();
    const validity = { windows: [{ days: [1, 2, 3, 4, 5], from: "22:00", to: "06:00" }], period: { from: "2026-10-01", to: "2026-11-30" } };
    const p = await propose(a, road, { signType: "DE:265-3", validity, value: 3.8, unit: "m", direction: "along" });
    expect(p.res.statusCode).toBe(201);
    const entry = (await list(road)).entries[0] as Json;
    expect(entry).toMatchObject({ signType: "DE:265-3", value: 3.8, unit: "m", direction: "along" });
    expect(entry.validity).toEqual({ v: 1, tz: "Europe/Berlin", windows: validity.windows, period: validity.period });
    const missing = await resolve(road, { signType: "DE:265-3", direction: "along" });
    expect(missing.json().error.code).toBe("VALUE_REQUIRED");
  });

  it("limits what one client can do per day, and the unconfirmed entries in one area", async () => {
    const { app: tight, env: tightEnv } = await build({ CONTEXT_SIGNS_PROPOSALS_PER_DAY: "2", CONTEXT_SIGNS_VOTES_PER_DAY: "3", CONTEXT_SIGNS_MAX_UNCONFIRMED_PER_CELL: "100" });
    const road = await seedRoad(tight, tightEnv);
    const a = await createDevice(tightEnv);
    const spots = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];
    const results = [];
    for (const [from, to] of spots) results.push((await propose(a, road, { from: at(road, from!), to: at(road, to!) }, tight)).res.statusCode);
    expect(results).toEqual([201, 201, 429]);
    // total votes: two proposals so far; a third vote is the last allowed one, the fourth is not
    const b = await createDevice(tightEnv);
    const first = await propose(b, road, { from: at(road, 0.1), to: at(road, 0.2) }, tight);
    expect(first.res.statusCode).toBe(200); // a vote for the entry the first device made
    expect((await propose(b, road, { from: at(road, 0.3), to: at(road, 0.4) }, tight)).res.statusCode).toBe(200);
    expect((await propose(b, road, { from: at(road, 0.5), to: at(road, 0.6) }, tight)).res.statusCode).toBe(201); // nobody had made this one
    const over = await propose(b, road, { from: at(road, 0.7), to: at(road, 0.8) }, tight);
    expect(over.res.statusCode).toBe(429);

    const { app: crowded, env: crowdedEnv } = await build({ CONTEXT_SIGNS_MAX_UNCONFIRMED_PER_CELL: "2" });
    const road2 = await seedRoad(crowded, crowdedEnv);
    const c = await createDevice(crowdedEnv);
    const codes = [];
    for (const [from, to] of spots) codes.push((await propose(c, road2, { from: at(road2, from!), to: at(road2, to!) }, crowded)).res.statusCode);
    expect(codes).toEqual([201, 201, 429]);
  });

  it("an operator can remove an entry, restore it, and block a device whose votes then stop counting", async () => {
    const road = await seedRoad();
    const [a, b] = [await createDevice(), await createDevice()];
    const p = await propose(a, road);
    await vote(b, p.entryKey, p.descriptor, "confirm");
    expect((await list(road)).entries[0].status).toBe("confirmed");

    const v0 = await versionOf();
    await removeEntry(testDb.db, env, p.entryKey, "wrong sign");
    expect((await list(road)).entries).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/v1/context-signs/${p.entryKey}`, headers: await reader() })).statusCode).toBe(404);
    expect(await versionOf()).toBeGreaterThan(v0);
    expect((await restoreEntry(testDb.db, env, p.entryKey))?.status).toBe("confirmed");
    expect((await list(road)).entries).toHaveLength(1);

    const banned = await banReporter(testDb.db, env, b.reporterId, "spam");
    expect(banned).toMatchObject({ newlyBanned: true, recomputed: 1 });
    expect((await list(road)).entries[0]).toMatchObject({ status: "proposed", confirmations: 1 });
    const refused = await vote(b, p.entryKey, p.descriptor, "deny");
    expect(refused.statusCode).toBe(403);
    await unbanReporter(testDb.db, env, b.reporterId);
    expect((await list(road)).entries[0].status).toBe("confirmed");
  });

  it("entries past their end are no longer delivered, and the version says so", async () => {
    const road = await seedRoad();
    const [a, b] = [await createDevice(), await createDevice()];
    const p = await propose(a, road);
    await vote(b, p.entryKey, p.descriptor, "confirm");
    // an unconfirmed one for good measure
    const lonely = await propose(a, road, { from: at(road, 0.6), to: at(road, 0.7) });
    await testDb.db.execute(sql`update context_sign_entries set expires_at = now() - interval '1 minute' where entry_key in (${p.entryKey}, ${lonely.entryKey})`);
    // not delivered even before the housekeeping has run
    expect((await list(road)).entries).toEqual([]);
    const v0 = await versionOf();
    expect(await expireEntries(testDb.db)).toBe(2);
    expect(await versionOf()).toBeGreaterThan(v0);
    expect(await expireEntries(testDb.db)).toBe(0);
    // a fresh vote on a lapsed unconfirmed entry brings it back
    const back = await vote(b, lonely.entryKey, lonely.descriptor, "confirm");
    expect(back.statusCode).toBe(200);
  });

  describe("federation: signed votes between nodes", () => {
    it("takes a signed vote as it is, once, and refuses a tampered or inconsistent one", async () => {
      const road = await seedRoad();
      const device = await createDevice();
      const resolved = (await resolve(road, {})).json() as Json;
      const envelope = sign(device, { vote: "support", entryKey: resolved.entryKey, entry: resolved.descriptor });

      const first = await ingestContextSignVote(testDb.db, env, envelope, "node-b");
      expect(first.status).toBe("recorded");
      expect((await ingestContextSignVote(testDb.db, env, envelope, "node-b")).status).toBe("duplicate");
      expect((await list(road)).entries[0]).toMatchObject({ id: resolved.entryKey, confirmations: 1 });

      const tampered = { ...envelope, payload: { ...envelope.payload, entryKey: "0".repeat(32) } };
      expect(await ingestContextSignVote(testDb.db, env, tampered, "node-b")).toMatchObject({ status: "rejected", code: "invalid_signature" });

      const other = await createDevice();
      const wrongKey = sign(other, { vote: "support", entryKey: "1".repeat(32), entry: resolved.descriptor });
      expect(await ingestContextSignVote(testDb.db, env, wrongKey, "node-b")).toMatchObject({ status: "rejected", code: "implausible" });

      const noEntry = sign(other, { vote: "support", entryKey: resolved.entryKey });
      expect(await ingestContextSignVote(testDb.db, env, noEntry, "node-b")).toMatchObject({ status: "rejected", code: "implausible" });

      const future = sign(other, { vote: "support", entryKey: resolved.entryKey, entry: resolved.descriptor, timestamp: new Date(Date.now() + 3_600_000).toISOString() });
      expect(await ingestContextSignVote(testDb.db, env, future, "node-b")).toMatchObject({ status: "rejected", code: "future_timestamp" });

      const unknownSign = sign(other, { vote: "support", entryKey: resolved.entryKey, entry: { ...resolved.descriptor, signType: "DE:999" } });
      expect(await ingestContextSignVote(testDb.db, env, unknownSign, "node-b")).toMatchObject({ status: "rejected", code: "implausible" });
    });

    it("converges whatever the arrival order: an objection that arrives before the proposal still counts", async () => {
      const road = await seedRoad();
      const [a, b, c] = [await createDevice(), await createDevice(), await createDevice()];
      const resolved = (await resolve(road, { signType: "DE:101-15" })).json() as Json;
      const deny1 = sign(b, { vote: "deny", entryKey: resolved.entryKey });
      const deny2 = sign(c, { vote: "deny", entryKey: resolved.entryKey });
      const support = sign(a, { vote: "support", entryKey: resolved.entryKey, entry: resolved.descriptor });
      expect((await ingestContextSignVote(testDb.db, env, deny1, "node-b")).status).toBe("recorded");
      expect((await ingestContextSignVote(testDb.db, env, deny2, "node-b")).status).toBe("recorded");
      expect((await list(road)).entries).toEqual([]); // no entry yet: nobody has said what the sign is
      expect((await ingestContextSignVote(testDb.db, env, support, "node-b")).status).toBe("recorded");
      const one = await app.inject({ method: "GET", url: `/v1/context-signs/${resolved.entryKey}`, headers: await reader() });
      expect(one.json().entry).toMatchObject({ status: "disputed", confirmations: 1, denials: 2 });
    });

    it("offers the signed votes it holds as a stream with a cursor, unsigned ones never", async () => {
      const road = await seedRoad();
      const device = await createDevice();
      const web = await webCaller();
      const p = await propose(device, road);
      const resolved = (await resolve(road, { from: at(road, 0.6), to: at(road, 0.7) }, app, web.headers)).json() as Json;
      await app.inject({ method: "POST", url: "/v1/context-signs", headers: web.headers, payload: { descriptor: resolved.descriptor } });
      const page = await getSignedVotesSince(testDb.db, 0, 1000);
      const mine = page.votes.filter((v) => (v.envelope as Json).payload.entryKey === p.entryKey);
      expect(mine).toHaveLength(1);
      expect(page.votes.some((v) => (v.envelope as Json).payload.entryKey === resolved.entryKey)).toBe(false);
      const next = await getSignedVotesSince(testDb.db, page.nextAfter ?? 0, 1000);
      expect(next.votes).toEqual([]);
    });
  });

  it("is absent when switched off: no endpoints, and the configuration says so", async () => {
    const { app: off, env: offEnv } = await build({ CONTEXT_SIGNS_ENABLED: "false" });
    const res = await off.inject({ method: "GET", url: "/v1/context-signs?lat=50&lng=9&radiusM=1000", headers: await reader(offEnv) });
    expect(res.statusCode).toBe(404);
    const config = await off.inject({ method: "GET", url: "/v1/config", headers: await reader(offEnv) });
    expect(config.json().contextSigns).toMatchObject({ enabled: false });
  });
});
