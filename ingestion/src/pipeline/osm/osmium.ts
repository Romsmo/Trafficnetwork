import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../logging.js";

export interface OsmiumExportResult {
  geojsonseqPath: string;
  osmiumVersion: string;
}

/**
 * Filters `pbfPath` down to the tag-relevant subset (ways with `highway`,
 * nodes/ways with `traffic_sign`, fixed-camera nodes) and exports it as a
 * geojsonseq stream (RFC 8142: one RS-prefixed GeoJSON Feature per line,
 * `osmium export`'s doc — see docs/sources.md for the tool comparison this
 * choice is based on) into `workDir`. Two osmium subprocesses, not one — a
 * standard osmium-tool pattern: `tags-filter` bounds memory/time for the
 * `export` pass that follows.
 */
export async function filterAndExport(pbfPath: string, workDir: string, logger: Logger): Promise<OsmiumExportResult> {
  await fs.mkdir(workDir, { recursive: true });
  const osmiumVersion = await getOsmiumVersion(logger);

  const filteredPath = path.join(workDir, "filtered.osm.pbf");
  const geojsonseqPath = path.join(workDir, "export.geojsonseq");

  await runOsmium(
    ["tags-filter", pbfPath, "w/highway", "nw/traffic_sign", "n/highway=speed_camera", "-o", filteredPath, "--overwrite"],
    logger,
    "tags-filter",
  );
  // -a type,id: puts the OSM element's type ("node"/"way"/"relation") and
  // numeric id on each feature as properties["@type"]/["@id"] — the only
  // stable identifier this pipeline has for dedup keys (state/store.ts).
  // Confirmed field names/shape against a real osmium-tool example
  // (properties["@id"] as a plain number) rather than assumed from the
  // manual page alone — see osmcode/osmium-tool#218 discussion.
  await runOsmium(["export", filteredPath, "--output-format=geojsonseq", "-a", "type,id", "-o", geojsonseqPath, "--overwrite"], logger, "export");

  await fs.unlink(filteredPath).catch(() => {});

  return { geojsonseqPath, osmiumVersion };
}

async function getOsmiumVersion(logger: Logger): Promise<string> {
  const output = await runOsmium(["--version"], logger, "--version");
  const firstLine = output.split("\n")[0]?.trim() ?? "unknown";
  logger.info({ osmiumVersion: firstLine }, "osmium-tool version (recorded for provenance, not enforced)");
  return firstLine;
}

function runOsmium(args: string[], logger: Logger, step: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("osmium", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `osmium-tool not found on PATH (step "${step}"). Install it (Ubuntu/CI: "apt-get install osmium-tool"; see https://osmcode.org/osmium-tool/ for other platforms) — this program shells out to the real osmium CLI rather than reimplementing PBF parsing.`,
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`osmium ${step} failed (exit ${code}): ${stderr.trim() || "no stderr output"}`));
        return;
      }
      resolve(stdout);
    });
  });
}
