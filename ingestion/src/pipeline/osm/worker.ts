import path from "node:path";
import type { NormalizedRow, SourceWorker, WorkerContext } from "../worker.js";
import { downloadExtract } from "./download.js";
import { readGeojsonSeq } from "./geojsonseq-reader.js";
import { normalizeFeature } from "./normalize.js";
import { filterAndExport } from "./osmium.js";

export const osmWorker: SourceWorker = {
  id: "osm",

  async *run(ctx: WorkerContext): AsyncGenerator<NormalizedRow> {
    const { regionId, region, logger, downloadDir } = ctx;

    const pbfPath = await downloadExtract(regionId, region, downloadDir, logger);

    const workDir = path.join(downloadDir, `${regionId}-osmium-work`);
    const { geojsonseqPath, osmiumVersion } = await filterAndExport(pbfPath, workDir, logger);
    logger.info({ regionId, osmiumVersion }, "osmium filter+export complete — normalizing stream");

    let featureCount = 0;
    let rowCount = 0;
    for await (const feature of readGeojsonSeq(geojsonseqPath)) {
      featureCount++;
      for (const row of normalizeFeature(feature, logger)) {
        rowCount++;
        yield row;
      }
    }
    logger.info({ regionId, featureCount, rowCount }, "OSM normalization complete");
  },
};
