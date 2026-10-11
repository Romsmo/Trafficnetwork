import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { authHeader, testToken } from "./auth-helper.js";
import { generateEd25519KeyPair, keyId } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import type { JoinRequestPayload } from "../../src/modules/federation/protocol.js";
import type { DeviceCreateEventPayload } from "../../src/modules/federation/device-event.js";
import type { NetworkConfigPayload } from "../../src/modules/network/config.js";
import { runRetentionCleanup } from "../../src/modules/expiry/retention.js";
import { positionToRegionTile } from "../../src/lib/h3.js";

const HOUR = 3600;
const DAY = 24 * HOUR;
const SLACK_MS = 5_000;

interface Row extends Record<string, unknown> {
  id: string;
  type: string;
  status: string;
  expires_at: string;
  confirm_count: number;
  deny_count: number;
}

/**
 * Block 1 of the October work order: how long a report lives, what a reporter may ask for, how a signed report gets the
 * same end on every node, and how "gone" votes end a temporary camera early. Server/docs/report-expiry.md.
 */
describe("report expiry and requested duration", () => {
  let testDb: TestDatabase;
  let app: FastifyInstance;
  let reporter: string;
  let other: (n: number) => Promise<Record<string, string>>;
  let dir: string;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    dir = mkdtempSync(path.join(tmpdir(), "report-expiry-"));
    resetEnvCache();
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      JWT_SECRET: "a".repeat(32),
      FEDERATION_ENABLED: "true",
      FEDERATION_PUBLIC_ADDRESS: "https://node-under-test.example",
      // plenty of room: this file posts many reports from few clients
      REPORT_RATE_LIMIT_MAX: "1000",
    });
    app = await buildApp({ env, db: testDb.db });
    reporter = await testToken(env, { sub: "reporter-a" });
    other = async (n) => authHeader(await testToken(env, { sub: `reporter-${n}` }));
  });

  afterEach(async () => {
    await testDb.db.execute(sql`truncate table hazard_confirmations, hazard_reports, event_log, network_peers restart identity cascade`);
  });

  afterAll(async () => {
    await app.close();
    await testDb.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  const auth = () => authHeader(reporter);

  async function post(body: Record<string, unknown>, headers: Record<string, string> = auth()) {
    return app.inject({ method: "POST", url: "/v1/hazard-reports", headers, payload: { lat: 52.5, lng: 13.4, ...body } });
  }

  async function rows(): Promise<Row[]> {
    return testDb.db.execute<Row>(sql`select id, type, status, expires_at, confirm_count, deny_count from hazard_reports order by created_at`);
  }

  /** `expires_at` of the only row, as ms since epoch. */
  async function onlyExpiresAt(): Promise<number> {
    const r = await rows();
    expect(r).toHaveLength(1);
    return Date.parse(r[0]!.expires_at);
  }

  describe("defaults", () => {
    it("a mobile speed camera lives 3 hours, a trailer 14 days (not the 12 minutes both had)", async () => {
      expect((await post({ type: "mobileSpeedCamera" })).statusCode).toBeLessThan(300);
      const mobile = await onlyExpiresAt();
      expect(Math.abs(mobile - (Date.now() + 3 * HOUR * 1000))).toBeLessThan(SLACK_MS);

      await testDb.db.execute(sql`truncate table hazard_confirmations, hazard_reports, event_log restart identity cascade`);
      expect((await post({ type: "trailerCamera" })).statusCode).toBeLessThan(300);
      const trailer = await onlyExpiresAt();
      expect(Math.abs(trailer - (Date.now() + 14 * DAY * 1000))).toBeLessThan(SLACK_MS);
    });

    it("every other type keeps its default", async () => {
      const res = await post({ type: "traffic" });
      expect(res.statusCode).toBe(201);
      expect(Math.abs(Date.parse(res.json().report.expiresAt) - (Date.now() + 25 * 60 * 1000))).toBeLessThan(SLACK_MS);
    });

    it("GET /v1/config publishes default and bounds per type, and the old map still carries the defaults", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/config", headers: auth() });
      const cfg = res.json();
      expect(cfg.reportExpiry.mobileSpeedCamera).toEqual({ defaultSeconds: 3 * HOUR, minSeconds: 600, maxSeconds: 12 * HOUR });
      expect(cfg.reportExpiry.trailerCamera).toEqual({ defaultSeconds: 14 * DAY, minSeconds: HOUR, maxSeconds: 30 * DAY });
      expect(cfg.reportExpiry.fixedSpeedCamera).toBeUndefined();
      expect(cfg.hazardExpiryMsByType.mobileSpeedCamera).toBe(3 * HOUR * 1000);
      expect(cfg.hazardExpiryMsByType.trailerCamera).toBe(14 * DAY * 1000);
      expect(cfg.cameraReportGoneThreshold).toBe(2);
    });
  });

  describe("expiresInSeconds", () => {
    it("is honoured inside the bounds and the answer says when the report ends", async () => {
      const res = await post({ type: "traffic", expiresInSeconds: 2 * HOUR });
      expect(res.statusCode).toBe(201);
      const expiresAt = Date.parse(res.json().report.expiresAt);
      expect(Math.abs(expiresAt - (Date.now() + 2 * HOUR * 1000))).toBeLessThan(SLACK_MS);
    });

    it("accepts both bounds exactly", async () => {
      expect((await post({ type: "traffic", lat: 10, lng: 10, expiresInSeconds: 300 })).statusCode).toBe(201);
      expect((await post({ type: "traffic", lat: 20, lng: 20, expiresInSeconds: 6 * HOUR })).statusCode).toBe(201);
    });

    it("is refused outside the bounds with 400 EXPIRY_OUT_OF_RANGE, naming the bounds — never clamped", async () => {
      for (const expiresInSeconds of [60, 6 * HOUR + 1, 0, -5, 90.5]) {
        const res = await post({ type: "traffic", expiresInSeconds });
        expect(res.statusCode, String(expiresInSeconds)).toBe(400);
        const err = res.json().error;
        expect(err.code).toBe("EXPIRY_OUT_OF_RANGE");
        expect(err.details).toMatchObject({ type: "traffic", defaultSeconds: 1500, minSeconds: 300, maxSeconds: 6 * HOUR });
      }
      expect(await rows()).toHaveLength(0);
    });

    it("a refused request leaves nothing behind, and the same request without the field works", async () => {
      await post({ type: "traffic", expiresInSeconds: 1 });
      expect(await rows()).toHaveLength(0);
      const ok = await post({ type: "traffic" });
      expect(ok.statusCode).toBe(201);
    });

    it("is not applicable to a fixed speed camera, which never expires", async () => {
      const res = await post({ type: "fixedSpeedCamera", expiresInSeconds: HOUR });
      expect(res.statusCode).toBe(400);
    });

    it("an older client that sends no field gets the default, exactly as before", async () => {
      const res = await post({ type: "ice" });
      expect(res.statusCode).toBe(201);
      expect(Math.abs(Date.parse(res.json().report.expiresAt) - (Date.now() + 25 * 60 * 1000))).toBeLessThan(SLACK_MS);
    });
  });

  describe("confirmations and merges", () => {
    it("\"still there\" never shortens a report that was made to live longer", async () => {
      const created = await post({ type: "traffic", expiresInSeconds: 5 * HOUR });
      const id = created.json().report.id;
      const before = Date.parse(created.json().report.expiresAt);

      const res = await app.inject({
        method: "POST",
        url: `/v1/hazard-reports/${id}/confirmations`,
        headers: await other(2),
        payload: { kind: "stillThere" },
      });
      expect(res.statusCode).toBe(200);
      expect(Date.parse(res.json().report.expiresAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(res.json().report.expiresAt)).toBeLessThan(before + SLACK_MS);
    });

    it("renews a nearly-ended report to now plus the default", async () => {
      const created = await post({ type: "traffic", expiresInSeconds: 300 });
      const id = created.json().report.id;
      const res = await app.inject({
        method: "POST",
        url: `/v1/hazard-reports/${id}/confirmations`,
        headers: await other(3),
        payload: { kind: "stillThere" },
      });
      expect(Math.abs(Date.parse(res.json().report.expiresAt) - (Date.now() + 25 * 60 * 1000))).toBeLessThan(SLACK_MS);
    });

    it("a nearby second report extends to the later end, never to a shorter one, and stays within the type's maximum", async () => {
      const first = await post({ type: "traffic", expiresInSeconds: 3 * HOUR });
      expect(first.json().merged).toBe(false);
      const second = await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: await other(4),
        payload: { type: "traffic", lat: 52.5001, lng: 13.4001, expiresInSeconds: 600 },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().merged).toBe(true);
      const ends = Date.parse(second.json().report.expiresAt);
      expect(ends).toBeGreaterThanOrEqual(Date.parse(first.json().report.expiresAt));

      const third = await app.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers: await other(5),
        payload: { type: "traffic", lat: 52.5001, lng: 13.4001, expiresInSeconds: 6 * HOUR },
      });
      expect(Date.parse(third.json().report.expiresAt)).toBeLessThanOrEqual(Date.now() + 6 * HOUR * 1000 + SLACK_MS);
    });
  });

  describe("a report that outlives the event-log retention", () => {
    it("stays in the snapshot after its creation event has been purged (a client offline for days re-bootstraps and sees it)", async () => {
      // Retention of dynamic events is 3 days; a roadwork report lives 7 days and a trailer 14. The snapshot, not the log, carries them.
      expect((await post({ type: "construction" })).statusCode).toBe(201);
      const id = (await rows())[0]!.id;
      expect((await post({ type: "traffic", lat: 10, lng: 10 })).statusCode).toBe(201); // a second event, so the purge leaves a gap
      await testDb.db.execute(sql`update event_log set occurred_at = now() - interval '5 days'`);
      const cleanup = await runRetentionCleanup(testDb.db, app.deps.env);
      expect(cleanup.dynamicEventsDeleted).toBeGreaterThan(0);
      const left = await testDb.db.execute(sql`select 1 from event_log where entity_id = ${id}`);
      expect(left).toHaveLength(0);

      const tile = positionToRegionTile(52.5, 13.4, { REGION_TILE_H3_RESOLUTION: 7 });
      const snapshot = await app.inject({ method: "GET", url: `/v1/snapshot?tiles=${tile}`, headers: auth() });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json().hazardReports.map((r: { id: string }) => r.id)).toContain(id);

      // A client whose cursor predates the purge is told to take the snapshot - which is where the report is.
      expect((await post({ type: "traffic", lat: 20, lng: 20 })).statusCode).toBe(201);
      const stale = await app.inject({ method: "GET", url: "/v1/delta?since=1", headers: auth() });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe("SNAPSHOT_REQUIRED");
    });
  });

  describe("\"gone\" ends a temporary camera early", () => {
    async function vote(id: string, n: number, kind: "stillThere" | "gone") {
      return app.inject({
        method: "POST",
        url: `/v1/hazard-reports/${id}/confirmations`,
        headers: await other(n),
        payload: { kind },
      });
    }

    it("two distinct devices end a mobile speed camera; one does not; the event is the usual ReportExpired", async () => {
      await post({ type: "mobileSpeedCamera" });
      const id = (await rows())[0]!.id;

      expect((await vote(id, 10, "gone")).statusCode).toBe(200);
      expect((await rows())[0]!.status).toBe("active");

      expect((await vote(id, 11, "gone")).statusCode).toBe(200);
      expect((await rows())[0]!.status).toBe("expired");

      const events = await testDb.db.execute<{ type: string } & Record<string, unknown>>(
        sql`select type from event_log where entity_id = ${id} order by sequence`,
      );
      expect(events.map((e) => e.type)).toEqual(["ReportCreated", "ReportDenied", "ReportDenied", "ReportExpired"]);
    });

    it("the same device voting twice counts once", async () => {
      await post({ type: "trailerCamera" });
      const id = (await rows())[0]!.id;
      await vote(id, 12, "gone");
      const again = await vote(id, 12, "gone");
      expect(again.json().recorded).toBe(false);
      expect((await rows())[0]!.status).toBe("active");
    });

    it("needs the denials to at least match the people who said it is there, the reporter included", async () => {
      await post({ type: "mobileSpeedCamera" }); // the reporter + the two below = 3 people say it is there
      const id = (await rows())[0]!.id;
      await vote(id, 20, "stillThere");
      await vote(id, 21, "stillThere");
      await vote(id, 22, "gone");
      await vote(id, 23, "gone"); // 2 denials < 3
      expect((await rows())[0]!.status).toBe("active");
      await vote(id, 24, "gone"); // 3 denials >= 3
      expect((await rows())[0]!.status).toBe("expired");
    });

    it("other types are not ended by votes (unchanged)", async () => {
      await post({ type: "traffic" });
      const id = (await rows())[0]!.id;
      for (const n of [30, 31, 32, 33]) await vote(id, n, "gone");
      const r = (await rows())[0]!;
      expect(r.status).toBe("active");
      expect(r.deny_count).toBe(4);
    });
  });

  describe("signed reports: the same end on every node", () => {
    async function joinAsPeer(): Promise<string> {
      const peer = generateEd25519KeyPair();
      const nodeId = keyId(peer.publicKeyRaw);
      const payload: JoinRequestPayload = { nodeId, publicKey: peer.publicKeyRaw, address: "https://peer.example", requestedAt: new Date().toISOString() };
      const res = await app.inject({ method: "POST", url: "/v1/federation/join", payload: signEnvelope(payload, peer) });
      expect(res.statusCode).toBe(200);
      return nodeId;
    }

    function envelope(overrides: Partial<DeviceCreateEventPayload>) {
      const device = generateEd25519KeyPair();
      const payload: DeviceCreateEventPayload = {
        kind: "create",
        type: "traffic",
        lat: 48.1,
        lng: 11.5,
        devicePublicKey: device.publicKeyRaw,
        timestamp: new Date().toISOString(),
        ...overrides,
      };
      return signEnvelope(payload, device);
    }

    async function push(nodeId: string, ...events: ReturnType<typeof envelope>[]) {
      const res = await app.inject({ method: "POST", url: "/v1/federation/events", payload: { senderNodeId: nodeId, events } });
      expect(res.statusCode).toBe(200);
      return res.json().results as { status: string; code?: string; reason?: string }[];
    }

    it("a report that arrives late ends at its signed timestamp + duration, not at arrival + duration", async () => {
      const nodeId = await joinAsPeer();
      const madeAt = Date.now() - 1 * HOUR * 1000;
      const [result] = await push(nodeId, envelope({ timestamp: new Date(madeAt).toISOString(), expiresInSeconds: 2 * HOUR }));
      expect(result!.status).toBe("created");
      expect(await onlyExpiresAt()).toBe(madeAt + 2 * HOUR * 1000);
    });

    it("without a duration it is the type's default from the signed timestamp", async () => {
      const nodeId = await joinAsPeer();
      const madeAt = Date.now() - 10 * 60 * 1000;
      await push(nodeId, envelope({ type: "mobileSpeedCamera", timestamp: new Date(madeAt).toISOString() }));
      expect(await onlyExpiresAt()).toBe(madeAt + 3 * HOUR * 1000);
    });

    it("a report whose own lifetime has already ended is rejected, not resurrected for a fresh default", async () => {
      const nodeId = await joinAsPeer();
      const madeAt = Date.now() - 4 * HOUR * 1000; // a mobile check lasts 3 h
      const [result] = await push(nodeId, envelope({ type: "mobileSpeedCamera", timestamp: new Date(madeAt).toISOString() }));
      expect(result!.status).toBe("rejected");
      expect(result!.code).toBe("stale_timestamp");
      expect(await rows()).toHaveLength(0);
    });

    it("a signed duration outside the bounds is rejected as implausible", async () => {
      const nodeId = await joinAsPeer();
      const [result] = await push(nodeId, envelope({ expiresInSeconds: 30 * DAY }));
      expect(result!.status).toBe("rejected");
      expect(result!.code).toBe("implausible");
    });

    it("the local capture path uses the same anchor and refuses a duration that differs from the signed one", async () => {
      const device = generateEd25519KeyPair();
      const timestamp = new Date().toISOString();
      const signed = signEnvelope(
        { kind: "create", type: "traffic", lat: 52.5, lng: 13.4, expiresInSeconds: 2 * HOUR, devicePublicKey: device.publicKeyRaw, timestamp } as DeviceCreateEventPayload,
        device,
      );
      const mismatch = await post({ type: "traffic", expiresInSeconds: HOUR, deviceAssertion: signed });
      expect(mismatch.statusCode).toBe(400);

      const ok = await post({ type: "traffic", expiresInSeconds: 2 * HOUR, deviceAssertion: signed });
      expect(ok.statusCode).toBe(201);
      expect(Date.parse(ok.json().report.expiresAt)).toBe(Date.parse(timestamp) + 2 * HOUR * 1000);
    });
  });

  describe("signed network configuration", () => {
    let configApp: FastifyInstance;

    afterEach(async () => {
      if (configApp) await configApp.close();
    });

    function writeConfig(root: ReturnType<typeof generateEd25519KeyPair>, reportExpiry: NetworkConfigPayload["reportExpiry"]): string {
      const payload: NetworkConfigPayload = {
        version: 1,
        blitzerEnabled: true,
        eventLogRetentionDaysDynamic: 3,
        eventLogRetentionDaysStatic: 30,
        minVersion: "0.1.0",
        excludedNodeIds: [],
        issuedAt: new Date().toISOString(),
        reportExpiry,
      };
      const filePath = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(filePath, JSON.stringify(signEnvelope(payload, root)));
      return filePath;
    }

    async function appWith(env: Record<string, string>, root: ReturnType<typeof generateEd25519KeyPair>, configPath: string) {
      resetEnvCache();
      const loaded = loadEnv({
        DATABASE_URL: testDb.container.getConnectionUri(),
        JWT_SECRET: "a".repeat(32),
        REPORT_RATE_LIMIT_MAX: "1000",
        NETWORK_CONFIG_PATH: configPath,
        NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw,
        ...env,
      });
      configApp = await buildApp({ env: loaded, db: testDb.db });
      return { loaded, headers: authHeader(await testToken(loaded)) };
    }

    it("replaces this node's own setting: config and new reports follow the signed value", async () => {
      const root = generateEd25519KeyPair();
      const configPath = writeConfig(root, { mobileSpeedCamera: { defaultSeconds: 2 * HOUR }, traffic: { maxSeconds: 8 * HOUR } });
      const { headers } = await appWith({ HAZARD_EXPIRY_MOBILE_SPEED_CAMERA_MINUTES: "90" }, root, configPath);

      const cfg = (await configApp.inject({ method: "GET", url: "/v1/config", headers })).json();
      expect(cfg.reportExpiry.mobileSpeedCamera.defaultSeconds).toBe(2 * HOUR);
      expect(cfg.reportExpiry.traffic.maxSeconds).toBe(8 * HOUR);
      expect(cfg.hazardExpiryMsByType.mobileSpeedCamera).toBe(2 * HOUR * 1000);

      const res = await configApp.inject({
        method: "POST",
        url: "/v1/hazard-reports",
        headers,
        payload: { type: "traffic", lat: 52.5, lng: 13.4, expiresInSeconds: 7 * HOUR },
      });
      expect(res.statusCode).toBe(201); // above the built-in 6 h, inside the signed 8 h
    });

    it("a signed reportExpiry that cannot be understood stops the node instead of being half-applied", async () => {
      const root = generateEd25519KeyPair();
      const configPath = writeConfig(root, { traffic: { minSeconds: 900, defaultSeconds: 300 } });
      resetEnvCache();
      const env = loadEnv({
        DATABASE_URL: testDb.container.getConnectionUri(),
        JWT_SECRET: "a".repeat(32),
        NETWORK_CONFIG_PATH: configPath,
        NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw,
      });
      await expect(buildApp({ env, db: testDb.db })).rejects.toThrow(/reportExpiry/);
    });
  });
});
