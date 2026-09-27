import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { Logger } from "../../logging.js";
import { readSectionManifest, splitIntoSections, writeSectionManifest, type SectionManifest } from "./sections.js";

/**
 * The tag filter, as `osmium tags-filter` expressions. Only what normalize.ts can turn into a row:
 *  - ways with `maxspeed` (explicit) or `maxspeed:type` / `source:maxspeed` (implicit limits),
 *  - nodes/ways with `traffic_sign`,
 *  - fixed camera nodes.
 * The earlier `w/highway` selected every road (≈99 M ways in Europe, ≈53 GB of GeoJSON) although
 * >85 % carry no speed information; on the Bayern extract both filters produce byte-identical
 * normalized rows (docs/europe-feasibility.md §3). Ways with `maxspeed` but no `highway`
 * (railways, …) pass the filter and are dropped in normalize.ts.
 */
export const OSM_TAG_FILTER: readonly string[] = ["w/maxspeed,maxspeed:type,source:maxspeed", "nw/traffic_sign", "n/highway=speed_camera"];

export interface ExtractHeader {
  replicationTimestamp?: string;
  replicationSequence?: number;
  replicationBaseUrl?: string;
}

export interface FilterAndSplitOptions {
  /** Tile size in degrees for the geographic sections, or null for one section. */
  tileDegrees: number | null;
  /** md5 of the input extract (from download.ts). Ties reusable intermediate results to exactly this edition. */
  inputMd5: string;
  /** Where the osmium node-location index lives. It is randomly accessed (≈16 B per node), so put it on an SSD. Default: workDir. */
  indexDir?: string;
}

export interface FilterAndSplitResult {
  manifest: SectionManifest;
  sectionsDir: string;
  osmiumVersion: string;
  header: ExtractHeader;
  /** True when a complete, matching set of sections already existed and osmium was not run again. */
  reused: boolean;
  /** Peak resident memory per osmium step in kB, when `/usr/bin/time` is available. */
  peakRssKb: Record<string, number>;
}

interface FilteredMarker {
  inputMd5: string;
  filter: string;
}

/**
 * Filters `pbfPath` down to the relevant tags and splits the geojsonseq export into geographic
 * sections under `workDir/sections`. Two osmium processes, not one — a standard pattern:
 * `tags-filter` bounds memory/time for the `export` pass that follows. The export streams through
 * a pipe into the splitter, so the unsplit GeoJSON never exists on disk.
 *
 * Resumable at both stages: a finished `filtered.osm.pbf` (marker file) skips the filter pass on a
 * retry, and a complete section manifest for the same input and filter skips both. On a continent the
 * filter pass alone is 10–20 minutes, so these skips matter after an abort.
 */
export async function filterAndSplit(pbfPath: string, workDir: string, options: FilterAndSplitOptions, logger: Logger): Promise<FilterAndSplitResult> {
  await fs.mkdir(workDir, { recursive: true });
  const osmiumVersion = await getOsmiumVersion(logger);
  const header = await readHeader(pbfPath, logger);

  const sectionsDir = path.join(workDir, "sections");
  const filterText = OSM_TAG_FILTER.join(" ");
  const peakRssKb: Record<string, number> = {};

  const existing = await readSectionManifest(sectionsDir);
  if (existing && existing.inputMd5 === options.inputMd5 && existing.filter === filterText && existing.tileDegrees === options.tileDegrees) {
    logger.info({ sections: existing.sections.length, features: existing.totalFeatures }, "complete sections for this edition already exist — skipping osmium");
    return { manifest: existing, sectionsDir, osmiumVersion, header, reused: true, peakRssKb };
  }

  const filteredPath = path.join(workDir, "filtered.osm.pbf");
  const filteredMarkerPath = path.join(workDir, "filtered.done.json");
  const marker = await readMarker(filteredMarkerPath);
  if (existsSync(filteredPath) && marker && marker.inputMd5 === options.inputMd5 && marker.filter === filterText) {
    logger.info("filtered extract from an earlier attempt is complete — skipping tags-filter");
  } else {
    await fs.rm(filteredMarkerPath, { force: true });
    logger.info({ filter: filterText }, "osmium tags-filter started (two passes over the input; minutes for a continent)");
    const step = await runOsmium(["tags-filter", pbfPath, ...OSM_TAG_FILTER, "-o", filteredPath, "--overwrite"], logger, "tags-filter");
    if (step.peakRssKb) peakRssKb["tags-filter"] = step.peakRssKb;
    await fs.writeFile(filteredMarkerPath, JSON.stringify({ inputMd5: options.inputMd5, filter: filterText } satisfies FilteredMarker));
  }

  // -a type,id: puts the OSM element's type ("node"/"way"/"relation") and numeric id on each feature
  // as properties["@type"]/["@id"] — the only stable identifier this pipeline has for dedup keys.
  // sparse_file_array keeps the node-location index on disk instead of RAM: measured byte-identical
  // output at 0.19 GB instead of 0.16 GB RSS on Bayern, and bounded memory for ≈100 M nodes in Europe.
  const indexPath = path.join(options.indexDir ?? workDir, "node-locations.idx");
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const exportArgs = ["export", filteredPath, "-f", "geojsonseq", "-a", "type,id", `--index-type=sparse_file_array,${indexPath}`, "-o", "-"];

  logger.info("osmium export → sections started");
  const manifest = await runOsmiumStreaming(exportArgs, logger, "export", async (lines) => splitIntoSections(lines, sectionsDir, { tileDegrees: options.tileDegrees, inputMd5: options.inputMd5, filter: filterText }), peakRssKb);
  await writeSectionManifest(sectionsDir, manifest);

  await fs.unlink(filteredPath).catch(() => {});
  await fs.rm(filteredMarkerPath, { force: true });
  await fs.unlink(indexPath).catch(() => {});
  logger.info({ sections: manifest.sections.length, features: manifest.totalFeatures }, "sections written");

  return { manifest, sectionsDir, osmiumVersion, header, reused: false, peakRssKb };
}

