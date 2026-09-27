import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Region } from "../../src/config/regions.js";
import { verifyRun } from "../../src/verify/verify.js";

const silentLogger = pino({ level: "silent" });

function region(overrides: Partial<Region> = {}): Region {
  return {
    name: "Test Region",
    geofabrikExtractUrl: "https://example.invalid/extract.osm.pbf",
    geofabrikChecksumUrl: "https://example.invalid/extract.osm.pbf.md5",
    bbox: [8.975186, 47.26543, 13.84947, 50.56623], // Bayern, real bbox
    ...overrides,
  };
}

function fakeApiClient(overrides: {
  nearby?: { speedLimit: number; speedLimitUnit: "kmh" | "mph" }[];
  manifest?: { tile: string; hash: string; sizeBytes: number }[];
  partitions?: Record<string, { speedLimitSegments: unknown[]; staticSigns: unknown[]; fixedSpeedCameras: unknown[] }>;
}) {
  return {
    getNearbySpeedLimitSegments: vi.fn().mockResolvedValue(overrides.nearby ?? []),
    getStaticDataManifest: vi.fn().mockResolvedValue({ staticDataVersion: 1, generatedAt: new Date().toISOString(), partitions: overrides.manifest ?? [] }),
    getStaticDataPartition: vi.fn(async (tile: string) => overrides.partitions?.[tile] ?? { speedLimitSegments: [], staticSigns: [], fixedSpeedCameras: [] }),
  } as unknown as import("../../src/api/client.js").ApiClient;
}

const emptyCounts = { "speed-limit-segment": 0, "static-sign": 0, "fixed-speed-camera": 0 } as const;

describe("verifyRun", () => {
  it("reports a spot-check as found when the expected speed limit is present nearby", async () => {
    const apiClient = fakeApiClient({ nearby: [{ speedLimit: 50, speedLimitUnit: "kmh" }] });
    const result = await verifyRun(apiClient, region({ verificationPoints: [{ lat: 48.1, lng: 11.5, expectedKmh: 50 }] }), { ...emptyCounts }, silentLogger);
    expect(result.spotChecks).toEqual([{ lat: 48.1, lng: 11.5, expectedKmh: 50, found: true, actualKmh: 50 }]);
  });

  it("reports a spot-check as not found when the expected speed limit is absent nearby", async () => {
    const apiClient = fakeApiClient({ nearby: [{ speedLimit: 30, speedLimitUnit: "kmh" }] });
    const result = await verifyRun(apiClient, region({ verificationPoints: [{ lat: 48.1, lng: 11.5, expectedKmh: 50 }] }), { ...emptyCounts }, silentLogger);
    expect(result.spotChecks).toEqual([{ lat: 48.1, lng: 11.5, expectedKmh: 50, found: false, actualKmh: 30 }]);
  });

  it("skips spot-checks entirely when the region has no verificationPoints", async () => {
    const apiClient = fakeApiClient({});
    const result = await verifyRun(apiClient, region(), { ...emptyCounts }, silentLogger);
    expect(result.spotChecks).toEqual([]);
  });

  it("sums manifest partitions that fall within the region's bbox, ignoring others", async () => {
    const apiClient = fakeApiClient({
      manifest: [
        { tile: "821f8ffffffffff", hash: "a", sizeBytes: 1 }, // inside Bayern's bbox (confirmed via h3-js directly)
        { tile: "ffffffffffffff", hash: "b", sizeBytes: 1 }, // not a real/relevant tile, should be ignored
      ],
      partitions: {
        "821f8ffffffffff": { speedLimitSegments: [1, 2, 3], staticSigns: [1], fixedSpeedCameras: [] },
      },
    });
    const result = await verifyRun(apiClient, region(), { ...emptyCounts }, silentLogger);
    expect(result.manifestCounts).toEqual({ speedLimitSegments: 3, staticSigns: 1, fixedSpeedCameras: 0 });
  });

  it("passes the run's own insertedByKind through unchanged as the headline result", async () => {
    const apiClient = fakeApiClient({});
    const counts = { "speed-limit-segment": 10, "static-sign": 2, "fixed-speed-camera": 1 };
    const result = await verifyRun(apiClient, region(), counts, silentLogger);
    expect(result.insertedByKind).toEqual(counts);
  });
});
