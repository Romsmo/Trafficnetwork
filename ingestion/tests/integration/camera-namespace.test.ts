import pino from "pino";
import { latLngToCell } from "h3-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "../../src/api/client.js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { startTestServer, type RunningServer, type TestServer } from "./setup.js";

/**
 * Speed cameras are imported but not delivered while the server's emergency brake (SPEED_CAMERA_NAMESPACE_ENABLED=false) is on
 * (work order "addon-source-catalogue" (kept outside the repo) §3.1: "Import ja, Auslieferung nein" — the importer never touches the flag; the server's
 * default is now "delivered", see server/docs/camera-country-policy.md).
 *
 * The camera rows are posted through the same ApiClient call the OSM worker uses. The test then proves both halves on ONE database:
 * a server with the brake on delivers nothing on any read path, and a second server started on the same data with the brake released
 * delivers exactly what was imported — so the rows were stored, and the flag alone kept them back. The second server is started only
 * after the first has been read, as an operator would restart the node with the flag flipped: two servers with different policies
 * must not take turns building the shared static-data packages.
 */

const CAMERAS = [
  { lat: 48.137154, lng: 11.576124, source: "osm", sourceLicense: "ODbL" },
  { lat: 48.200001, lng: 11.600002, source: "osm", sourceLicense: "ODbL" },
];

describe("speed camera namespace stays closed although cameras were imported", () => {
  let testServer: TestServer;
  let flagOn: RunningServer;
  let token: string;

  beforeAll(async () => {
    testServer = await startTestServer({ speedCameraNamespaceEnabled: false });
    resetEnvCache();
    const env = loadEnv({ SERVER_URL: testServer.serverUrl, CLIENT_ID: testServer.clientId, CLIENT_SECRET: testServer.clientSecret });
    const client = new ApiClient(env, pino({ level: "silent" }));
    await client.authenticate();
    const response = await client.postBatch("fixed-speed-camera", CAMERAS);
    expect(response.inserted).toBe(CAMERAS.length);
    resetEnvCache();

    token = await accessToken(testServer.serverUrl, testServer.clientId, testServer.clientSecret);
  });

  afterAll(async () => {
    await testServer?.teardown();
  });

  async function accessToken(serverUrl: string, clientId: string, clientSecret: string): Promise<string> {
    const res = await fetch(new URL("/v1/auth/token", serverUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, clientSecret }) });
    if (!res.ok) throw new Error(`token fetch failed: ${res.status}`);
    return ((await res.json()) as { accessToken: string }).accessToken;
  }

  async function get<T>(serverUrl: string, pathAndQuery: string): Promise<T> {
    const res = await fetch(new URL(pathAndQuery, serverUrl), { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET ${pathAndQuery} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  const nearby = "/v1/speed-cameras/nearby?lat=48.15&lng=11.58&radiusM=20000";
  const tile = latLngToCell(CAMERAS[0]!.lat, CAMERAS[0]!.lng, 7);

  it("flag off: no read path delivers a camera", async () => {
    const off = testServer.serverUrl;
    expect((await get<{ cameras: unknown[] }>(off, nearby)).cameras).toEqual([]);
    expect((await get<{ cameras: unknown[] }>(off, `/v1/speed-cameras/by-tile?tile=${tile}&k=2`)).cameras).toEqual([]);
    expect((await get<{ fixedSpeedCameras: unknown[] }>(off, "/v1/snapshot")).fixedSpeedCameras).toEqual([]);
    expect((await get<{ partitions: unknown[] }>(off, "/v1/static-data/manifest")).partitions).toEqual([]); // cameras are the only static data on this server
    expect(await get<{ speedCameraNamespaceEnabled: boolean }>(off, "/v1/config")).toMatchObject({ speedCameraNamespaceEnabled: false });
  });

  it("the same data behind a server with the flag on: exactly the imported cameras appear — they were stored all along", async () => {
    flagOn = await testServer.spawnServer({ SPEED_CAMERA_NAMESPACE_ENABLED: "true" });
    const on = flagOn.serverUrl;
    const cameras = (await get<{ cameras: { position: { coordinates: [number, number] } }[] }>(on, nearby)).cameras;
    expect(cameras).toHaveLength(2);
    expect(cameras.map((c) => c.position.coordinates[1]).sort()).toEqual([48.137154, 48.200001]);
    expect((await get<{ fixedSpeedCameras: unknown[] }>(on, "/v1/snapshot")).fixedSpeedCameras).toHaveLength(2);
    expect((await get<{ partitions: unknown[] }>(on, "/v1/static-data/manifest")).partitions.length).toBeGreaterThan(0);
  });
});
