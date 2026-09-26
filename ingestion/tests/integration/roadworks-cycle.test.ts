import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FeedReport } from "../../src/pipeline/roadworks/run-roadworks.js";
import { startTestServer, type TestServer } from "./setup.js";

/**
 * `npm run ingest -- --roadworks` against a REAL server (real Postgres/PostGIS, real bulk-import endpoints) and two local
 * fixture feeds — one DATEX II, one Autobahn-JSON — that this file can change between passes, the way a live feed changes.
 * What is asserted is what an operator relies on: a roadwork appears, a duplicate across feeds is created once, a roadwork that
 * left a complete feed ends, and a broken / cut-off / missing feed ends nothing.
 */

const INGESTION_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const RUN = randomBytes(3).toString("hex"); // several test files may share one server (CI): feed ids stay unique to this run
const DATEX_FEED = `it-datex-${RUN}`;
const AUTOBAHN_FEED = `it-autobahn-${RUN}`;

const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY);

// ---------------------------------------------------------------- what the two fake feeds serve

interface DatexRecord {
  id: string;
  lat: number;
  lng: number;
  start?: Date;
  end?: Date;
}

/** A DATEX II v2 document shaped like the French national feed (same namespace-prefix style, linear location with a `from` point). */
function datexDocument(records: DatexRecord[], published = new Date()): string {
  const situations = records
    .map((r) => {
      const spec = r.start || r.end
        ? `<ns2:validityTimeSpecification>${r.start ? `<ns2:overallStartTime>${r.start.toISOString()}</ns2:overallStartTime>` : ""}${r.end ? `<ns2:overallEndTime>${r.end.toISOString()}</ns2:overallEndTime>` : ""}</ns2:validityTimeSpecification>`
        : "";
      return (
        `<ns2:situation id="${r.id}" version="1"><ns2:situationRecord xsi:type="ns2:MaintenanceWorks" id="${r.id}-1" version="1">` +
        `<ns2:validity><ns2:validityStatus>definedByValidityTimeSpec</ns2:validityStatus>${spec}</ns2:validity>` +
        `<ns2:groupOfLocations xsi:type="ns2:Linear"><ns2:tpegLinearLocation>` +
        `<ns2:to xsi:type="ns2:TpegNonJunctionPoint"><ns2:pointCoordinates><ns2:latitude>${r.lat + 0.01}</ns2:latitude><ns2:longitude>${r.lng}</ns2:longitude></ns2:pointCoordinates></ns2:to>` +
        `<ns2:from xsi:type="ns2:TpegNonJunctionPoint"><ns2:pointCoordinates><ns2:latitude>${r.lat}</ns2:latitude><ns2:longitude>${r.lng}</ns2:longitude></ns2:pointCoordinates></ns2:from>` +
        `</ns2:tpegLinearLocation></ns2:groupOfLocations></ns2:situationRecord></ns2:situation>`
      );
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?><d2LogicalModel xmlns:ns2="http://datex2.eu/schema/2/2_0" modelBaseVersion="2">` +
    `<ns2:payloadPublication xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ns2:SituationPublication" lang="fr">` +
    `<ns2:publicationTime>${published.toISOString()}</ns2:publicationTime>${situations}</ns2:payloadPublication></d2LogicalModel>`
  );
}

interface AutobahnRecord {
  id: string;
  lat: number;
  lng: number;
  /** The German description lines, as the real API writes them. */
  description: string[];
}

/** dd.mm.yy in German local time, as the Autobahn API writes dates. */
function german(d: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "2-digit" }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.day}.${parts.month}.${parts.year}`;
}

const activePhase = (): string[] => [`Beginn: ${german(inDays(-1))} um 06:00 Uhr`, `Ende: ${german(inDays(10))} um 18:00 Uhr`];

interface Feeds {
  datex: { status: number; body: string };
  autobahn: Record<string, AutobahnRecord[]>;
  /** Roads the API lists but whose request then fails (404). */
  autobahnBrokenRoads: string[];
}

async function startFeedServer(feeds: Feeds): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    if (url === "/datex/content.xml") {
      res.writeHead(feeds.datex.status, { "content-type": "application/xml" }).end(feeds.datex.body);
      return;
    }
    if (url === "/autobahn/") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ roads: [...Object.keys(feeds.autobahn), ...feeds.autobahnBrokenRoads] }));
      return;
    }
    const road = /^\/autobahn\/([^/]+)\/services\/roadworks$/.exec(url)?.[1];
    if (road && feeds.autobahn[decodeURIComponent(road)]) {
      const roadworks = feeds.autobahn[decodeURIComponent(road)]!.map((r) => ({ identifier: r.id, display_type: "ROADWORKS", title: r.id, coordinate: { lat: String(r.lat), long: String(r.lng) }, description: r.description }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ roadworks }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("feed server failed to bind");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))) };
}

// ---------------------------------------------------------------- driving the CLI

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", "src/cli.ts", ...args], { cwd: INGESTION_ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function accessToken(serverUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(new URL("/v1/auth/token", serverUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, clientSecret }) });
  if (!res.ok) throw new Error(`token fetch failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

