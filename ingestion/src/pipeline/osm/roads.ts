import { gridDisk, latLngToCell } from "h3-js";
import type { Logger } from "../../logging.js";
import type { RoadWayRow } from "../../api/types.js";
import type { OsmFeature } from "./normalize.js";

/**
 * The road network (server `docs/road-network.md`): the drivable ways of an extract, so the node can tie signs, cameras and
 * community limits to a road and can find the road two picked points lie on. A separate run (`--roads`), not part of the speed
 * information import: it needs every drivable way (≈99 M in Europe), which the speed filter deliberately leaves out.
 */
export const ROAD_HIGHWAYS = [
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "road",
  "track",
] as const;

/** `osmium tags-filter` expression for the drivable ways. Must stay the list of the server's `DRIVABLE_HIGHWAYS`. */
export const ROAD_TAG_FILTER: readonly string[] = [`w/highway=${ROAD_HIGHWAYS.join(",")}`];

const DRIVABLE = new Set<string>(ROAD_HIGHWAYS);

/** Resolution of the coverage cells (the server's `COVERAGE_RESOLUTION`; edge ≈ 460 m). */
export const COVERAGE_RESOLUTION = 8;

/** One exported way → a row for `POST /v1/bulk-import/roads`, or `undefined` for what is not a drivable line. */
export function normalizeRoadFeature(feature: OsmFeature): RoadWayRow | undefined {
  const tags = feature.properties;
  if (tags["@type"] !== "way") return undefined;
  const id = tags["@id"];
  if (typeof id !== "number" && typeof id !== "string") return undefined;
  const highway = typeof tags.highway === "string" ? tags.highway : undefined;
  if (!highway || !DRIVABLE.has(highway)) return undefined;
  if (feature.geometry.type !== "LineString" || !Array.isArray(feature.geometry.coordinates)) return undefined;
  const coordinates = (feature.geometry.coordinates as unknown[]).filter(
    (c): c is [number, number] => Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number",
  );
  if (coordinates.length < 2) return undefined;
  const row: RoadWayRow = { externalId: `w${id}`, lineString: coordinates, highway };
  if (typeof tags.name === "string" && tags.name.length > 0) row.name = tags.name.slice(0, 200);
  if (typeof tags.ref === "string" && tags.ref.length > 0) row.ref = tags.ref.slice(0, 100);
  return row;
}

/**
 * Which areas (H3 cells of resolution 8) the import holds the road network of *completely*.
 *
 * Nothing in an extract says where its border is, and the server marks a sign "off the road" only in an area it knows complete
 * (a wrongly "complete" border area would hide real signs). So an area counts when the roads touch it **and every neighbour
 * around it**: at the border of the extract there are cells without a single road vertex next to the cells of the outermost
 * roads, and those are left out. What is left out is not wrong - it is "not known", looked at again when the area is covered
 * some other way (the node's own road lookup), and the items in it stay delivered meanwhile.
 */
export class CoverageTracker {
  private readonly cells = new Set<string>();

  /** Marks the cells a way passes through (vertices, and points every ~200 m along long segments). */
  addLine(coordinates: readonly [number, number][]): void {
    for (let i = 0; i < coordinates.length; i += 1) {
      const [lng, lat] = coordinates[i]!;
      this.cells.add(latLngToCell(lat, lng, COVERAGE_RESOLUTION));
      const next = coordinates[i + 1];
      if (!next) continue;
      const metres = Math.hypot((next[1] - lat) * 111_320, (next[0] - lng) * 111_320 * Math.cos((lat * Math.PI) / 180));
      const steps = Math.floor(metres / 200);
      for (let s = 1; s <= steps; s += 1) {
        const f = s / (steps + 1);
        this.cells.add(latLngToCell(lat + (next[1] - lat) * f, lng + (next[0] - lng) * f, COVERAGE_RESOLUTION));
      }
    }
  }

  get touched(): number {
    return this.cells.size;
  }

  /** The cells whose whole neighbourhood has roads. */
  complete(): string[] {
    const out: string[] = [];
    for (const cell of this.cells) {
      let all = true;
      for (const neighbour of gridDisk(cell, 1)) {
        if (!this.cells.has(neighbour)) {
          all = false;
          break;
        }
      }
      if (all) out.push(cell);
    }
    return out;
  }
}

export interface RoadPoster {
  postRoadWays(rows: RoadWayRow[]): Promise<{ inserted: number }>;
  postRoadCoverage(tiles: string[]): Promise<{ covered: number }>;
}

export interface RoadImportReport {
  featuresRead: number;
  waysSent: number;
  skipped: number;
  coverageCells: number;
  coverageSent: number;
}

const MAX_BATCH_ROWS = 1000;
/** The server's body limit is 1 MiB; a batch is cut well before it. */
const MAX_BATCH_BYTES = 600_000;
const COVERAGE_CHUNK = 5000;

/**
 * Posts every drivable way of `features`, then the complete areas. Idempotent on the server (an upsert per OSM way id), so a
 * re-run or a retry after a lost response changes nothing.
 */
export async function importRoads(
  features: AsyncIterable<OsmFeature>,
  poster: RoadPoster,
  options: { dryRun: boolean; logger: Logger; progressEvery?: number },
): Promise<RoadImportReport> {
  const { logger, dryRun } = options;
  const progressEvery = options.progressEvery ?? 200_000;
  const tracker = new CoverageTracker();
  const report: RoadImportReport = { featuresRead: 0, waysSent: 0, skipped: 0, coverageCells: 0, coverageSent: 0 };
  let batch: RoadWayRow[] = [];
  let bytes = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    if (!dryRun) {
      const answer = await poster.postRoadWays(batch);
      if (answer.inserted !== batch.length) throw new Error(`the server took ${answer.inserted} of ${batch.length} ways - stopping rather than going on`);
    }
    report.waysSent += batch.length;
    batch = [];
    bytes = 0;
  };

  for await (const feature of features) {
    report.featuresRead += 1;
    const row = normalizeRoadFeature(feature);
    if (!row) {
      report.skipped += 1;
      continue;
    }
    tracker.addLine(row.lineString);
    batch.push(row);
    bytes += 60 + row.lineString.length * 26 + (row.name?.length ?? 0) + (row.ref?.length ?? 0);
    if (batch.length >= MAX_BATCH_ROWS || bytes >= MAX_BATCH_BYTES) await flush();
    if (report.featuresRead % progressEvery === 0) logger.info({ read: report.featuresRead, sent: report.waysSent, cells: tracker.touched }, "road import progress");
  }
  await flush();

  const complete = tracker.complete();
  report.coverageCells = complete.length;
  for (let i = 0; i < complete.length; i += COVERAGE_CHUNK) {
    const chunk = complete.slice(i, i + COVERAGE_CHUNK);
    if (!dryRun) await poster.postRoadCoverage(chunk);
    report.coverageSent += chunk.length;
  }
  logger.info({ ...report, dryRun }, "road import finished");
  return report;
}
