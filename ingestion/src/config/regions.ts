import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

const verificationPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  expectedKmh: z.number().positive(),
});

const regionSchema = z.object({
  name: z.string().min(1),
  geofabrikExtractUrl: z.string().url(),
  geofabrikChecksumUrl: z.string().url(),
  // [minLng, minLat, maxLng, maxLat] — used by verify.ts (P3.4) to compute
  // which H3 partitions to cross-check a completed import against. Sourced
  // from Geofabrik's own published boundary geometry, not hand-drawn.
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  // Optional, populated by an operator after manually confirming a real
  // known-limit coordinate post-import — never invented ahead of time.
  verificationPoints: z.array(verificationPointSchema).optional(),
});

const regionsFileSchema = z.object({
  regions: z.record(z.string(), regionSchema),
});

export type Region = z.infer<typeof regionSchema>;
export type RegionsFile = z.infer<typeof regionsFileSchema>;

const DEFAULT_REGIONS_PATH = path.resolve(fileURLToPath(import.meta.url), "../../../config/regions.json");

export function loadRegions(filePath: string = DEFAULT_REGIONS_PATH): RegionsFile {
  const raw = readFileSync(filePath, "utf8");
  const parsed = regionsFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid regions config at ${filePath}:\n${issues}`);
  }
  return parsed.data;
}

export function resolveRegion(regions: RegionsFile, regionId: string): Region {
  const region = regions.regions[regionId];
  if (!region) {
    const known = Object.keys(regions.regions).join(", ");
    throw new Error(`Unknown region "${regionId}" — must be one of: ${known}`);
  }
  return region;
}
