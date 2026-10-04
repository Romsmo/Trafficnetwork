import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { Queryable } from "../../src/db/client.js";
import { generateEd25519KeyPair, type Ed25519KeyPair } from "../../src/modules/crypto/keys.js";
import { signEnvelope } from "../../src/modules/crypto/envelope.js";
import type { NetworkConfigPayload } from "../../src/modules/network/config.js";
import type { CameraLevel } from "../../src/modules/cameras/policy/levels.js";

/**
 * Test support for the country-based camera policy (docs/camera-country-policy.md): synthetic country boundaries
 * (rectangles - the server ships no geodata, and a test must not depend on any) and a signed network config per policy.
 */

export interface Box {
  iso2: string;
  west: number;
  south: number;
  east: number;
  north: number;
}

/** One big "country" that covers every coordinate the older camera tests use (Berlin, Munich, 60-80 degrees north...). */
export const WORLD_AS_DE: Box[] = [{ iso2: "DE", west: -30, south: 30, east: 50, north: 85 }];

/**
 * Disjoint synthetic countries around the test coordinates. Borders are shared on purpose:
 *   FR | DE meet at lng 7.0 (lat 47.5-51), CH | DE at lat 47.5 (lng 8-10.5)... see the layout:
 *
 *     lat 55 +--------------------+
 *            |        DE          |      DE: lat 47.5-55, lng 7-15
 *     lat 47.5+--------------------+      FR: lat 42-51,   lng -5-7
 *     FR  |   CH (lat 45.8-47.5, lng 7-10.5)   CH: lat 45.8-47.5, lng 7-10.5
 *     AT: lat 46.4-49, lng 15-17 (shares lng 15 with DE)
 *
 * Nothing covers lng 20 / lat 52 (the "sea"): a camera there belongs to no known country.
 */
export const EUROPE_BOXES: Box[] = [
  { iso2: "DE", west: 7, south: 47.5, east: 15, north: 55 },
  { iso2: "FR", west: -5, south: 42, east: 7, north: 51 },
  { iso2: "CH", west: 7, south: 45.8, east: 10.5, north: 47.5 },
  { iso2: "AT", west: 15, south: 46.4, east: 17, north: 49 },
];

const PIECE_DEGREES = 5;

/** Replaces the boundary table with these rectangles, cut into small pieces (as ST_Subdivide would) so geography stays well-behaved. */
export async function loadBoundaries(db: Queryable, boxes: readonly Box[]): Promise<void> {
  await db.execute(sql`delete from country_boundary_parts`);
  for (const box of boxes) {
    for (let w = box.west; w < box.east; w += PIECE_DEGREES) {
      for (let s = box.south; s < box.north; s += PIECE_DEGREES) {
        const e = Math.min(w + PIECE_DEGREES, box.east);
        const n = Math.min(s + PIECE_DEGREES, box.north);
        await db.execute(sql`insert into country_boundary_parts (iso2, geom) values (${box.iso2}, ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326))`);
      }
    }
  }
}

export interface PolicyFixture {
  readonly dir: string;
  readonly root: Ed25519KeyPair;
  readonly file: string;
  /** Signs a new version of the network config with these levels and writes it to `file`. */
  write(levels: Record<string, CameraLevel>, opts?: { blitzerEnabled?: boolean; version?: number; omitPolicy?: boolean }): string;
  /** Env overrides that make a node use this file, with the emergency brake released locally. */
  env(overrides?: Record<string, string>): Record<string, string>;
  cleanup(): void;
}

/**
 * A directory with a root key and a signed network config that the test rewrites to change the policy (no restart).
 * Pass `root` to make several nodes of one network share the key their configs are signed with.
 */
export function createPolicyFixture(sharedRoot?: Ed25519KeyPair): PolicyFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "camera-policy-"));
  const root = sharedRoot ?? generateEd25519KeyPair();
  const file = path.join(dir, "network-config.json");
  let version = 0;

  const write: PolicyFixture["write"] = (levels, opts = {}) => {
    version = opts.version ?? version + 1;
    const payload: NetworkConfigPayload = {
      version,
      blitzerEnabled: opts.blitzerEnabled ?? true,
      ...(opts.omitPolicy ? {} : { cameraPolicyByCountry: levels }),
      eventLogRetentionDaysDynamic: 3,
      eventLogRetentionDaysStatic: 30,
      minVersion: "0.1.0",
      excludedNodeIds: [],
      issuedAt: new Date().toISOString(),
    };
    writeFileSync(file, JSON.stringify(signEnvelope(payload, root)));
    return file;
  };

  return {
    dir,
    root,
    file,
    write,
    env: (overrides = {}) => ({
      NETWORK_CONFIG_PATH: file,
      NETWORK_ROOT_PUBLIC_KEY: root.publicKeyRaw,
      SPEED_CAMERA_NAMESPACE_ENABLED: "true",
      ...overrides,
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
