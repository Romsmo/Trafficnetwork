import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDatabase, type TestDatabase } from "./setup.js";
import { insertSpeedLimitSegment, insertStaticSign } from "./helpers.js";
import { findNearestSpeedLimit, findSpeedLimitSegmentsNearby } from "../../src/db/queries/speed-limit-segments.js";
import { findStaticSignsNearby } from "../../src/db/queries/static-signs.js";

/**
 * The bounding-box prefilter (lib/geo-bbox.ts) exists only to let Postgres use the GiST index; it must
 * never change WHICH rows a nearby-query returns. This compares the real query functions against the
 * original, unfiltered ST_DWithin-only SQL on randomly seeded data.
 */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("spatial prefilter equivalence", () => {
  let testDb: TestDatabase;
  const rand = mulberry32(7);

  // Berlin-ish area plus one high-latitude cluster; a handful of long edges (tens of km between vertices).
  const areas = [
    { lat: 52.5, lng: 13.4, spread: 0.3 },
    { lat: 68.4, lng: 17.4, spread: 0.3 },
  ];

  beforeAll(async () => {
    testDb = await startTestDatabase();
    for (const area of areas) {
      for (let i = 0; i < 150; i++) {
        const lat = area.lat + (rand() - 0.5) * area.spread;
        const lng = area.lng + (rand() - 0.5) * area.spread * 2;
        const edges = 2 + Math.floor(rand() * 4);
        const line: [number, number][] = [[lng, lat]];
        for (let e = 1; e < edges; e++) {
          const [pl, pn] = line[e - 1]!;
          line.push([pl + (rand() - 0.5) * 0.004, pn + (rand() - 0.5) * 0.004]);
        }
        await insertSpeedLimitSegment(testDb.db, { lineString: line, speedLimit: 30 + Math.floor(rand() * 10) * 10 });
      }
      for (let i = 0; i < 100; i++) {
        await insertStaticSign(testDb.db, { lat: area.lat + (rand() - 0.5) * area.spread, lng: area.lng + (rand() - 0.5) * area.spread * 2 });
      }
      // two long edges (about 25 km) without intermediate vertices
      await insertSpeedLimitSegment(testDb.db, { lineString: [[area.lng - 0.15, area.lat], [area.lng + 0.15, area.lat + 0.01]], speedLimit: 100 });
      await insertSpeedLimitSegment(testDb.db, { lineString: [[area.lng, area.lat - 0.1], [area.lng + 0.01, area.lat + 0.1]], speedLimit: 120 });
    }
    // Near the antimeridian: prefilter must fall back to the exact query
    await insertSpeedLimitSegment(testDb.db, { lineString: [[179.9990, 10.0], [179.9995, 10.0005]], speedLimit: 60 });
    await insertSpeedLimitSegment(testDb.db, { lineString: [[-179.9995, 10.0], [-179.9990, 10.0005]], speedLimit: 70 });
    await testDb.db.execute(sql`analyze`);
  });

  afterAll(async () => {
    await testDb.teardown();
  });

  async function referenceSegmentIds(lat: number, lng: number, radiusM: number): Promise<string[]> {
    const rows = await testDb.db.execute<{ id: string } & Record<string, unknown>>(sql`
      select id from speed_limit_segments
      where ST_DWithin(geometry::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusM})
      order by id`);
    return rows.map((r) => r.id);
  }

  async function referenceSignIds(lat: number, lng: number, radiusM: number): Promise<string[]> {
    const rows = await testDb.db.execute<{ id: string } & Record<string, unknown>>(sql`
      select id from static_signs
      where ST_DWithin(position::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusM})
      order by id`);
    return rows.map((r) => r.id);
  }

  async function referenceNearest(lat: number, lng: number, maxM: number): Promise<{ id: string; distance: number } | null> {
    const rows = await testDb.db.execute<{ id: string; distance_m: number } & Record<string, unknown>>(sql`
      select id, ST_Distance(geometry::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) as distance_m
      from speed_limit_segments
      where ST_DWithin(geometry::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${maxM})
      order by distance_m asc limit 1`);
    return rows[0] ? { id: rows[0].id, distance: rows[0].distance_m } : null;
  }

  it("returns exactly the same segments as the unfiltered query, for many random points and radii", async () => {
    let nonEmpty = 0;
    for (let i = 0; i < 60; i++) {
      const area = areas[i % areas.length]!;
      const lat = area.lat + (rand() - 0.5) * area.spread * 1.4;
      const lng = area.lng + (rand() - 0.5) * area.spread * 2.8;
      const radiusM = [50, 200, 1000, 5000, 20_000][i % 5]!;
      const expected = await referenceSegmentIds(lat, lng, radiusM);
      const actual = (await findSpeedLimitSegmentsNearby(testDb.db, lat, lng, radiusM, true)).map((s) => s.id).sort();
      expect(actual).toEqual(expected);
      if (expected.length > 0) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(20);
  });

  it("returns exactly the same signs as the unfiltered query", async () => {
    for (let i = 0; i < 40; i++) {
      const area = areas[i % areas.length]!;
      const lat = area.lat + (rand() - 0.5) * area.spread;
      const lng = area.lng + (rand() - 0.5) * area.spread * 2;
      const radiusM = [100, 1000, 8000][i % 3]!;
      const expected = await referenceSignIds(lat, lng, radiusM);
      const actual = (await findStaticSignsNearby(testDb.db, lat, lng, radiusM)).map((s) => s.id).sort();
      expect(actual).toEqual(expected);
    }
  });

  it("finds the same nearest segment (and distance) as the unfiltered lookup", async () => {
    for (let i = 0; i < 60; i++) {
      const area = areas[i % areas.length]!;
      const lat = area.lat + (rand() - 0.5) * area.spread;
      const lng = area.lng + (rand() - 0.5) * area.spread * 2;
      const maxM = [100, 200, 2000][i % 3]!;
      const expected = await referenceNearest(lat, lng, maxM);
      const actual = await findNearestSpeedLimit(testDb.db, lat, lng, maxM, true);
      if (!expected) {
        expect(actual).toBeNull();
      } else {
        expect(actual?.segmentId).toBe(expected.id);
        expect(actual?.distanceMeters).toBeCloseTo(expected.distance, 6);
      }
    }
  });

  it("still answers correctly right at the antimeridian, where no prefilter is applied", async () => {
    const expected = await referenceSegmentIds(10.0002, 179.9998, 500);
    expect(expected.length).toBe(2);
    const actual = (await findSpeedLimitSegmentsNearby(testDb.db, 10.0002, 179.9998, 500, true)).map((s) => s.id).sort();
    expect(actual).toEqual(expected);
  });
});
