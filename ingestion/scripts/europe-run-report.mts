/**
 * Collects the facts of an import run into a Markdown report skeleton from what the tool itself recorded:
 * the import log (pino JSON lines + the wrapper's own lines), extract-meta.json, sections/*.json, quarantine.ndjson.
 * Database numbers (row counts, size, spot checks) come from the SQL scripts next to this file and are added by hand.
 *
 *   npx tsx scripts/europe-run-report.mts <import.log> <state-dir>/<region>/osm  > report-part.md
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const [logPath, stateDir] = process.argv.slice(2);
if (!logPath || !stateDir) {
  console.error("usage: npx tsx scripts/europe-run-report.mts <import.log> <state-dir>/<region>/osm");
  process.exit(1);
}

function readText(file: string): string {
  const buffer = readFileSync(file);
  return buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString("utf16le") : buffer.toString("utf8");
}

interface Line {
  time?: number;
  msg?: string;
  [key: string]: unknown;
}

const lines: Line[] = [];
const wrapperLines: string[] = [];
for (const raw of readText(logPath).split(/\r?\n/)) {
  const text = raw.replace(/^﻿/, "").trim();
  if (text.startsWith("{")) {
    try {
      lines.push(JSON.parse(text) as Line);
    } catch {
      /* partial line */
    }
  } else if (text.includes("[run-europe]")) {
    wrapperLines.push(text);
  }
}