// Where the fixtures put their roadworks (all within a few km, > 250 m apart unless a test wants a duplicate).
const CENTER = { lat: 48.1, lng: 11.5 };

describe("roadworks import cycle (real server, local DATEX II + Autobahn-JSON fixture feeds)", () => {
  let testServer: TestServer;
  let feedServer: { baseUrl: string; close: () => Promise<void> };
  let tmpRoot: string;
  let feedsConfigPath: string;
  let token: string;
  const feeds: Feeds = { datex: { status: 200, body: "" }, autobahn: {}, autobahnBrokenRoads: [] };
  let pass = 0;

  beforeAll(async () => {
    [testServer, feedServer] = await Promise.all([startTestServer(), startFeedServer(feeds)]);
    tmpRoot = mkdtempSync(path.join(tmpdir(), "tn-roadworks-it-"));
    feedsConfigPath = path.join(tmpRoot, "roadworks-feeds.json");
    // Same shape as the shipped catalog. The datex feed comes FIRST (= higher priority in the cross-feed duplicate check).
    writeFileSync(
      feedsConfigPath,
      JSON.stringify({
        feeds: {
          [DATEX_FEED]: { enabled: true, kind: "datex2", country: "XX", name: "fixture DATEX II", url: `${feedServer.baseUrl}/datex/content.xml`, sourceLicense: "Test License 1.0", attribution: "fixture", minIntervalMinutes: 60, ttlHours: 72 },
          [AUTOBAHN_FEED]: { enabled: false, kind: "autobahn-de-json", country: "DE", name: "fixture Autobahn API", url: `${feedServer.baseUrl}/autobahn/`, sourceLicense: "ungeklärt", attribution: "fixture", minIntervalMinutes: 60, ttlHours: 48, requestDelayMs: 0 },
        },
      }),
    );
    token = await accessToken(testServer.serverUrl, testServer.clientId, testServer.clientSecret);
  });

  afterAll(async () => {
    await feedServer?.close();
    await testServer?.teardown();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** One scheduled pass. A fresh STATE_DIR each time stands for "the next scheduled run, long after the previous one". */
  async function pollOnce(extraArgs: string[] = [], extraEnv: Record<string, string> = {}): Promise<{ cli: CliResult; stateDir: string }> {
    const stateDir = path.join(tmpRoot, `state-${++pass}`);
    const cli = await runCli(["--roadworks", ...extraArgs], {
      ...process.env,
      SERVER_URL: testServer.serverUrl,
      CLIENT_ID: testServer.clientId,
      CLIENT_SECRET: testServer.clientSecret,
      ROADWORKS_FEEDS_CONFIG_PATH: feedsConfigPath,
      ROADWORKS_FEEDS_OFF: "",
      STATE_DIR: stateDir,
      LOG_LEVEL: "info",
      HTTP_BACKOFF_BASE_MS: "10",
      HTTP_BACKOFF_MAX_MS: "50",
      HTTP_MAX_RETRIES: "1",
      ...extraEnv,
    });
    return { cli, stateDir };
  }

  const reportOf = (stateDir: string, feedId: string) => JSON.parse(readFileSync(path.join(stateDir, "roadworks", `${feedId}.report.json`), "utf8")) as FeedReport;

  interface NearbyReport {
    lat: number;
    lng: number;
    expiresAt: number;
  }

  async function activeConstruction(): Promise<NearbyReport[]> {
    const url = new URL("/v1/hazard-reports/nearby", testServer.serverUrl);
    url.searchParams.set("lat", String(CENTER.lat));
    url.searchParams.set("lng", String(CENTER.lng));
    url.searchParams.set("radiusM", "20000");
    url.searchParams.set("types", "construction");
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`nearby failed: ${res.status}`);
    const body = (await res.json()) as { reports: { position: { coordinates: [number, number] }; expiresAt: string }[] };
    return body.reports
      .map((r) => ({ lat: r.position.coordinates[1], lng: r.position.coordinates[0], expiresAt: Date.parse(r.expiresAt.replace(" ", "T").replace(/\+00$/, "Z")) }))
      .sort((a, b) => a.lat - b.lat || a.lng - b.lng);
  }

  const near = (reports: NearbyReport[], lat: number, lng: number) => reports.filter((r) => Math.abs(r.lat - lat) < 0.0002 && Math.abs(r.lng - lng) < 0.0002);

  it("--dry-run reads the feeds and sends nothing; a feed that is switched off does not even run", async () => {
    feeds.datex.body = datexDocument([{ id: "d1", ...CENTER, start: inDays(-1), end: inDays(7) }]);
    feeds.autobahn = { A1: [{ id: "a-never", lat: 48.2, lng: 11.6, description: activePhase() }] };

    const { cli } = await pollOnce(["--dry-run"]);
    expect(cli.code).toBe(0);
    expect(cli.stdout).toContain(DATEX_FEED);
    expect(cli.stdout).not.toContain(AUTOBAHN_FEED); // enabled: false in the catalog
    expect(cli.stdout).toMatch(/\[dry-run\] roadworks would be sent/);
    expect(await activeConstruction()).toEqual([]);
  });

  it("first pass: creates what is active, once — a roadwork two feeds both publish is not created twice", async () => {
    feeds.datex.body = datexDocument([
      { id: "d1", lat: 48.1, lng: 11.5, start: inDays(-1), end: inDays(7) }, // → expires at its own end
      { id: "d2", lat: 48.11, lng: 11.51 }, // no times at all → ttl, renewed while it stays in the feed
      { id: "d3", lat: 48.12, lng: 11.52, start: inDays(-2), end: inDays(3) },
      { id: "d-later", lat: 48.14, lng: 11.54, start: inDays(30), end: inDays(40) }, // not yet
      { id: "d-over", lat: 48.15, lng: 11.55, start: inDays(-20), end: inDays(-10) }, // already over
    ]);
    feeds.autobahn = {
      A1: [
        { id: "a-dup", lat: 48.1004, lng: 11.5, description: activePhase() }, // ~45 m from d1, same time → the same roadwork
        { id: "a-own", lat: 48.13, lng: 11.53, description: activePhase() },
      ],
      A2: [{ id: "a-garbled", lat: 48.16, lng: 11.56, description: ["Bitte beachten Sie die Beschilderung"] }], // no evaluable time → skipped, counted
    };

    const { cli, stateDir } = await pollOnce([], { ROADWORKS_FEEDS_ON: AUTOBAHN_FEED });
    expect(cli.code, cli.stdout + cli.stderr).toBe(0);

    const reports = await activeConstruction();
    expect(reports).toHaveLength(4); // d1, d2, d3 and a-own; a-dup was merged into d1
    expect(near(reports, 48.1, 11.5)).toHaveLength(1);
    expect(near(reports, 48.13, 11.53)).toHaveLength(1);
    expect(near(reports, 48.14, 11.54)).toHaveLength(0);
    expect(near(reports, 48.15, 11.55)).toHaveLength(0);

    // The source's end date is the row's expiry; a row without one gets the feed's ttl.
    expect(Math.abs(near(reports, 48.1, 11.5)[0]!.expiresAt - inDays(7).getTime())).toBeLessThan(5_000);
    const ttlEnd = near(reports, 48.11, 11.51)[0]!.expiresAt;
    expect(ttlEnd).toBeGreaterThan(inDays(2.9).getTime());
    expect(ttlEnd).toBeLessThan(inDays(3.1).getTime());

    const datex = reportOf(stateDir, DATEX_FEED);
    expect(datex).toMatchObject({ status: "ok", fetched: 5, sent: 3, retired: 0 });
    expect(datex.notImported).toEqual({ "starts later": 1, "already ended": 1 });
    const autobahn = reportOf(stateDir, AUTOBAHN_FEED);
    expect(autobahn).toMatchObject({ status: "ok", fetched: 3, sent: 1, mergedIntoOtherFeed: 1 });
    expect(autobahn.notImported).toEqual({ "no evaluable validity in the description text": 1 });
  });

  it("second pass with the same feeds creates nothing new; a roadwork without an end date has its expiry renewed (dead-man's switch), the others keep theirs", async () => {
    const before = await activeConstruction();
    const { cli, stateDir } = await pollOnce([], { ROADWORKS_FEEDS_ON: AUTOBAHN_FEED });
    expect(cli.code, cli.stdout + cli.stderr).toBe(0);

    const after = await activeConstruction();
    expect(after.map((r) => [r.lat, r.lng])).toEqual(before.map((r) => [r.lat, r.lng]));
    for (const [i, r] of after.entries()) {
      if (r.lat === 48.11) expect(r.expiresAt).toBeGreaterThan(before[i]!.expiresAt); // the ttl row: renewed by being seen again
      else expect(r.expiresAt).toBe(before[i]!.expiresAt);
    }
    expect(reportOf(stateDir, DATEX_FEED).server).toMatchObject({ created: 0, reactivated: 0 });
    expect(reportOf(stateDir, DATEX_FEED).retired).toBe(0);
  });

  it("a cut-off download ends nothing, even though most of the document is missing", async () => {
    const before = await activeConstruction();
    feeds.datex.body = datexDocument([{ id: "d1", lat: 48.1, lng: 11.5, start: inDays(-1), end: inDays(7) }, { id: "d3", lat: 48.12, lng: 11.52, start: inDays(-2), end: inDays(3) }]).slice(0, 700);

    const { cli, stateDir } = await pollOnce(["--feed", DATEX_FEED]);
    expect(cli.code, cli.stdout + cli.stderr).toBe(0);
    expect(reportOf(stateDir, DATEX_FEED)).toMatchObject({ status: "incomplete" });
    expect(reportOf(stateDir, DATEX_FEED).retireSkippedBecause).toMatch(/did not parse to its end/);
    expect(await activeConstruction()).toEqual(before);
  });

  it("a feed that is down (404) ends nothing and the run says so with a non-zero exit code", async () => {
    const before = await activeConstruction();
    feeds.datex.status = 404;
    const { cli } = await pollOnce(["--feed", DATEX_FEED]);
    feeds.datex.status = 200;
    expect(cli.code).toBe(1);
    expect(cli.stdout).toMatch(/could not be read/);
    expect(await activeConstruction()).toEqual(before);
  });

  it("an Autobahn pass in which one road request fails ends nothing for that feed", async () => {
    const before = await activeConstruction();
    feeds.autobahn = { A1: [{ id: "a-own", lat: 48.13, lng: 11.53, description: activePhase() }] };
    feeds.autobahnBrokenRoads = ["A9"];

    const { cli, stateDir } = await pollOnce(["--feed", AUTOBAHN_FEED], { ROADWORKS_FEEDS_ON: AUTOBAHN_FEED });
    feeds.autobahnBrokenRoads = [];
    expect(cli.code, cli.stdout + cli.stderr).toBe(0);
    expect(reportOf(stateDir, AUTOBAHN_FEED)).toMatchObject({ status: "incomplete" });
    expect(reportOf(stateDir, AUTOBAHN_FEED).retireSkippedBecause).toMatch(/1 of 2 road requests failed/);
    expect(await activeConstruction()).toEqual(before);
  });

  it("a roadwork that is gone from a COMPLETE feed ends on the server, and the others stay", async () => {
    feeds.datex.body = datexDocument([
      { id: "d1", lat: 48.1, lng: 11.5, start: inDays(-1), end: inDays(7) },
      { id: "d2", lat: 48.11, lng: 11.51 },
      // d3 is gone
    ]);
    feeds.autobahn = { A1: [{ id: "a-own", lat: 48.13, lng: 11.53, description: activePhase() }] };

    const { cli, stateDir } = await pollOnce([], { ROADWORKS_FEEDS_ON: AUTOBAHN_FEED });
    expect(cli.code, cli.stdout + cli.stderr).toBe(0);
    expect(reportOf(stateDir, DATEX_FEED)).toMatchObject({ status: "ok", retired: 1 });
    expect(reportOf(stateDir, AUTOBAHN_FEED)).toMatchObject({ status: "ok", retired: 0 });

    const reports = await activeConstruction();
    expect(reports).toHaveLength(3);
    expect(near(reports, 48.12, 11.52)).toHaveLength(0); // d3 ended
    expect(near(reports, 48.1, 11.5)).toHaveLength(1);
    expect(near(reports, 48.11, 11.51)).toHaveLength(1);
    expect(near(reports, 48.13, 11.53)).toHaveLength(1);
  });

  it("ROADWORKS_ENABLED=false is a kill switch: the run does nothing", async () => {
    const before = await activeConstruction();
    feeds.datex.body = datexDocument([{ id: "d-new", lat: 48.17, lng: 11.57, start: inDays(-1), end: inDays(5) }]);
    const { cli } = await pollOnce([], { ROADWORKS_ENABLED: "false" });
    expect(cli.code).toBe(0);
    expect(cli.stdout).toMatch(/kill switch/);
    expect(await activeConstruction()).toEqual(before);
  });
});
