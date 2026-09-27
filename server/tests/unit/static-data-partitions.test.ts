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
    segmentKey: "0".repeat(32),
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

function fixedSpeedCamera(id: string, coordinates: [number, number], cameraType: FixedSpeedCameraApi["cameraType"] = "fixedSpeedCamera"): FixedSpeedCameraApi {
  return {
    id,
    type: cameraType,
    cameraType,
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

describe("buildPartitions — persistent enforcement devices (add-on D)", () => {
  const camera = fixedSpeedCamera("cam-1", [BERLIN[0] + 0.01, BERLIN[1] + 0.01]);
  const redLight = fixedSpeedCamera("light-1", [BERLIN[0] + 0.02, BERLIN[1] + 0.02], "redLightCamera");

  it("puts every device into `enforcementDevices` of its partition and leaves `fixedSpeedCameras` to the speed cameras", () => {
    const partitions = buildPartitions(
      { speedLimitSegments: [], staticSigns: [], fixedSpeedCameras: [camera], enforcementDevices: [camera, redLight] },
      2,
    );
    const [partition] = [...partitions.values()];
    expect(partition!.fixedSpeedCameras.map((c) => c.id)).toEqual(["cam-1"]);
    expect(partition!.enforcementDevices!.map((c) => c.cameraType)).toEqual(["fixedSpeedCamera", "redLightCamera"]);
  });

  it("omits the key when a partition has no device — the bytes, and so the hash, stay what they were before the key existed", () => {
    const [partition] = [...buildPartitions({ speedLimitSegments: [], staticSigns: [staticSign("sign-1", BERLIN)], fixedSpeedCameras: [] }, 2).values()];
    expect("enforcementDevices" in partition!).toBe(false);
    const json = serializePartition(partition!).json;
    expect(json).not.toContain("enforcementDevices");
    expect(json.endsWith(`"fixedSpeedCameras":[]}`)).toBe(true);
  });

  it("appends the key after `fixedSpeedCameras`, so the leading bytes of a package never move", () => {
    const [partition] = [...buildPartitions({ speedLimitSegments: [], staticSigns: [], fixedSpeedCameras: [], enforcementDevices: [redLight] }, 2).values()];
    const json = serializePartition(partition!).json;
    expect(json.indexOf(`"fixedSpeedCameras":[]`)).toBeGreaterThan(0);
    expect(json.indexOf(`"enforcementDevices"`)).toBeGreaterThan(json.indexOf(`"fixedSpeedCameras"`));
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