const first = (predicate: (l: Line) => boolean): Line | undefined => lines.find(predicate);
const last = (predicate: (l: Line) => boolean): Line | undefined => [...lines].reverse().find(predicate);
const fmt = (ms: number): string => {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min ${s % 60} s`;
};
const iso = (l?: Line): string => (l?.time ? new Date(l.time).toISOString().replace(".000Z", "Z") : "n/a");

const started = first((l) => l.msg === "starting (resuming from local progress state if any)");
const downloadDone = last((l) => l.msg === "download verified" || l.msg === "cached extract already verified against the published checksum — skipping download" || l.msg === "cached extract checksum matches — skipping download");
const tagsFilter = last((l) => l.msg === "osmium step finished" && l.step === "tags-filter");
const exportDone = last((l) => l.msg === "osmium step finished" && l.step === "export");
const sectionsWritten = last((l) => l.msg === "sections written");
const firstSection = first((l) => l.msg === "section started");
const finished = last((l) => l.msg === "run finished");
const attempts = wrapperLines.filter((l) => /attempt \d+: starting/.test(l)).length;
const interruptions = wrapperLines.filter((l) => /exited with code (?!0\b)/.test(l));

console.log("### Timeline (from the import log)\n");
console.log("| Event | Time (UTC) |\n|---|---|");
console.log(`| First start | ${iso(started)} |`);
console.log(`| Download verified | ${iso(downloadDone)} |`);
console.log(`| osmium tags-filter finished | ${iso(tagsFilter)} (peak RSS ${tagsFilter?.peakRssMB ?? "n/a"} MB) |`);
console.log(`| osmium export finished | ${iso(exportDone)} (peak RSS ${exportDone?.peakRssMB ?? "n/a"} MB) |`);
console.log(`| Sections written | ${iso(sectionsWritten)} (${sectionsWritten?.sections ?? "?"} sections, ${sectionsWritten?.features ?? "?"} features) |`);
console.log(`| First section started | ${iso(firstSection)} |`);
console.log(`| Run finished | ${iso(finished)} |`);
if (started?.time && finished?.time) console.log(`\nWall clock first start → finish: **${fmt(finished.time - started.time)}** (includes waiting time between interrupted attempts).`);
if (downloadDone?.time && started?.time) console.log(`Download phase (first start → verified): ${fmt(downloadDone.time - started.time)}`);
if (firstSection?.time && finished?.time) console.log(`Import phase (first section → finish): ${fmt(finished.time - firstSection.time)}`);
console.log(`\nAttempts of the wrapper: ${attempts}; non-zero exits (interruptions): ${interruptions.length}.`);
for (const l of interruptions) console.log(`- ${l}`);

const retries = lines.filter((l) => l.msg === "retrying request after transient failure").length;
const downloadInterruptions = lines.filter((l) => l.msg === "download interrupted — will resume from the current offset").length;
const quarantinedWarnings = lines.filter((l) => l.msg === "row quarantined (not imported) — see quarantine.ndjson").length;
const bisects = lines.filter((l) => typeof l.msg === "string" && l.msg.startsWith("server rejected the batch (400)")).length;
console.log(`\nHTTP retries with backoff: ${retries}; download interruptions resumed: ${downloadInterruptions}; batches bisected after a 400: ${bisects}; rows quarantined (log lines): ${quarantinedWarnings}.`);

const metaPath = path.join(stateDir, "extract-meta.json");
if (existsSync(metaPath)) {
  const meta = JSON.parse(readText(metaPath)) as Record<string, unknown>;
  console.log("\n### Edition (extract-meta.json)\n");
  console.log("```json\n" + JSON.stringify({ ...meta, license: undefined, implicitSpeedsSource: undefined }, null, 2) + "\n```");
}

const sectionsDir = path.join(stateDir, "sections");
if (existsSync(sectionsDir)) {
  const rows: { id: string; seg: number; sign: number; cam: number; skipped: number; quarantined: number; minutes: number }[] = [];
  for (const name of readdirSync(sectionsDir).filter((n) => n.endsWith(".json")).sort()) {
    const s = JSON.parse(readText(path.join(sectionsDir, name))) as { id: string; startedAt: string; finishedAt: string; insertedByKind: Record<string, number>; skippedAlreadyDone: number; quarantined: number };
    rows.push({
      id: s.id,
      seg: s.insertedByKind["speed-limit-segment"] ?? 0,
      sign: s.insertedByKind["static-sign"] ?? 0,
      cam: s.insertedByKind["fixed-speed-camera"] ?? 0,
      skipped: s.skippedAlreadyDone,
      quarantined: s.quarantined,
      minutes: (Date.parse(s.finishedAt) - Date.parse(s.startedAt)) / 60000,
    });
  }
  const sum = (f: (r: (typeof rows)[number]) => number): number => rows.reduce((a, r) => a + f(r), 0);
  console.log("\n### Sections (10° tiles named by their south-west corner)\n");
  console.log(
    "Segments/signs/cameras are the rows confirmed by the attempt that COMPLETED the section; rows an earlier, interrupted attempt had already confirmed appear under " +
      '"already done" (so a section finished after an interruption is split across the two columns).\n',
  );
  console.log("| Section | Segments | Signs | Cameras | Already done (earlier attempts) | Rows in section | Quarantined |\n|---|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) console.log(`| ${r.id} | ${r.seg} | ${r.sign} | ${r.cam} | ${r.skipped} | ${r.seg + r.sign + r.cam + r.skipped} | ${r.quarantined} |`);
  console.log(`| **Total** | **${sum((r) => r.seg)}** | **${sum((r) => r.sign)}** | **${sum((r) => r.cam)}** | ${sum((r) => r.skipped)} | ${sum((r) => r.seg + r.sign + r.cam + r.skipped)} | ${sum((r) => r.quarantined)} |`);
}

const quarantinePath = path.join(stateDir, "quarantine.ndjson");
if (existsSync(quarantinePath)) {
  const reasons = new Map<string, number>();
  for (const raw of readText(quarantinePath).split("\n")) {
    if (!raw.trim()) continue;
    try {
      const q = JSON.parse(raw) as { reason: string; detail?: unknown };
      const key = `${q.reason}: ${typeof q.detail === "string" ? q.detail.replace(/[\d.]+/g, "N") : JSON.stringify(q.detail)?.slice(0, 80)}`;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    } catch {
      /* partial line */
    }
  }
  console.log("\n### Quarantined rows by reason\n");
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`- ${count} × ${reason}`);
}
