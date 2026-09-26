import "dotenv/config";
import { parseArgs } from "node:util";
import { loadEnv } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { countDirtyTiles, getPackageState, listPackageRows, markTilesDirty, currentStaticDataVersion } from "../src/db/queries/static-packages.js";
import { packageFingerprint, runBuild } from "../src/modules/static-data/package-builder.js";
import { getPackageService } from "../src/modules/static-data/package-service.js";

/**
 * Operator CLI for the pre-built static-data packages (add-on E-B,
 * docs/europe-scale.md). Run it with the same DATABASE_URL / .env as the server,
 * and with STATIC_PACKAGES_DIR pointing at the same directory (in Docker: the
 * volume). It coordinates with a running server through the builder lease, so
 * it is safe to run alongside one.
 *
 *   npm run static-packages -- status
 *   npm run static-packages -- build [--full] [--tile <h3 cell>] [--max-tiles N]
 *   npm run static-packages -- verify [--deep]
 *
 * `build` works through the dirty tiles (all of them for the very first build or a
 * changed configuration), printing progress; interrupt it any time and start it
 * again — every finished tile is already recorded. `--full` rebuilds everything
 * (needed after changing static data by hand with SQL, which marks nothing).
 * `verify` checks that every tile the database lists exists on disk (--deep also
 * re-hashes the files).
 */

function mb(bytes: number | null): string {
  return bytes === null ? "-" : (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { full: { type: "boolean" }, tile: { type: "string" }, "max-tiles": { type: "string" }, deep: { type: "boolean" } },
  });
  const [command] = positionals;
  const env = loadEnv();
  const { db, client } = createDb(env);
  const service = getPackageService(db, env);

  try {
    switch (command) {
      case "status": {
        const state = await getPackageState(db);
        const dirty = await countDirtyTiles(db);
        const rows = await listPackageRows(db);
        const disk = await service.store.diskUsage();
        const raw = rows.reduce((a, r) => a + (r.sizeBytes ?? 0), 0);
        const gz = rows.reduce((a, r) => a + (r.gzipBytes ?? 0), 0);
        const br = rows.reduce((a, r) => a + (r.brotliBytes ?? 0), 0);
        console.log(`directory:        ${env.STATIC_PACKAGES_DIR}`);
        console.log(`ready:            ${state.ready}${state.fingerprint === packageFingerprint(env) ? "" : "  (settings changed since the last build — a rebuild is due)"}`);
        console.log(`static version:   ${await currentStaticDataVersion(db)}  (packages built for ${state.builtVersion})`);
        console.log(`tiles with data:  ${rows.length}   dirty: ${dirty.dirty}`);
        console.log(`content:          ${mb(raw)} uncompressed, ${mb(gz)} gzip, ${mb(br)} brotli`);
        console.log(`on disk:          ${disk.files} files, ${mb(disk.bytes)}`);
        console.log(`builder lease:    ${state.leaseOwner ?? "free"}${state.leaseUntil ? ` (until ${state.leaseUntil})` : ""}`);
        break;
      }
      case "build": {
        if (values.tile) await markTilesDirty(db, [values.tile]);
        const started = Date.now();
        const result = await runBuild(
          { ...service.builderDeps, log: { info: (o, m) => console.log(m, JSON.stringify(o)), warn: (o, m) => console.warn(m, JSON.stringify(o)) } },
          {
            full: values.full ?? false,
            maxTiles: values["max-tiles"] ? Number(values["max-tiles"]) : undefined,
            onProgress: (done, total, tile) => {
              if (done % 25 === 0 || done === total) console.log(`  ${done}/${total} tiles (last: ${tile}, ${Math.round((Date.now() - started) / 1000)} s)`);
            },
          },
        );
        if (result.status === "busy") {
          console.log("Another process holds the builder lease (a running server's worker?). Nothing done.");
          process.exitCode = 2;
        } else {
          console.log(
            `Built ${result.tilesBuilt} tile(s) (${result.tilesEmpty} empty), ${result.tilesFailed} failed, ${mb(result.bytesWritten)} written in ${Math.round(result.seconds)} s. Ready: ${result.ready}. Peak memory of this process: ${mb(process.resourceUsage().maxRSS * 1024)}.`,
          );
          if (result.tilesFailed > 0) process.exitCode = 1;
        }
        break;
      }
      case "verify": {
        const rows = await listPackageRows(db);
        let missing = 0;
        let corrupt = 0;
        for (const row of rows) {
          const size = await service.store.size(row.tile, row.hash!, "gzip");
          if (size === null || (await service.store.size(row.tile, row.hash!, "br")) === null) {
            missing++;
            console.log(`missing: ${row.tile} ${row.hash}`);
            continue;
          }
          if (values.deep) {
            const { createHash } = await import("node:crypto");
            const opened = await service.store.open(row.tile, row.hash!, "identity");
            const hash = createHash("sha256");
            for await (const chunk of opened!.stream) hash.update(chunk as Buffer);
            if (hash.digest("hex") !== row.hash) {
              corrupt++;
              console.log(`corrupt: ${row.tile} ${row.hash}`);
            }
          }
        }
        console.log(`${rows.length} tile(s) checked: ${missing} missing, ${corrupt} corrupt.`);
        if (missing + corrupt > 0) {
          console.log("Fix: npm run static-packages -- build --full   (missing files are rebuilt; the manifest keeps working for the rest)");
          process.exitCode = 1;
        }
        break;
      }
      default:
        throw new Error("Usage: static-packages <status|build|verify> — see the header of scripts/static-packages.mts");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("static-packages:", err instanceof Error ? err.message : err);
  process.exit(1);
});
