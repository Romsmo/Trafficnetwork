import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../logging.js";
import type { NormalizedRow, SourceWorker, WorkerContext, WorkerSection } from "../worker.js";
import { downloadExtract } from "./download.js";
import { readGeojsonSeq } from "./geojsonseq-reader.js";
import { IMPLICIT_SPEEDS_SOURCE } from "./implicit-speeds.generated.js";
import { normalizeFeature } from "./normalize.js";
import { filterAndSplit, OSM_TAG_FILTER } from "./osmium.js";

async function* rowsOfSection(filePath: string, sectionId: string, logger: Logger): AsyncGenerator<NormalizedRow> {
  let featureCount = 0;
  let rowCount = 0;
  for await (const feature of readGeojsonSeq(filePath)) {
    featureCount++;
    for (const row of normalizeFeature(feature, logger)) {
      rowCount++;
      yield row;
    }
  }
  logger.debug({ section: sectionId, featureCount, rowCount }, "OSM section normalization complete");
}

async function* runSections(ctx: WorkerContext): AsyncGenerator<WorkerSection> {
  const { regionId, region, logger, downloadDir, stateDir, indexDir } = ctx;

  const download = await downloadExtract(regionId, region, downloadDir, logger);

  const workDir = path.join(downloadDir, `${regionId}-osmium-work`);
  const tileDegrees = region.sections?.tileDegrees ?? null;
  const result = await filterAndSplit(download.filePath, workDir, { tileDegrees, inputMd5: download.md5, indexDir }, logger);

  // Provenance of what was imported: the exact edition (file, size, checksum, timestamps) and how it
  // was processed. The server's rows carry only source=osm / ODbL, so this file (and the run report
  // built from it) is where the edition is recorded. The replication header is also what a later
  // "apply only the changes" run starts from (docs/europe-feasibility.md §11).
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "extract-meta.json"),
    JSON.stringify(
      {
        regionId,
        regionName: region.name,
        extractUrl: download.url,
        sizeBytes: download.sizeBytes,
        md5: download.md5,
        lastModified: download.lastModified,
        replication: result.header,
        osmiumVersion: result.osmiumVersion,
        osmiumPeakRssKb: result.peakRssKb,
        tagFilter: OSM_TAG_FILTER,
        tileDegrees,
        sectionCount: result.manifest.sections.length,
        featureCount: result.manifest.totalFeatures,
        implicitSpeedsSource: IMPLICIT_SPEEDS_SOURCE,
        license: "ODbL 1.0 — © OpenStreetMap contributors",
        recordedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  logger.info({ regionId, osmiumVersion: result.osmiumVersion, sections: result.manifest.sections.length, features: result.manifest.totalFeatures }, "osmium filter+split complete — importing sections");

  let index = 0;
  for (const section of result.manifest.sections) {
    index++;
    yield { id: section.id, index, total: result.manifest.sections.length, rows: rowsOfSection(path.join(result.sectionsDir, section.file), section.id, logger) };
  }
}

export const osmWorker: SourceWorker = {
  id: "osm",
  runSections,
  async *run(ctx: WorkerContext): AsyncGenerator<NormalizedRow> {
    for await (const section of runSections(ctx)) yield* section.rows;
  },
};
