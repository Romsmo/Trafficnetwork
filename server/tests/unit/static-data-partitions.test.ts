import { describe, expect, it } from "vitest";
import { buildPartitions, serializePartition } from "../../src/modules/static-data/partitions.js";
import type { SpeedLimitSegmentApi } from "../../src/db/queries/speed-limit-segments.js";
import type { StaticSignApi } from "../../src/db/queries/static-signs.js";
import type { FixedSpeedCameraApi } from "../../src/db/queries/fixed-speed-cameras.js";

const BERLIN: [number, number] = [13.405, 52.52]; // [lng, lat]
const SYDNEY: [number, number] = [151.2093, -33.8688];

function speedLimitSegment(id: string, coordinates: [number, number][]): SpeedLimitSegmentApi {
  return {
    id,
    geometry: { type: "LineString", coordinates },
    speedLimit: 50,
    speedLimitUnit: "kmh",
    source: "test",
    sourceLicense: null,
    importedAt: "2026-01-01T00:00:00Z",
    lastConfirmedAt: null,
  };
}

function staticSign(id: string, coordinates: [number, number]): StaticSignApi {
  return {
    id,
    position: { type: "Point", coordinates },
    signType: "DE:274",
    source: "test",
    sourceLicense: null,
    importedAt: "2026-01-01T00:00:00Z",
  };
}

function fixedSpeedCamera(id: string, coordinates: [number, number]): FixedSpeedCameraApi {
  return {
    id,
    type: "fixedSpeedCamera",
    position: { type: "Point", coordinates },
    status: "active",
    removedAt: null,
    source: "test",
    sourceLicense: null,
    importedAt: "2026-01-01T00:00:00Z",
    lastConfirmedAt: null,
    removalReportCount: 0,
  };
}

describe("buildPartitions", () => {
  it("groups points into the same partition when they're close together", () => {
    const partitions = buildPartitions(
      {
        speedLimitSegments: [],
        staticSigns: [staticSign("sign-1", BERLIN)],
        fixedSpeedCameras: [fixedSpeedCamera("cam-1", [BERLIN[0] + 0.01, BERLIN[1] + 0.01])],
      },
      2,
    );
    expect(partitions.size).toBe(1);
    const [partition] = [...partitions.values()];
    expect(partition!.staticSigns.map((s) => s.id)).toEqual(["sign-1"]);
    expect(partition!.fixedSpeedCameras.map((c) => c.id)).toEqual(["cam-1"]);
  });

  it("puts far-apart points into different partitions", () => {
    const partitions = buildPartitions(
      {
        speedLimitSegments: [],
        staticSigns: [staticSign("berlin-sign", BERLIN), staticSign("sydney-sign", SYDNEY)],
        fixedSpeedCameras: [],
      },
      2,
    );
    expect(partitions.size).toBe(2);
    const tiles = [...partitions.entries()];
    const berlinPartition = tiles.find(([, p]) => p.staticSigns.some((s) => s.id === "berlin-sign"))?.[1];
    const sydneyPartition = tiles.find(([, p]) => p.staticSigns.some((s) => s.id === "sydney-sign"))?.[1];
    expect(berlinPartition).toBeDefined();
    expect(sydneyPartition).toBeDefined();
    expect(berlinPartition!.tile).not.toBe(sydneyPartition!.tile);
  });

  it("includes a boundary-crossing LineString in every partition its vertices touch", () => {
    const partitions = buildPartitions(
      {
        speedLimitSegments: [speedLimitSegment("cross-continent", [BERLIN, SYDNEY])],
        staticSigns: [],
        fixedSpeedCameras: [],
      },
      2,
    );
    expect(partitions.size).toBe(2);
    for (const partition of partitions.values()) {
      expect(partition.speedLimitSegments.map((s) => s.id)).toEqual(["cross-continent"]);
    }
  });

  it("omits fixedSpeedCameras/staticSigns/speedLimitSegments arrays' entries from unrelated partitions", () => {
    const partitions = buildPartitions(
      {
        speedLimitSegments: [speedLimitSegment("local", [BERLIN, [BERLIN[0] + 0.001, BERLIN[1] + 0.001]])],
        staticSigns: [staticSign("sydney-sign", SYDNEY)],
        fixedSpeedCameras: [],
      },
      2,
    );
    const sydneyPartition = [...partitions.values()].find((p) => p.staticSigns.length > 0);
    expect(sydneyPartition!.speedLimitSegments).toEqual([]);
  });
});

describe("serializePartition", () => {
  it("produces the same hash for identical content and a different hash when content changes", () => {
    const content = {
      tile: "8129bffffffffff",
      speedLimitSegments: [],
      staticSigns: [staticSign("sign-1", BERLIN)],
      fixedSpeedCameras: [],
    };
    const a = serializePartition(content);
    const b = serializePartition(structuredClone(content));
    expect(a.hash).toBe(b.hash);

    const changed = serializePartition({ ...content, staticSigns: [staticSign("sign-2", BERLIN)] });
    expect(changed.hash).not.toBe(a.hash);
    expect(a.sizeBytes).toBeGreaterThan(0);
  });
});
