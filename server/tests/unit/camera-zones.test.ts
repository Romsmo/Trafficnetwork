import { describe, expect, it } from "vitest";
import { cellToBoundary, cellToLatLng, getResolution, latLngToCell } from "h3-js";
import { loadEnv, resetEnvCache } from "../../src/config/env.js";
import { generateEd25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import type { NetworkConfigPayload } from "../../src/modules/network/config.js";
import { buildEffectivePolicy, type EffectiveCameraPolicy } from "../../src/modules/cameras/policy/policy.js";
import type { CameraLevel } from "../../src/modules/cameras/policy/levels.js";
import {
  cameraPackageTiles,
  cellIntersectsCircle,
  packageTileOfZoneCell,
  tileSpeaksForCell,
  tilesSpeakingForCell,
  zoneCellOf,
  zoneCellsForTiles,
  zoneCellsIntersectingCircle,
  zoneCellsOfPackageTile,
  zoneId,
} from "../../src/modules/cameras/policy/cells.js";
import { allZones, individualItems, mergeZones, zonesForCells } from "../../src/modules/cameras/policy/projection.js";
import { classifyEvent, isCameraEvent, mayLeaveNode } from "../../src/modules/cameras/policy/events.js";
import type { CameraRecord } from "../../src/db/queries/camera-record.js";

function policyOf(levels: Record<string, CameraLevel>, zoneResolution = 6): EffectiveCameraPolicy {
  resetEnvCache();
  const env = loadEnv({
    DATABASE_URL: "postgres://x",
    JWT_SECRET: "a".repeat(32),
    SPEED_CAMERA_NAMESPACE_ENABLED: "true",
    CAMERA_ZONE_H3_RESOLUTION: String(zoneResolution),
  });
  const envelope = signEnvelope<NetworkConfigPayload>(
    { version: 1, blitzerEnabled: true, cameraPolicyByCountry: levels, eventLogRetentionDaysDynamic: 3, eventLogRetentionDaysStatic: 30, minVersion: "0.1.0", excludedNodeIds: [], issuedAt: "2026-01-01T00:00:00Z" },
    generateEd25519KeyPair(),
  );
  return buildEffectivePolicy(env, envelope);
}

interface Item {
  id: string;
  type: string;
  cameraType?: string;
  position: { type: "Point"; coordinates: [number, number] };
}

let counter = 0;
function camera(lat: number, lng: number, countries: string[] | null, type = "fixedSpeedCamera"): CameraRecord<Item> {
  return { item: { id: `cam-${++counter}`, type, cameraType: type, position: { type: "Point", coordinates: [lng, lat] } }, countries, lat, lng };
}

const BERLIN = { lat: 52.52, lng: 13.405 };

describe("zone identity", () => {
  it("a zone id is derived from the cell alone: stable, UUID-shaped, different per cell", () => {
    const a = latLngToCell(BERLIN.lat, BERLIN.lng, 6);
    const b = latLngToCell(48.137, 11.575, 6);
    expect(zoneId(a)).toBe(zoneId(a));
    expect(zoneId(a)).not.toBe(zoneId(b));
    expect(zoneId(a)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("which zone cells a query speaks for - decided by the cell, never by a camera", () => {
  it("a circle speaks for every cell it touches, including the one around its centre", () => {
    const cells = zoneCellsIntersectingCircle(BERLIN.lat, BERLIN.lng, 4000, 6);
    expect(cells).toContain(latLngToCell(BERLIN.lat, BERLIN.lng, 6));
    expect(cells.length).toBeGreaterThan(1);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it("any point inside the circle lies in one of the cells the circle speaks for (no camera can be missed)", () => {
    for (const radius of [500, 2000, 9000, 30000]) {
      const cells = new Set(zoneCellsIntersectingCircle(BERLIN.lat, BERLIN.lng, radius, 6));
      for (let i = 0; i < 400; i++) {
        const bearing = Math.random() * 2 * Math.PI;
        const distance = Math.sqrt(Math.random()) * radius * 0.999;
        const lat = BERLIN.lat + (distance * Math.cos(bearing)) / 111_320;
        const lng = BERLIN.lng + (distance * Math.sin(bearing)) / (111_320 * Math.cos((BERLIN.lat * Math.PI) / 180));
        expect(cells.has(latLngToCell(lat, lng, 6))).toBe(true);
      }
    }
  });

  it("a cell far from the circle is not included, one that is merely touched is", () => {
    const home = latLngToCell(BERLIN.lat, BERLIN.lng, 6);
    expect(cellIntersectsCircle(home, BERLIN.lat, BERLIN.lng, 10)).toBe(true);
    const [far] = [latLngToCell(48.137, 11.575, 6)];
    expect(cellIntersectsCircle(far, BERLIN.lat, BERLIN.lng, 5000)).toBe(false);
  });

  it("tiles of any resolution speak for the zone cells they contain or lie in", () => {
    const zoneCell = latLngToCell(BERLIN.lat, BERLIN.lng, 6);
    const fine = latLngToCell(BERLIN.lat, BERLIN.lng, 9);
    const coarse = latLngToCell(BERLIN.lat, BERLIN.lng, 4);
    expect(zoneCellsForTiles([zoneCell], 6)).toEqual([zoneCell]);
    expect(zoneCellsForTiles([fine], 6)).toEqual([zoneCell]);
    expect(zoneCellsForTiles([coarse], 6)).toContain(zoneCell);
    expect(zoneCellsForTiles([coarse], 6)).toHaveLength(49);
    expect(tileSpeaksForCell(fine, zoneCell)).toBe(true);
    expect(tileSpeaksForCell(coarse, zoneCell)).toBe(true);
    expect(tileSpeaksForCell(zoneCell, zoneCell)).toBe(true);
    expect(tileSpeaksForCell(latLngToCell(48.137, 11.575, 7), zoneCell)).toBe(false);
  });

  it("refuses to expand tiles far coarser than a zone instead of truncating", () => {
    const veryCoarse = latLngToCell(BERLIN.lat, BERLIN.lng, 1);
    expect(zoneCellsForTiles([veryCoarse], 6, 5000)).toBeNull();
    expect(zoneCellsForTiles([latLngToCell(BERLIN.lat, BERLIN.lng, 4)], 6, 5000)).not.toBeNull();
  });

  it("a pushed zone event goes to the subscription tiles the cell touches", () => {
    const zoneCell = latLngToCell(BERLIN.lat, BERLIN.lng, 6);
    const tiles = tilesSpeakingForCell(zoneCell, 7);
    expect(tiles).toHaveLength(7);
    for (const tile of tiles) {
      expect(getResolution(tile)).toBe(7);
      expect(tileSpeaksForCell(tile, zoneCell)).toBe(true);
    }
    expect(tilesSpeakingForCell(zoneCell, 5)).toHaveLength(1);
    expect(tilesSpeakingForCell(zoneCell, 6)).toEqual([zoneCell]);
  });

  it("a camera dirties the tile it is in and the tile that carries its zone", () => {
    for (let i = 0; i < 300; i++) {
      const lat = 47 + Math.random() * 8;
      const lng = 6 + Math.random() * 9;
      const tiles = cameraPackageTiles(lat, lng, 4, 6);
      expect(tiles).toContain(latLngToCell(lat, lng, 4));
      expect(tiles).toContain(packageTileOfZoneCell(latLngToCell(lat, lng, 6), 4));
      expect(zoneCellsOfPackageTile(packageTileOfZoneCell(latLngToCell(lat, lng, 6), 4), 6)).toContain(latLngToCell(lat, lng, 6));
    }
  });
});

describe("projection: individual cameras and zones", () => {
  const policy = policyOf({ DE: "full", FR: "zones", CH: "off" });

  it("delivers an individual camera only at level full of every country it is in", () => {
    const de = camera(52.5, 13.4, ["DE"]);
    const fr = camera(48.8, 2.3, ["FR"]);
    const ch = camera(47.4, 8.5, ["CH"]);
    const borderDeFr = camera(48.9, 7.9, ["DE", "FR"]);
    const unknown = camera(50, 10, null);
    const empty = camera(50, 10, []);
    expect(individualItems(policy, [de, fr, ch, borderDeFr, unknown, empty])).toEqual([de.item]);
  });

  it("honours the requested types and the endpoint's own selection", () => {
    const a = camera(52.5, 13.4, ["DE"], "fixedSpeedCamera");
    const b = camera(52.6, 13.4, ["DE"], "redLightCamera");
    expect(individualItems(policy, [a, b], { types: new Set(["redLightCamera"]) })).toEqual([b.item]);
    expect(individualItems(policy, [a, b], { keep: (r) => r.lat < 52.55 })).toEqual([a.item]);
  });

  it("a zone says only: this cell, these kinds - no position, id, time or count of a camera", () => {
    const records = [camera(48.8566, 2.3522, ["FR"], "fixedSpeedCamera"), camera(48.8570, 2.3530, ["FR"], "mobileSpeedCamera"), camera(48.8571, 2.3531, ["FR"], "mobileSpeedCamera")];
    const cell = zoneCellOf(48.8566, 2.3522, 6);
    const [zone] = zonesForCells(policy, records, new Set([cell]));
    expect(zone).toBeDefined();
    expect(Object.keys(zone!).sort()).toEqual(["boundary", "cameraTypes", "cell", "id", "resolution", "status"]);
    expect(zone!.cameraTypes).toEqual(["fixedSpeedCamera", "mobileSpeedCamera"]); // a set, sorted: two mobile cameras do not show as two
    expect(zone!.status).toBe("active");
    expect(zone!.resolution).toBe(6);
    expect(JSON.stringify(zone)).not.toContain("cam-");
  });

  it("every coordinate of a zone is a vertex of its cell - nothing finer than the cell", () => {
    const [zone] = zonesForCells(policy, [camera(48.8566, 2.3522, ["FR"])], new Set([zoneCellOf(48.8566, 2.3522, 6)]));
    const vertices = cellToBoundary(zone!.cell, true).map(([lng, lat]) => `${lng},${lat}`);
    const ring = zone!.boundary.coordinates[0]!.map(([lng, lat]) => `${lng},${lat}`);
    for (const point of ring) expect(vertices).toContain(point);
  });

  it("the answer for a cell does not depend on where in the cell the camera is", () => {
    const cell = zoneCellOf(48.8566, 2.3522, 6);
    const [centreLat, centreLng] = cellToLatLng(cell);
    const [boundaryLng, boundaryLat] = cellToBoundary(cell, true)[0]!;
    const positions: Array<[number, number]> = [
      [centreLat, centreLng],
      [48.8566, 2.3522],
      // just inside a vertex: still the same cell
      [boundaryLat + (centreLat - boundaryLat) * 0.02, boundaryLng + (centreLng - boundaryLng) * 0.02],
    ];
    const answers = positions.map(([lat, lng]) => {
      expect(zoneCellOf(lat, lng, 6)).toBe(cell);
      return JSON.stringify(zonesForCells(policy, [camera(lat, lng, ["FR"])], new Set([cell])));
    });
    expect(new Set(answers).size).toBe(1);
  });

  it("a cell that was not asked about is not delivered, wherever the camera in it is", () => {
    const record = camera(48.8566, 2.3522, ["FR"]);
    const other = latLngToCell(52.52, 13.405, 6);
    expect(zonesForCells(policy, [record], new Set([other]))).toEqual([]);
  });

  it("cameras of countries at full or off, or with an unknown country, make no zone", () => {
    const records = [camera(52.5, 13.4, ["DE"]), camera(47.4, 8.5, ["CH"]), camera(50, 10, null), camera(50, 10, ["FR", "DE"], "redLightCamera")];
    const cells = new Set(records.map((r) => zoneCellOf(r.lat, r.lng, 6)));
    const zones = zonesForCells(policy, records, cells);
    // only the border camera (FR+DE -> zones) shows up, as a zone
    expect(zones).toHaveLength(1);
    expect(zones[0]!.cameraTypes).toEqual(["redLightCamera"]);
  });

  it("restricts the kinds of a zone to the requested ones", () => {
    const cell = zoneCellOf(48.8566, 2.3522, 6);
    const records = [camera(48.8566, 2.3522, ["FR"], "fixedSpeedCamera"), camera(48.857, 2.353, ["FR"], "redLightCamera")];
    const [zone] = zonesForCells(policy, records, new Set([cell]), new Set(["redLightCamera"]));
    expect(zone!.cameraTypes).toEqual(["redLightCamera"]);
    expect(zonesForCells(policy, records, new Set([cell]), new Set(["trailerCamera"]))).toEqual([]);
  });

  it("allZones covers every zones-level camera once; mergeZones unions the kinds of one cell", () => {
    const records = [camera(48.8566, 2.3522, ["FR"], "fixedSpeedCamera"), camera(48.8567, 2.3523, ["FR"], "redLightCamera"), camera(52.5, 13.4, ["DE"])];
    const zones = allZones(policy, records);
    expect(zones).toHaveLength(1);
    const merged = mergeZones(zones, zonesForCells(policy, [camera(48.8568, 2.3524, ["FR"], "distanceControl")], new Set([zones[0]!.cell])));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.cameraTypes).toEqual(["distanceControl", "fixedSpeedCamera", "redLightCamera"]);
  });
});

describe("event classification (delta, WebSocket, federation)", () => {
  const policy = policyOf({ DE: "full", FR: "zones", CH: "off" });
  const cameraEvent = (countries: string[] | null, over: Record<string, unknown> = {}) => ({
    entityType: "fixedSpeedCamera",
    payload: { id: "x", type: "fixedSpeedCamera", position: { type: "Point", coordinates: [2.3522, 48.8566] } },
    cameraCountries: countries,
    ...over,
  });

  it("recognises camera events by content, not by a column someone remembered to fill in", () => {
    expect(isCameraEvent({ entityType: "fixedSpeedCamera", payload: {} })).toBe(true);
    expect(isCameraEvent({ entityType: "enforcementDevice", payload: {} })).toBe(true);
    expect(isCameraEvent({ entityType: "hazardReport", payload: { type: "mobileSpeedCamera" } })).toBe(true);
    expect(isCameraEvent({ entityType: "hazardReport", payload: { type: "traffic" } })).toBe(false);
    expect(isCameraEvent({ entityType: "speedLimitSegment", payload: { type: "fixedSpeedCamera" } })).toBe(false);
  });

  it("passes other events, delivers full, turns zones into a cell, withholds the rest (a restriction exists, so an unplaced camera is withheld)", () => {
    expect(classifyEvent(policy, { entityType: "hazardReport", payload: { type: "traffic" }, cameraCountries: null })).toEqual({ kind: "pass" });
    expect(classifyEvent(policy, cameraEvent(["DE"]))).toEqual({ kind: "item" });
    expect(classifyEvent(policy, cameraEvent(["FR"]))).toEqual({ kind: "zone", cell: zoneCellOf(48.8566, 2.3522, 6) });
    expect(classifyEvent(policy, cameraEvent(["CH"]))).toEqual({ kind: "withhold" });
    expect(classifyEvent(policy, cameraEvent(null))).toEqual({ kind: "withhold" });
    expect(classifyEvent(policy, cameraEvent([]))).toEqual({ kind: "withhold" });
    expect(classifyEvent(policy, cameraEvent(["DE", "FR"]))).toMatchObject({ kind: "zone" });
  });

  it("a zones event whose position cannot be read is withheld, not guessed", () => {
    expect(classifyEvent(policy, cameraEvent(["FR"], { payload: { id: "x", type: "fixedSpeedCamera" } }))).toEqual({ kind: "withhold" });
  });

  it("a camera event leaves the node (federation) only at level full", () => {
    const camera = (countries: string[] | null) => ({ isCamera: true, cameraCountries: countries });
    expect(mayLeaveNode(policy, camera(["DE"]))).toBe(true);
    expect(mayLeaveNode(policy, camera(["FR"]))).toBe(false);
    expect(mayLeaveNode(policy, camera(["CH"]))).toBe(false);
    expect(mayLeaveNode(policy, camera(null))).toBe(false);
    expect(mayLeaveNode(policy, { isCamera: false, cameraCountries: null })).toBe(true);
  });

  it("with no restriction at all a camera without a known country is delivered like any other", () => {
    const open = policyOf({});
    expect(classifyEvent(open, { entityType: "fixedSpeedCamera", payload: {}, cameraCountries: null })).toEqual({ kind: "item" });
    expect(mayLeaveNode(open, { isCamera: true, cameraCountries: null })).toBe(true);
    expect(mayLeaveNode(open, { isCamera: true, cameraCountries: [] })).toBe(true);
    expect(individualItems(open, [camera(50, 10, null), camera(50, 10, [])])).toHaveLength(2);
  });
});
