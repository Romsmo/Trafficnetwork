import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * The per-country sign mapping table (config/sign-mappings/<cc>.json) — a file, not code, so a country's policy can be read,
 * reviewed and changed without touching the importer. What it decides for one national sign code:
 *
 *  - the value stored as `signType`: the country prefix plus the official code, verbatim (`NO:362.50`) — the same
 *    "country-prefixed catalog reference" the OSM import stores (server/docs/schema.md), so both sources speak one schema;
 *  - whether a sign of that series is imported at all (an information or wayfinding sign is not a hazard or regulation);
 *  - a code that matches no known series is NOT dropped: it is passed through unchanged (docs/prompt-addon-source-catalogue.md §3.3).
 */
const seriesSchema = z.object({
  name: z.string().min(1),
  import: z.boolean(),
  reason: z.string().optional(),
  examples: z.array(z.string()).optional(),
});

const mappingSchema = z.object({
  country: z.string().length(2),
  source: z.string().min(1),
  sourceLicense: z.string().min(1),
  codePrefix: z.string().regex(/^[A-Z]{2}:$/),
  codeSystem: z.string().min(1),
  seriesBasis: z.string().optional(),
  /** One capture group: the series key (first digit of the code, after an optional `U`). */
  seriesPattern: z.string().min(1),
  series: z.record(z.string(), seriesSchema),
  /** Exact-code overrides of the series decision. */
  codes: z.record(z.string(), z.object({ import: z.boolean(), reason: z.string().optional() })),
});

export interface SignMapping {
  country: string;
  source: string;
  sourceLicense: string;
  codePrefix: string;
  seriesPattern: RegExp;
  series: z.infer<typeof mappingSchema>["series"];
  codes: z.infer<typeof mappingSchema>["codes"];
}

const DEFAULT_MAPPING_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../../config/sign-mappings");

export function loadSignMapping(filePath: string = path.join(DEFAULT_MAPPING_DIR, "no.json")): SignMapping {
  const parsed = mappingSchema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid sign mapping at ${filePath}:\n${issues}`);
  }
  return { ...parsed.data, seriesPattern: new RegExp(parsed.data.seriesPattern) };
}

export type MappedSign = { signType: string; passedThrough: boolean } | { skip: string };

/** Maps one official code to the stored `signType`, or says why the sign is not imported. */
export function mapSignCode(code: string, mapping: SignMapping): MappedSign {
  const signType = `${mapping.codePrefix}${code}`;
  const override = mapping.codes[code];
  if (override) return override.import ? { signType, passedThrough: false } : { skip: `code ${code} excluded by the mapping table${override.reason ? ` (${override.reason})` : ""}` };

  const match = mapping.seriesPattern.exec(code);
  const series = match?.[1] !== undefined ? mapping.series[match[1]] : undefined;
  if (!match || !series) return { signType, passedThrough: true }; // unknown pattern or series: kept unchanged, never discarded
  return series.import ? { signType, passedThrough: false } : { skip: `series ${match[1]} not imported (${series.name})` };
}
