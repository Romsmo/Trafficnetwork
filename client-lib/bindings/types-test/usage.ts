// Compiled (never run) in CI against the hand-written declarations of both
// JS bindings. If a declaration drifts from what a host app is documented to
// write (client-lib/docs/integration-*.md), this stops compiling.

import {
  Client as NodeClient,
  libraryVersion,
  TrafficNetworkError,
  type CameraLevel,
  type CameraPolicy,
  type ClientEvent,
  type ClientOptions,
  type NearbyItem,
  type OfflineSettings,
  type SecureStore,
  type TrafficNetworkClient,
} from "../node/index.js";
import { Client as WebClient } from "../wasm/js/index.js";

const options: ClientOptions & { storagePath: string } = {
  storagePath: "/var/lib/myapp/trafficnetwork",
  discovery: false,
  nodes: ["https://node.example.org"],
  credentials: { type: "client", clientId: "id", clientSecret: "secret" },
};

/** The same code works against either binding — that is the point of one shared surface. */
async function useAnyBinding(client: TrafficNetworkClient): Promise<void> {
  await client.updatePosition(52.52, 13.405, 30);
  const report = await client.sync();
  if (!report.ok && report.dynamicDataError !== null) console.log(report.dynamicDataError);

  const limit = await client.getSpeedLimitAt(52.52, 13.405);
  if (limit !== null) {
    const kmh: number = limit.value;
    if (limit.origin.kind === "communityCorrected") console.log(limit.origin.needsReview, kmh);
  }

  const items: NearbyItem[] = await client.getNearby(52.52, 13.405, 500, ["hazards", "signs"]);
  for (const item of items) {
    if (item.kind === "hazard") console.log(item.hazardType, item.pending, item.confirmCount);
    else if (item.kind === "sign") console.log(item.signType);
  }

  const localId: string = await client.submitReport("accident", 52.52, 13.405);
  await client.confirmReport(localId, true);

  client.onEvent((event: ClientEvent) => {
    if (event.type === "syncFailed") console.log(event.code, event.message);
    if (event.type === "dataChanged") console.log(event.entityType, event.entityId);
  });
  client.startRealtime();
  client.stopRealtime();

  const network = await client.getNetworkStatus();
  console.log(network.knownNodes.map((node) => node.tier), network.onlineNode);

  const policy: CameraPolicy = await client.getCameraPolicy();
  const level: CameraLevel = policy.byCountry["DE"] ?? policy.defaultLevel;
  console.log(policy.active, policy.maxLevel, level, policy.notice.text["en"]);
  for (const item of await client.getNearby(52.52, 13.405, 2000, ["cameras"])) {
    if (item.kind === "cameraZone") console.log(item.outline.length, item.cameraTypes);
    if (item.kind === "camera") console.log(item.lat, item.lng);
  }

  // 1.2.0: own duration, speed limit for a road without one, lookup with online fallback
  const limits = await client.getReportLimits("accident");
  const asked = limits.defaultSeconds ?? 3600;
  const queued = await client.submitReportWithDuration("accident", 52.52, 13.405, { ttlSeconds: asked });
  console.log(queued.localId, queued.expiresInSeconds, queued.durationHonoured);
  await client.submitReport("accident", 52.52, 13.405, undefined, asked);
  await client.reportMissingSpeedLimit({ lat: 52.52, lng: 13.405, value: 30, unit: "kmh", bearing: 90 });
  const lookup = await client.lookupSpeedLimit(52.52, 13.405, 90);
  if (lookup.status === "found") console.log(lookup.value, lookup.source);
  else if (lookup.status === "outsideOfflineArea") console.log("outside the offline area");

  // 1.2.0: the offline area
  const regions = await client.listOfflineRegions();
  await client.setOfflineRegions({ mode: "regions", regions: regions.slice(0, 1).map((r) => r.id) });
  await client.setAutoRegionPolicy({ homeLat: 52.52, homeLng: 13.405, homeRadiusTiles: 2 });
  await client.setStorageLimits({ maxBytes: 200 * 1024 * 1024, wifiOnly: true });
  await client.setConnectionMetered(false);
  const plan = await client.getStoragePlan();
  console.log(plan.toFetchBytes, plan.fits, plan.needsLocation, plan.deferredForLimit);
  const usage = await client.getStorageUsage();
  console.log(usage.storedTiles, usage.tiles[0]?.lastUsedUnixMs);
  const coverage = await client.getCoverage(52.52, 13.405);
  console.log(coverage.covered, coverage.state, coverage.usesNetwork);
  const offline: OfflineSettings = await client.getOfflineSettings();
  console.log(offline.mode, offline.maxBytes);

  // @ts-expect-error: not one of the eleven hazard types
  await client.submitReport("tsunami", 1, 2);

  try {
    await client.close();
  } catch (error) {
    if (error instanceof TrafficNetworkError) {
      const code: string = error.code;
      console.log(code, error.detail);
    }
  }
  client.free();
}

const secureStore: SecureStore = {
  get: (key) => (key === "x" ? "y" : null),
  set: () => undefined,
  delete: () => undefined,
};

export async function node(): Promise<void> {
  console.log(libraryVersion());
  await useAnyBinding(new NodeClient(options, { secureStore, libraryPath: "/opt/libtrafficnetwork.so" }));
}

export async function browser(): Promise<void> {
  await useAnyBinding(await WebClient.create({ ...options, storagePath: "my-app" }, { secureStore }));
}