async function getOsmiumVersion(logger: Logger): Promise<string> {
  const { stdout } = await runOsmium(["--version"], logger, "--version");
  const firstLine = stdout.split("\n")[0]?.trim() ?? "unknown";
  logger.info({ osmiumVersion: firstLine }, "osmium-tool version (recorded for provenance, not enforced)");
  return firstLine;
}

/** The replication header of the extract — what a later "apply only the changes" run starts from (docs/europe-feasibility.md §11). */
async function readHeader(pbfPath: string, logger: Logger): Promise<ExtractHeader> {
  const get = async (name: string): Promise<string | undefined> => {
    try {
      const value = (await runOsmium(["fileinfo", "-g", `header.option.${name}`, pbfPath], logger, `fileinfo ${name}`)).stdout.trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const sequence = await get("osmosis_replication_sequence_number");
  const header: ExtractHeader = {
    replicationTimestamp: await get("osmosis_replication_timestamp"),
    replicationSequence: sequence !== undefined && /^\d+$/.test(sequence) ? Number(sequence) : undefined,
    replicationBaseUrl: await get("osmosis_replication_base_url"),
  };
  logger.info({ header }, "extract replication header (recorded so a later run can fetch only the changes)");
  return header;
}

async function readMarker(filePath: string): Promise<FilteredMarker | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as FilteredMarker;
  } catch {
    return undefined;
  }
}

const TIME_BINARY = "/usr/bin/time";

function osmiumCommand(args: string[]): { command: string; args: string[]; measured: boolean } {
  // `time -v` reports the peak RSS of the child — recorded so the feasibility inference (bounded memory) is checked on the real run.
  if (existsSync(TIME_BINARY)) return { command: TIME_BINARY, args: ["-v", "osmium", ...args], measured: true };
  return { command: "osmium", args, measured: false };
}

function parsePeakRssKb(stderr: string): number | undefined {
  const match = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(stderr);
  return match ? Number(match[1]) : undefined;
}

function notFoundError(step: string): Error {
  return new Error(
    `osmium-tool not found on PATH (step "${step}"). Install it (Ubuntu/CI: "apt-get install osmium-tool"; see https://osmcode.org/osmium-tool/ for other platforms) — this program shells out to the real osmium CLI rather than reimplementing PBF parsing.`,
  );
}

function runOsmium(args: string[], logger: Logger, step: string): Promise<{ stdout: string; stderr: string; peakRssKb?: number }> {
  return new Promise((resolve, reject) => {
    const cmd = osmiumCommand(args);
    const child = spawn(cmd.command, cmd.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const heartbeat = startHeartbeat(logger, step);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearInterval(heartbeat);
      reject(err.code === "ENOENT" ? notFoundError(step) : err);
    });
    child.on("close", (code) => {
      clearInterval(heartbeat);
      const peakRssKb = cmd.measured ? parsePeakRssKb(stderr) : undefined;
      if (code !== 0) {
        reject(new Error(`osmium ${step} failed (exit ${code}): ${stderr.trim() || "no stderr output"}`));
        return;
      }
      if (peakRssKb) logger.info({ step, peakRssMB: Math.round(peakRssKb / 1024) }, "osmium step finished");
      resolve({ stdout, stderr, peakRssKb });
    });
  });
}

/** Runs osmium with its stdout consumed line by line by `consume`; fails if osmium exits non-zero even when the consumer finished. */
async function runOsmiumStreaming<T>(args: string[], logger: Logger, step: string, consume: (lines: AsyncIterable<string>) => Promise<T>, peakRssKb: Record<string, number>): Promise<T> {
  const cmd = osmiumCommand(args);
  const child = spawn(cmd.command, cmd.args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const heartbeat = startHeartbeat(logger, step);

  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", (err: NodeJS.ErrnoException) => reject(err.code === "ENOENT" ? notFoundError(step) : err));
    child.on("close", (code) => resolve(code));
  });
  // If osmium fails to start, `exited` rejects while we're still awaiting the consumer — attach a handler now so it is never "unhandled".
  exited.catch(() => {});

  try {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const result = await consume(lines);
    const code = await exited;
    if (code !== 0) throw new Error(`osmium ${step} failed (exit ${code}): ${stderr.trim() || "no stderr output"}`);
    const rss = cmd.measured ? parsePeakRssKb(stderr) : undefined;
    if (rss) {
      peakRssKb[step] = rss;
      logger.info({ step, peakRssMB: Math.round(rss / 1024) }, "osmium step finished");
    }
    return result;
  } catch (err) {
    child.kill();
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

function startHeartbeat(logger: Logger, step: string): NodeJS.Timeout {
  const startedAt = Date.now();
  const timer = setInterval(() => logger.info({ step, minutes: Math.round((Date.now() - startedAt) / 6000) / 10 }, "osmium still running"), 120_000);
  timer.unref();
  return timer;
}
