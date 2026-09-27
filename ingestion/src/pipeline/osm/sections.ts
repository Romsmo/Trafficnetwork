import { createWriteStream, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

/**
 * Splitting the exported GeoJSON-seq into geographic sections.
 *
 * Why: a Europe import takes hours. Sections give it independent, restartable units with their
 * own progress and completion marker, error isolation and a per-region report — what a
 * per-country download would give, without its coverage gaps and border-duplicated ways
 * (docs/europe-feasibility.md §5). Every feature goes to the tile that contains its FIRST
 * coordinate, so a way is never cut and lives in exactly one section.
 */

export interface SectionFileInfo {
  id: string;
  /** File name inside the sections directory. */
  file: string;
  features: number;
  /** [minLng, minLat, maxLng, maxLat] of the tile; absent for the single/"misc" section. */
  bbox?: [number, number, number, number];
}

export interface SectionManifest {
  tileDegrees: number | null;
  /** md5 of the input extract the sections were cut from — a manifest for a different edition is never reused. */
  inputMd5: string;
  filter: string;
  totalFeatures: number;
  sections: SectionFileInfo[];
  createdAt: string;
}

const COORDINATE_PATTERN = /^"coordinates":\s*\[+\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*,\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

/**
 * The first coordinate of a GeoJSON-seq feature line, read with a regex instead of a full JSON
 * parse (this runs over ≈16 M lines). osmium writes `geometry` before `properties`, so the first
 * `"coordinates":` belongs to the geometry; a tag literally named "coordinates" comes later.
 */
export function firstCoordinate(line: string): [number, number] | undefined {
  const at = line.indexOf('"coordinates":');
  if (at < 0) return undefined;
  const match = COORDINATE_PATTERN.exec(line.slice(at, at + 160));
  if (!match) return undefined;
  const lng = Number(match[1]);
  const lat = Number(match[2]);
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : undefined;
}

function cornerName(value: number): string {
  return String(value).replace("-", "m").replace(".", "p");
}

/** Tile id + bbox for a coordinate, e.g. `x10_y50` for 10.5°E 50.2°N with 10° tiles. */
export function tileFor(lng: number, lat: number, tileDegrees: number): { id: string; bbox: [number, number, number, number] } {
  const x = Math.floor((lng + 180) / tileDegrees);
  const y = Math.floor((lat + 90) / tileDegrees);
  const minLng = +(x * tileDegrees - 180).toFixed(6);
  const minLat = +(y * tileDegrees - 90).toFixed(6);
  return { id: `x${cornerName(minLng)}_y${cornerName(minLat)}`, bbox: [minLng, minLat, +(minLng + tileDegrees).toFixed(6), +(minLat + tileDegrees).toFixed(6)] };
}

export const SECTIONS_MANIFEST = "manifest.json";

/**
 * Writes every line to its tile file (`tileDegrees` null → one section "all"). Lines are copied
 * byte-for-byte (including the RFC 8142 record separator), so readGeojsonSeq reads a section file
 * exactly like the unsplit export. `sectionsDir` is wiped first: a half-written earlier attempt must
 * never mix with this one. The manifest is NOT written here (see writeSectionManifest).
 */
export async function splitIntoSections(
  lines: AsyncIterable<string>,
  sectionsDir: string,
  options: { tileDegrees: number | null; inputMd5: string; filter: string },
): Promise<SectionManifest> {
  await fs.rm(sectionsDir, { recursive: true, force: true });
  await fs.mkdir(sectionsDir, { recursive: true });

  interface Open {
    info: SectionFileInfo;
    stream: WriteStream;
  }
  const open = new Map<string, Open>();
  // Assigned from stream callbacks, which control-flow analysis cannot see — hence the cast instead of a bare declaration.
  let streamError = undefined as Error | undefined;

  const streamFor = (id: string, bbox?: [number, number, number, number]): Open => {
    let entry = open.get(id);
    if (!entry) {
      const file = `${id}.geojsonseq`;
      const stream = createWriteStream(path.join(sectionsDir, file));
      // A write error (disk full!) must fail the split, not surface as an unhandled 'error' event.
      stream.on("error", (err) => (streamError ??= err));
      entry = { info: { id, file, features: 0, ...(bbox ? { bbox } : {}) }, stream };
      open.set(id, entry);
    }
    return entry;
  };

  let totalFeatures = 0;
  for await (const line of lines) {
    if (streamError) throw streamError;
    if (line.trim().length === 0) continue;
    let target: Open;
    if (options.tileDegrees === null) {
      target = streamFor("all");
    } else {
      const coordinate = firstCoordinate(line);
      if (coordinate) {
        const tile = tileFor(coordinate[0], coordinate[1], options.tileDegrees);
        target = streamFor(tile.id, tile.bbox);
      } else {
        target = streamFor("misc");
      }
    }
    target.info.features++;
    totalFeatures++;
    if (!target.stream.write(line + "\n")) await once(target.stream, "drain");
  }

  await Promise.all([...open.values()].map((entry) => new Promise<void>((resolve) => entry.stream.end(() => resolve()))));
  if (streamError) throw streamError;

  return {
    tileDegrees: options.tileDegrees,
    inputMd5: options.inputMd5,
    filter: options.filter,
    totalFeatures,
    sections: [...open.values()].map((entry) => entry.info).sort((a, b) => a.id.localeCompare(b.id)),
    createdAt: new Date().toISOString(),
  };
}

/** Called only after the producer (osmium) exited cleanly: the manifest's existence means "complete and trustworthy". */
export async function writeSectionManifest(sectionsDir: string, manifest: SectionManifest): Promise<void> {
  await fs.writeFile(path.join(sectionsDir, SECTIONS_MANIFEST), JSON.stringify(manifest, null, 2));
}

export async function readSectionManifest(sectionsDir: string): Promise<SectionManifest | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(sectionsDir, SECTIONS_MANIFEST), "utf8")) as SectionManifest;
  } catch {
    return undefined;
  }
}
