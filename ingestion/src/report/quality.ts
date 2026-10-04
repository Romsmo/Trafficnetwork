import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FeedReport } from "../pipeline/roadworks/run-roadworks.js";
import type { SectionReport } from "../pipeline/nvdb/worker.js";
import { StateStore } from "../state/store.js";

/**
 * The per-source quality report (work order "addon-source-catalogue" (kept outside the repo) §3.4): for every source that ran, what was taken over,
 * what was discarded and why, what was merged into another source's record. It is built only from what the importers recorded in
 * STATE_DIR while they ran — nothing is recomputed or guessed here — so it can be produced at any time, also long after a run.
 *
 *  - roadworks feeds: STATE_DIR/roadworks/<feed>.report.json, written by every poll pass;
 *  - official sign sources (nvdb-no): STATE_DIR/<region>/<source>/skips/<section>.json, written per section;
 *  - OSM: STATE_DIR/<region>/osm/sections/*.json (what each section delivered). The per-reason skip counts of the OSM normalizer are
 *    not persisted, only logged: scripts/europe-run-report.mts reads them from the import log.
 */

export interface SourceQuality {
  /** Stable id: a roadworks feed id, or "<source>@<region>". */
  id: string;
  kind: "roadworks-feed" | "official-signs" | "osm";
  label: string;
  /** Records taken over (for roadworks: the roadworks sent in the last pass — what is currently active). */
  imported: number;
  /** Records seen but not taken over, with the reasons in `discardReasons`. */
  discarded: number;
  /** Records left out because another source already describes the same thing. */
  merged: number;
  discardReasons: Record<string, number>;
  status: string;
  notes: string[];
}

