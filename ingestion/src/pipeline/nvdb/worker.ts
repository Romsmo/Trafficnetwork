import fs from "node:fs/promises";
import path from "node:path";
import type { Region } from "../../config/regions.js";
import type { Logger } from "../../logging.js";
import type { NormalizedRow, SourceWorker, WorkerContext, WorkerSection } from "../worker.js";
import { NvdbClient, RequestBudgetExhausted, type Municipality } from "./client.js";
import { loadSignMapping, mapSignCode, type SignMapping } from "./mapping.js";
import { normalizeNvdbSign } from "./normalize.js";

/**
 * Sign plates of Norway from NVDB (Statens vegvesen), license NLOD — docs/sources.md has the evidence and the
 * attribution wording. One resumable section per municipality; rows are one per plate, keyed by the plate's NVDB id.
 *
 * What is written next to the progress log, for the quality report and as provenance:
 *  - nvdb-no-meta.json: where the data came from, when, under which license, with which mapping table;
 *  - skips/<section>.json: per municipality, how many objects were fetched, imported, passed through, and why the rest was not imported.
 */

export const SERVER_FILTER_REASON = "not in the imported Skiltnummer series (left out by the server-side filter)";

/** Fewer implausible positions than this on a page are treated as stray bad data, not as a changed axis order. */
const MIN_PLATES_TO_SUSPECT_AXIS_ORDER = 5;

export interface SectionReport {
  section: string;
  municipality: string;
  /** Plates the municipality has in NVDB in total (before any series filter), when the API said. */
  totalPlates?: number;
  /** Plates the API delivered (after the server-side series filter, if one was used). */
  fetched: number;
  imported: number;
  passedThroughUnknownCode: number;
  /** Reason → count, for everything that was fetched but not imported. */
  notImported: Record<string, number>;
  finishedAt: string;
}

/** The server-side series filter: the enum ids the mapping wants. Absent (no filter) when it would not narrow anything. */
export function importableEnumIds(enumCodes: Map<number, string>, mapping: SignMapping): number[] | undefined {
  const ids: number[] = [];
  for (const [id, code] of enumCodes) if (!("skip" in mapSignCode(code, mapping))) ids.push(id);
  return ids.length === 0 || ids.length === enumCodes.size ? undefined : ids.sort((a, b) => a - b);
}

async function* rowsOfMunicipality(client: NvdbClient, municipality: Municipality, enumIds: number[] | undefined, enumCodes: Map<number, string>, mapping: SignMapping, sectionId: string, stateDir: string, logger: Logger): AsyncGenerator<NormalizedRow> {
  const report: SectionReport = { section: sectionId, municipality: municipality.navn, fetched: 0, imported: 0, passedThroughUnknownCode: 0, notImported: {}, finishedAt: "" };

  for await (const page of client.signPlatePages(municipality.nummer, enumIds)) {
    let importedInPage = 0;
    let coordinateProblems = 0;
    for (const object of page) {
      report.fetched++;
      const result = normalizeNvdbSign(object, { mapping, enumCodes });
      if ("skip" in result) {
        report.notImported[result.skip] = (report.notImported[result.skip] ?? 0) + 1;
        if (result.skip.startsWith("coordinates outside")) coordinateProblems++;
        continue;
      }
      report.imported++;
      importedInPage++;
      if (result.passedThrough) report.passedThroughUnknownCode++;
      yield result.row;
    }
    // Every plate of a page that reached the position check failed it: not stray bad data, the API's axis order or datum changed.
    if (coordinateProblems >= MIN_PLATES_TO_SUSPECT_AXIS_ORDER && importedInPage === 0) {
      throw new Error(`municipality ${municipality.navn}: all ${coordinateProblems} plates of a page that were checked have coordinates outside Norway — the axis order of the API probably changed; stopping instead of importing wrong positions`);
    }
  }

  // With a server-side series filter the API never delivers the plates of the left-out series, so they cannot be counted one by one;
  // the difference to the municipality's total is reported instead (a failed count request must not fail the import).
  if (enumIds) {
    const total = await client.signPlateCount(municipality.nummer).catch((err: unknown) => {
      if (err instanceof RequestBudgetExhausted) throw err;
      logger.warn({ section: sectionId, error: err instanceof Error ? err.message : String(err) }, "could not read the plate count of the municipality — the report will not show what the series filter left out");
      return undefined;
    });
    if (total !== undefined) {
      report.totalPlates = total;
      if (total > report.fetched) report.notImported[SERVER_FILTER_REASON] = total - report.fetched;
    }
  }

  report.finishedAt = new Date().toISOString();
  await fs.mkdir(path.join(stateDir, "skips"), { recursive: true });
  await fs.writeFile(path.join(stateDir, "skips", `${sectionId}.json`), JSON.stringify(report, null, 2));
  logger.debug({ section: sectionId, fetched: report.fetched, imported: report.imported }, "NVDB municipality read");
}

