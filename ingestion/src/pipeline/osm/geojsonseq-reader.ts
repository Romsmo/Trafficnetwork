import { createReadStream } from "node:fs";
import readline from "node:readline";
import type { OsmFeature } from "./normalize.js";

/** RFC 8142's record separator prefixing every line of `osmium export --output-format=geojsonseq`'s output. */
const RECORD_SEPARATOR = "";

/** Streams a geojsonseq file feature-by-feature — never buffers the whole file, matching the memory/runtime budget decision in the P3.0 plan. */
export async function* readGeojsonSeq(filePath: string): AsyncGenerator<OsmFeature> {
  const rl = readline.createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const rawLine of rl) {
    const line = rawLine.startsWith(RECORD_SEPARATOR) ? rawLine.slice(1) : rawLine;
    if (!line.trim()) continue;
    yield JSON.parse(line) as OsmFeature;
  }
}