export interface QualityFilter {
  region?: string;
  source?: string;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function roadworksQuality(stateDir: string): Promise<SourceQuality[]> {
  const dir = path.join(stateDir, "roadworks");
  if (!existsSync(dir)) return [];
  const result: SourceQuality[] = [];
  for (const name of (await fs.readdir(dir)).filter((n) => n.endsWith(".report.json")).sort()) {
    const report = await readJson<FeedReport>(path.join(dir, name));
    if (!report) continue;
    const notes: string[] = [];
    if (report.server) notes.push(`server: ${report.server.created} created, ${report.server.reactivated} reactivated, ${report.server.updated} changed, ${report.server.refreshed} unchanged, ${report.server.skippedEnded} already ended`);
    if (report.retired !== undefined) notes.push(`${report.retired} roadworks no longer in the feed were ended on the server`);
    if (report.retireSkippedBecause) notes.push(`nothing ended on the server this pass: ${report.retireSkippedBecause}`);
    for (const [caveat, count] of Object.entries(report.sentWithCaveat)) notes.push(`${count} sent with a timing detail not evaluated (${caveat})`);
    if (report.publishedAt) notes.push(`the feed's own publication time: ${report.publishedAt}`);
    if (report.error) notes.push(`error: ${report.error}`);
    result.push({
      id: report.feedId,
      kind: "roadworks-feed",
      label: `roadworks feed ${report.feedId}`,
      imported: report.sent,
      discarded: Object.values(report.notImported).reduce((a, b) => a + b, 0),
      merged: report.mergedIntoOtherFeed,
      discardReasons: report.notImported,
      status: `${report.status} (${report.finishedAt})`,
      notes,
    });
  }
  return result;
}

async function regionSourceDirs(stateDir: string, filter: QualityFilter): Promise<{ region: string; source: string; dir: string }[]> {
  if (!existsSync(stateDir)) return [];
  const found: { region: string; source: string; dir: string }[] = [];
  for (const region of await fs.readdir(stateDir, { withFileTypes: true })) {
    if (!region.isDirectory() || region.name === "roadworks" || (filter.region && region.name !== filter.region)) continue;
    for (const source of await fs.readdir(path.join(stateDir, region.name), { withFileTypes: true })) {
      if (!source.isDirectory() || (filter.source && source.name !== filter.source)) continue;
      found.push({ region: region.name, source: source.name, dir: path.join(stateDir, region.name, source.name) });
    }
  }
  return found;
}

async function officialSignsQuality(stateDir: string, region: string, source: string, dir: string): Promise<SourceQuality | undefined> {
  const skipsDir = path.join(dir, "skips");
  if (!existsSync(skipsDir)) return undefined;
  const sections: SectionReport[] = [];
  for (const name of (await fs.readdir(skipsDir)).filter((n) => n.endsWith(".json")).sort()) {
    const report = await readJson<SectionReport>(path.join(skipsDir, name));
    if (report) sections.push(report);
  }
  const reasons: Record<string, number> = {};
  let imported = 0;
  let totalPlates = 0;
  let passedThrough = 0;
  for (const s of sections) {
    imported += s.imported;
    totalPlates += s.totalPlates ?? s.fetched;
    passedThrough += s.passedThroughUnknownCode;
    for (const [reason, count] of Object.entries(s.notImported)) reasons[reason] = (reasons[reason] ?? 0) + count;
  }
  const store = new StateStore(stateDir, region, source);
  const quarantined = await store.countQuarantined();
  const meta = await readJson<{ license?: string; attribution?: string; municipalities?: number; recordedAt?: string }>(path.join(dir, `${source}-meta.json`));
  const notes = [`${sections.length}${meta?.municipalities ? ` of ${meta.municipalities}` : ""} sections read, ${totalPlates} objects in the source for them`];
  if (passedThrough > 0) notes.push(`${passedThrough} taken over with a code the mapping table does not know (passed through unchanged)`);
  if (quarantined > 0) notes.push(`${quarantined} rows quarantined (rejected by validation or the server) — see quarantine.ndjson`);
  if (meta?.license) notes.push(`license: ${meta.license}`);
  return {
    id: `${source}@${region}`,
    kind: "official-signs",
    label: `${source} (${region})`,
    imported,
    discarded: Object.values(reasons).reduce((a, b) => a + b, 0) + quarantined,
    merged: 0,
    discardReasons: quarantined > 0 ? { ...reasons, "quarantined: rejected by validation or by the server": quarantined } : reasons,
    status: store.isComplete() ? "complete" : "incomplete (resumable)",
    notes,
  };
}

async function osmQuality(stateDir: string, region: string, dir: string): Promise<SourceQuality | undefined> {
  const store = new StateStore(stateDir, region, "osm");
  const sections = await store.readSectionStats();
  if (sections.length === 0 && !existsSync(path.join(dir, "progress.ndjson"))) return undefined;
  const byKind: Record<string, number> = {};
  let quarantined = 0;
  for (const s of sections) {
    quarantined += s.quarantined;
    for (const [kind, n] of Object.entries(s.insertedByKind)) byKind[kind] = (byKind[kind] ?? 0) + n;
  }
  const meta = await readJson<{ license?: string; extractUrl?: string; lastModified?: string }>(path.join(dir, "extract-meta.json"));
  const notes = [`${sections.length} sections finished; imported by kind: ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`];
  if (meta?.extractUrl) notes.push(`extract: ${meta.extractUrl}${meta.lastModified ? ` (${meta.lastModified})` : ""}`);
  notes.push("reasons for OSM elements that were skipped by the normalizer are only in the import log (scripts/europe-run-report.mts)");
  return {
    id: `osm@${region}`,
    kind: "osm",
    label: `osm (${region})`,
    imported: Object.values(byKind).reduce((a, b) => a + b, 0),
    discarded: quarantined,
    merged: 0,
    discardReasons: quarantined > 0 ? { "quarantined: rejected by validation or by the server": quarantined } : {},
    status: store.isComplete() ? "complete" : "incomplete (resumable)",
    notes,
  };
}

export async function collectSourceQuality(stateDir: string, filter: QualityFilter = {}): Promise<SourceQuality[]> {
  const items: SourceQuality[] = [];
  if (!filter.region && !filter.source) items.push(...(await roadworksQuality(stateDir)));
  for (const { region, source, dir } of await regionSourceDirs(stateDir, filter)) {
    const item = source === "osm" ? await osmQuality(stateDir, region, dir) : await officialSignsQuality(stateDir, region, source, dir);
    if (item) items.push(item);
  }
  return items;
}

export function renderQualityMarkdown(items: SourceQuality[], generatedAt: Date): string {
  const lines: string[] = [`# Source quality report`, ``, `Generated ${generatedAt.toISOString()} from the importers' own records (STATE_DIR).`, ``];
  if (items.length === 0) return lines.concat(["No source has run yet: nothing recorded."]).join("\n") + "\n";

  lines.push(`| Source | Status | Taken over | Discarded | Merged into another source |`, `|---|---|---:|---:|---:|`);
  for (const item of items) lines.push(`| ${item.label} | ${item.status} | ${item.imported} | ${item.discarded} | ${item.merged} |`);
  for (const item of items) {
    lines.push(``, `## ${item.label}`, ``);
    const reasons = Object.entries(item.discardReasons).sort((a, b) => b[1] - a[1]);
    if (reasons.length > 0) lines.push(`Discarded, by reason:`, ``, ...reasons.map(([reason, count]) => `- ${count} × ${reason}`), ``);
    else lines.push(`Nothing was discarded.`, ``);
    if (item.merged > 0) lines.push(`- ${item.merged} left out because another source already describes the same roadwork`);
    for (const note of item.notes) lines.push(`- ${note}`);
  }
  return lines.join("\n") + "\n";
}
