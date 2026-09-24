import "dotenv/config";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { signToken } from "../src/modules/auth/jwt.js";
import { bulkInsertSpeedLimitSegments, type SpeedLimitSegmentImportRow } from "../src/db/queries/bulk-import.js";

/**
 * Measures what a node's storage and delivery cost at a given data volume
 * (add-on E-B, docs/europe-scale.md) — the numbers in docs/operating.md come
 * from this script, and the same command is how the real full-Europe import
 * gets measured once it exists (it works against any DATABASE_URL, no
 * synthetic-data assumptions).
 *
 *   npm run measure-scale -- --phase sizes,reads,packages,snapshot,compression,import --label "10M rows" --json out.json
 *
 * Phases (default: sizes,reads). Run `packages`, `snapshot` and `import` as
 * separate invocations when memory matters: peak RSS is per process, and a
 * package build that exhausts the heap kills the process — which is itself the
 * finding, recorded by whoever invoked it. `import` writes rows with
 * source='bench' and deletes them again at the end.
 */

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "unlabelled" },
    phase: { type: "string", default: "sizes,reads" },
    points: { type: "string", default: "20" },
    json: { type: "string" },
    "import-rows": { type: "string", default: "100000" },
    "import-batch": { type: "string", default: "5000" },
  },
});
const phases = new Set((values.phase ?? "sizes,reads").split(","));
const report: Record<string, unknown> = { label: values.label, at: new Date().toISOString() };

process.env["LOG_LEVEL"] ??= "silent";
const env = loadEnv();
const { db, client } = createDb(env);

const MB = 1024 * 1024;
const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;
const mb = (bytes: number) => round(bytes / MB, 1);

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, medianMs: round(at(0.5)), p95Ms: round(at(0.95)), maxMs: round(sorted.at(-1) ?? 0) };
}

function peakRssMb(): number {
  return mb(process.resourceUsage().maxRSS * 1024);
}