function requireSettings(ctx: WorkerContext): NonNullable<WorkerContext["env"]> {
  if (!ctx.env) throw new Error("the nvdb-no worker needs the environment configuration (WorkerContext.env)");
  return ctx.env;
}

export function unsupportedReason(region: Region): string | undefined {
  return region.officialSources?.includes("nvdb-no") ? undefined : 'the region does not list "nvdb-no" in its officialSources (config/regions.json)';
}

async function* runSections(ctx: WorkerContext): AsyncGenerator<WorkerSection> {
  const env = requireSettings(ctx);
  const { regionId, region, logger, stateDir } = ctx;
  const reason = unsupportedReason(region);
  if (reason) throw new Error(`Cannot import NVDB Norway into region "${regionId}": ${reason}`);

  const mapping = loadSignMapping(env.NVDB_NO_MAPPING_PATH);
  const client = new NvdbClient({
    baseUrl: env.NVDB_NO_BASE_URL,
    clientId: env.NVDB_NO_CLIENT_ID,
    contact: env.NVDB_NO_CONTACT,
    minRequestIntervalMs: env.NVDB_NO_MIN_REQUEST_INTERVAL_MS,
    maxRequests: env.NVDB_NO_MAX_REQUESTS,
    http: { timeoutMs: 120_000, backoff: { baseMs: env.HTTP_BACKOFF_BASE_MS, maxMs: env.HTTP_BACKOFF_MAX_MS, maxRetries: env.HTTP_MAX_RETRIES } },
    logger,
  });

  const definition = await client.signPlateDefinition();
  const municipalities = await client.municipalities();
  const enumIds = importableEnumIds(definition.enumCodes, mapping);

  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "nvdb-no-meta.json"),
    JSON.stringify(
      {
        regionId,
        source: mapping.source,
        apiBaseUrl: env.NVDB_NO_BASE_URL,
        objectType: "96 Skiltplate",
        license: mapping.sourceLicense,
        attribution: "Inneholder data under norsk lisens for offentlige data (NLOD) tilgjengeliggjort av Statens vegvesen.",
        mappingSeries: Object.fromEntries(Object.entries(mapping.series).map(([key, s]) => [key, s.import])),
        mappingCodeOverrides: mapping.codes,
        enumValues: definition.enumCodes.size,
        serverSideFilterEnumIds: enumIds?.length ?? null,
        municipalities: municipalities.length,
        recordedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  logger.info({ regionId, municipalities: municipalities.length, skiltnummerValues: definition.enumCodes.size, serverSideFilter: enumIds?.length ?? "none" }, "NVDB Norway: importing sign plates by municipality");

  let index = 0;
  for (const municipality of municipalities) {
    index++;
    const id = `kommune-${String(municipality.nummer).padStart(4, "0")}`;
    yield { id, index, total: municipalities.length, rows: rowsOfMunicipality(client, municipality, enumIds, definition.enumCodes, mapping, id, stateDir, logger) };
  }
  logger.info({ requests: client.requestCount }, "NVDB Norway: all municipalities read");
}

export const nvdbNoWorker: SourceWorker = {
  id: "nvdb-no",
  supportsRegion: (region) => unsupportedReason(region),
  runSections,
  async *run(ctx: WorkerContext): AsyncGenerator<NormalizedRow> {
    for await (const section of runSections(ctx)) yield* section.rows;
  },
};