async function main() {
  const token = await signToken({ sub: "measure-scale", scopes: ["client"] }, env);
  const app = await buildApp({ env, db });
  const auth = { authorization: `Bearer ${token}` };

  const get = async (url: string) => {
    const started = performance.now();
    const res = await app.inject({ method: "GET", url, headers: auth });
    return { ms: performance.now() - started, status: res.statusCode, bytes: Buffer.byteLength(res.body), body: res.body };
  };

  if (phases.has("sizes")) {
    const one = async <T,>(query: ReturnType<typeof sql>): Promise<T> => (await db.execute(query))[0] as T;
    const rows = await db.execute<Record<string, unknown>>(sql`
      select c.relname as name, c.relkind as kind, pg_relation_size(c.oid) as heap_bytes,
             pg_total_relation_size(c.oid) as total_bytes
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname in
        ('speed_limit_segments','static_signs','fixed_speed_cameras','event_log','hazard_reports','speed_limit_correction_votes','speed_limit_corrections')
      order by c.relname
    `);
    const indexes = await db.execute<Record<string, unknown>>(sql`
      select i.indexrelid::regclass::text as name, i.indrelid::regclass::text as tbl, pg_relation_size(i.indexrelid) as bytes
      from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('speed_limit_segments','static_signs','fixed_speed_cameras')
      order by bytes desc
    `);
    const counts = await one<Record<string, unknown>>(sql`
      select (select count(*) from speed_limit_segments) as segments, (select count(*) from static_signs) as signs,
             (select count(*) from fixed_speed_cameras) as cameras, pg_database_size(current_database()) as db_bytes
    `);
    const segments = Number(counts["segments"]);
    const seg = rows.find((r) => r["name"] === "speed_limit_segments");
    report["sizes"] = {
      rows: { segments, signs: Number(counts["signs"]), cameras: Number(counts["cameras"]) },
      databaseMb: mb(Number(counts["db_bytes"])),
      tables: rows.map((r) => ({ table: r["name"], heapMb: mb(Number(r["heap_bytes"])), totalMb: mb(Number(r["total_bytes"])) })),
      indexes: indexes.map((r) => ({ index: r["name"], table: r["tbl"], mb: mb(Number(r["bytes"])) })),
      segmentBytesPerRow: seg && segments > 0 ? round(Number(seg["total_bytes"]) / segments, 1) : null,
    };
  }

  if (phases.has("reads")) {
    const nPoints = Number(values.points);
    const sample = await db.execute<{ lng: number; lat: number } & Record<string, unknown>>(sql`
      select ST_X(ST_StartPoint(geometry)) as lng, ST_Y(ST_StartPoint(geometry)) as lat
      from speed_limit_segments tablesample system (0.05) limit ${nPoints}
    `);
    const points = sample.length > 0 ? sample : await db.execute<{ lng: number; lat: number } & Record<string, unknown>>(sql`
      select ST_X(ST_StartPoint(geometry)) as lng, ST_Y(ST_StartPoint(geometry)) as lat from speed_limit_segments limit ${nPoints}
    `);
    const scenarios: { name: string; url: (p: { lng: number; lat: number }) => string; take: number }[] = [
      { name: "GET /v1/speed-limit", url: (p) => `/v1/speed-limit?lat=${p.lat}&lng=${p.lng}`, take: nPoints },
      { name: "GET /v1/speed-limit-segments/nearby r=200m", url: (p) => `/v1/speed-limit-segments/nearby?lat=${p.lat}&lng=${p.lng}&radiusM=200`, take: nPoints },
      { name: "GET /v1/speed-limit-segments/nearby r=2km", url: (p) => `/v1/speed-limit-segments/nearby?lat=${p.lat}&lng=${p.lng}&radiusM=2000`, take: nPoints },
      { name: "GET /v1/speed-limit-segments/nearby r=20km", url: (p) => `/v1/speed-limit-segments/nearby?lat=${p.lat}&lng=${p.lng}&radiusM=20000`, take: 5 },
      { name: "GET /v1/speed-limit-segments/nearby r=50km (API maximum)", url: (p) => `/v1/speed-limit-segments/nearby?lat=${p.lat}&lng=${p.lng}&radiusM=50000`, take: 3 },
      { name: "GET /v1/static-signs/nearby r=2km", url: (p) => `/v1/static-signs/nearby?lat=${p.lat}&lng=${p.lng}&radiusM=2000`, take: nPoints },
    ];
    const out: unknown[] = [];
    for (const scenario of scenarios) {
      const chosen = points.slice(0, scenario.take);
      const first: number[] = [];
      const second: number[] = [];
      let bytes = 0;
      for (const p of chosen) {
        const r = await get(scenario.url(p));
        first.push(r.ms);
        bytes += r.bytes;
      }
      for (const p of chosen) second.push((await get(scenario.url(p))).ms);
      out.push({ scenario: scenario.name, firstPass: stats(first), secondPass: stats(second), avgResponseKb: round(bytes / chosen.length / 1024) });
    }
    report["reads"] = out;
  }

  if (phases.has("packages")) {
    const rssBefore = peakRssMb();
    const started = performance.now();
    const manifestRes = await get("/v1/static-data/manifest");
    const buildMs = performance.now() - started;
    const manifest = JSON.parse(manifestRes.body) as { staticDataVersion: number; partitions: { tile: string; hash: string; sizeBytes: number }[] };
    const sizes = manifest.partitions.map((p) => p.sizeBytes).sort((a, b) => a - b);
    const total = sizes.reduce((a, b) => a + b, 0);
    const at = (q: number) => sizes[Math.min(sizes.length - 1, Math.floor(q * sizes.length))] ?? 0;
    const largest = manifest.partitions.reduce((a, b) => (b.sizeBytes > a.sizeBytes ? b : a), manifest.partitions[0]!);
    const largestFetch = manifest.partitions.length > 0 ? await get(`/v1/static-data/partitions/${largest.tile}`) : null;
    report["packages"] = {
      coldManifestMs: round(buildMs),
      peakRssBeforeMb: rssBefore,
      peakRssAfterMb: peakRssMb(),
      manifest: { bytes: manifestRes.bytes, gzipBytes: gzipSync(manifestRes.body).length, partitions: manifest.partitions.length },
      partitionSizesMb: { total: mb(total), p50: mb(at(0.5)), p90: mb(at(0.9)), max: mb(sizes.at(-1) ?? 0) },
      largestPartitionFetchMs: largestFetch ? round(largestFetch.ms) : null,
      warmManifestMs: round((await get("/v1/static-data/manifest")).ms),
    };

    if (phases.has("compression") && largestFetch) {
      const mid = manifest.partitions.find((p) => p.sizeBytes >= at(0.5)) ?? largest;
      const midFetch = await get(`/v1/static-data/partitions/${mid.tile}`);
      const compress = (body: string) => {
        const raw = Buffer.from(body);
        const g0 = performance.now();
        const gz = gzipSync(raw, { level: 6 });
        const g1 = performance.now();
        const br = brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
        const b1 = performance.now();
        return {
          rawMb: mb(raw.length),
          gzip6: { mb: mb(gz.length), ratio: round(raw.length / gz.length, 2), ms: round(g1 - g0) },
          brotli5: { mb: mb(br.length), ratio: round(raw.length / br.length, 2), ms: round(b1 - g1) },
        };
      };
      report["compression"] = { largestPartition: compress(largestFetch.body), medianPartition: compress(midFetch.body) };
    }
  }

  if (phases.has("snapshot")) {
    const started = performance.now();
    let result: Record<string, unknown>;
    try {
      const r = await get("/v1/snapshot");
      result = { status: r.status, ms: round(performance.now() - started), responseMb: mb(r.bytes) };
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err), ms: round(performance.now() - started) };
    }
    report["snapshot"] = { ...result, peakRssMb: peakRssMb() };
  }

  if (phases.has("import")) {
    const total = Number(values["import-rows"]);
    const batchSize = Number(values["import-batch"]);
    const bbox = { lng: 9.5, lat: 48.5 };
    const makeRow = (i: number): SpeedLimitSegmentImportRow => {
      // Bayern-like: ~7 vertices, ~25 m steps, a random walk from a random start.
      const lng0 = bbox.lng + ((i * 7919) % 100000) / 100000 * 4;
      const lat0 = bbox.lat + ((i * 104729) % 100000) / 100000 * 2.5;
      const line: [number, number][] = [];
      for (let v = 0; v < 7; v++) line.push([round(lng0 + v * 0.0003 + (i % 13) * 1e-6, 7), round(lat0 + v * 0.0002 + (i % 7) * 1e-6, 7)]);
      return { lineString: line, speedLimit: 30 + (i % 8) * 10, speedLimitUnit: "kmh", source: "bench" };
    };
    const started = performance.now();
    let done = 0;
    while (done < total) {
      const size = Math.min(batchSize, total - done);
      const rows = Array.from({ length: size }, (_, k) => makeRow(done + k));
      await bulkInsertSpeedLimitSegments(db, rows);
      done += size;
    }
    const seconds = (performance.now() - started) / 1000;
    report["import"] = { rows: total, batchSize, seconds: round(seconds), rowsPerSecond: Math.round(total / seconds) };
    await db.execute(sql`delete from speed_limit_segments where source = 'bench'`);
  }

  await app.close();
  const text = JSON.stringify(report, null, 2);
  if (values.json) writeFileSync(values.json, text);
  console.log(text);
}

main()
  .catch((err) => {
    console.error("measure-scale failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end();
  });
