import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { sql, type SQL } from "drizzle-orm";
import { CAMERA_NAMESPACE_TYPES } from "../src/config/constants.js";
import { loadEnv } from "../src/config/env.js";
import { createDb, type Queryable } from "../src/db/client.js";
import { CameraPolicyService } from "../src/modules/cameras/policy/policy.js";
import { parseBoundaryCollection, resolveCountries, storeBoundaries } from "../src/modules/cameras/policy/boundaries.js";
import { pgArray } from "../src/db/pg-array.js";

/**
 * Operator CLI for the country-based camera policy (docs/camera-country-policy.md). Run it against the same
 * DATABASE_URL / .env as the server. The server ships no geodata: you bring the country boundaries.
 *
 *   npm run cameras -- load-boundaries <countries.geojson> [--property ISO_A2_EH] [--name "Natural Earth 1:10m"] [--no-resolve]
 *   npm run cameras -- resolve-countries [--all]
 *   npm run cameras -- status
 *
 * `load-boundaries` replaces the boundary table with a GeoJSON FeatureCollection of countries (Polygon/MultiPolygon), stores
 * the shapes subdivided (so a lookup is an index probe), and then resolves every stored camera. The ISO 3166-1 alpha-2
 * code is read from the first property found of: --property, ISO_A2_EH, ISO_A2, iso_a2, ISO3166-1-Alpha-2, cc. A feature
 * without a usable two-letter code (Natural Earth marks France and Norway "-99" in ISO_A2 - use ISO_A2_EH) is reported
 * and the load stops, so a country can never be silently missing.
 *
 * `resolve-countries` computes the country set (every country within CAMERA_POLICY_BORDER_MARGIN_M of the camera) for
 * cameras that have none yet - or for all of them with --all, which you need after changing the margin or the boundaries. It
 * marks the affected static-data packages dirty and bumps the static-data version, like a bulk import does.
 * This process cannot push WebSocket messages: a running server picks the change up through its packages and delta/snapshot.
 *
 * Which countries may deliver anything is not decided here: that is the signed policy (npm run network:sign-config).
 */

async function loadBoundaries(db: Queryable, file: string, opts: { property?: string; name?: string; marginM: number }): Promise<void> {
  const raw = readFileSync(file);
  const { usable, unusable } = parseBoundaryCollection(raw, opts.property);
  if (unusable.length > 0) {
    console.error(`${unusable.length} feature(s) cannot be used:`);
    for (const line of unusable.slice(0, 20)) console.error(`  - ${line}`);
    throw new Error("Nothing was changed. Fix the dataset or pick the right property with --property.");
  }
  const started = Date.now();
  await storeBoundaries(db, usable, { dataset: opts.name ?? file, contentHash: createHash("sha256").update(raw).digest("hex") });
  const countries = new Set(usable.map((f) => f.iso2));
  console.log(`Loaded ${usable.length} feature(s) for ${countries.size} countr${countries.size === 1 ? "y" : "ies"} in ${Math.round((Date.now() - started) / 1000)} s.`);
  console.log(`Border strip: CAMERA_POLICY_BORDER_MARGIN_M = ${opts.marginM} m. It must exceed the positional error of this dataset`);
  console.log("(Natural Earth 1:10m: a few hundred metres; 1:50m or coarser: several kilometres - raise the margin, never lower it).");
}

async function status(db: Queryable, env: ReturnType<typeof loadEnv>): Promise<void> {
  const state = (await db.execute<Record<string, unknown>>(sql`select * from country_boundary_state where id = 1`))[0];
  const parts = (await db.execute<{ n: number; c: number } & Record<string, unknown>>(sql`select count(*)::int as n, count(distinct iso2)::int as c from country_boundary_parts`))[0]!;
  console.log("Boundaries");
  if (parts.n === 0) {
    console.log("  none loaded - no camera has a known country, so nothing is delivered (npm run cameras -- load-boundaries <file>)");
  } else {
    console.log(`  ${parts.c} countries, ${parts.n} parts; dataset: ${String(state?.["dataset"] ?? "?")}; loaded: ${String(state?.["loaded_at"] ?? "?")}`);
    const stored = state?.["margin_m"] as number | null | undefined;
    console.log(
      stored == null
        ? "  country sets not computed with any margin yet (run: npm run cameras -- resolve-countries)"
        : stored === env.CAMERA_POLICY_BORDER_MARGIN_M
          ? `  border strip: ${stored} m (matches CAMERA_POLICY_BORDER_MARGIN_M)`
          : `  border strip when last computed: ${stored} m, CAMERA_POLICY_BORDER_MARGIN_M is now ${env.CAMERA_POLICY_BORDER_MARGIN_M} m - run: npm run cameras -- resolve-countries --all`,
    );
  }

  const one = async (query: SQL) => Number((await db.execute<{ n: number } & Record<string, unknown>>(query))[0]?.n ?? 0);
  console.log("Persistent devices (fixed_speed_cameras, active)");
  console.log(`  total ${await one(sql`select count(*)::int as n from fixed_speed_cameras where status = 'active'`)}, ` +
    `country not resolved ${await one(sql`select count(*)::int as n from fixed_speed_cameras where status = 'active' and countries is null`)}, ` +
    `in no known country ${await one(sql`select count(*)::int as n from fixed_speed_cameras where status = 'active' and countries = '{}'`)}, ` +
    `in a border strip ${await one(sql`select count(*)::int as n from fixed_speed_cameras where status = 'active' and cardinality(countries) > 1`)}`);
  const perCountry = await db.execute<{ iso2: string; n: number } & Record<string, unknown>>(sql`
    select c as iso2, count(*)::int as n from fixed_speed_cameras, unnest(countries) c where status = 'active' group by c order by n desc limit 30`);
  if (perCountry.length > 0) console.log(`  by country: ${perCountry.map((r) => `${r.iso2} ${r.n}`).join(", ")}`);
  console.log("Camera reports (hazard_reports, camera types, active)");
  console.log(`  total ${await one(sql`select count(*)::int as n from hazard_reports where status = 'active' and type = any(${pgArray([...CAMERA_NAMESPACE_TYPES])}::hazard_type[])`)}, ` +
    `country not resolved ${await one(sql`select count(*)::int as n from hazard_reports where status = 'active' and countries is null and type = any(${pgArray([...CAMERA_NAMESPACE_TYPES])}::hazard_type[])`)}`);

  const policy = (await CameraPolicyService.load(env)).current();
  console.log("Camera policy in force (signed network config, local caps and the brake applied)");
  if (!policy.namespaceEnabled) console.log("  emergency brake ON (SPEED_CAMERA_NAMESPACE_ENABLED=false, blitzerEnabled=false or no readable signed config): every country is off");
  const levels = Object.entries(policy.byCountry).filter(([, level]) => level !== "off");
  console.log(levels.length === 0 ? "  no country above off - no camera data is delivered" : `  ${levels.map(([c, l]) => `${c}=${l}`).join(", ")}   (every other country: off)`);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { property: { type: "string" }, name: { type: "string" }, "no-resolve": { type: "boolean" }, all: { type: "boolean" } },
  });
  const [command, file] = positionals;
  const env = loadEnv();
  const { db, client } = createDb(env);
  try {
    switch (command) {
      case "load-boundaries": {
        if (!file) throw new Error("Usage: cameras load-boundaries <countries.geojson> [--property NAME] [--name LABEL] [--no-resolve]");
        await loadBoundaries(db, file, { property: values.property, name: values.name, marginM: env.CAMERA_POLICY_BORDER_MARGIN_M });
        if (!values["no-resolve"]) {
          const r = await resolveCountries(db, env.CAMERA_POLICY_BORDER_MARGIN_M, { all: true, partitionRes: env.STATIC_DATA_PARTITION_H3_RESOLUTION, zoneRes: env.CAMERA_ZONE_H3_RESOLUTION });
          console.log(`Resolved ${r.devices} device(s), ${r.reports} report(s), ${r.events} event(s); ${r.tiles} package tile(s) marked for rebuild (${r.staleTiles} of them not served until rebuilt: their cameras' countries changed).`);
        }
        break;
      }
      case "resolve-countries": {
        const r = await resolveCountries(db, env.CAMERA_POLICY_BORDER_MARGIN_M, {
          all: values.all ?? false,
          partitionRes: env.STATIC_DATA_PARTITION_H3_RESOLUTION,
          zoneRes: env.CAMERA_ZONE_H3_RESOLUTION,
        });
        console.log(`Resolved ${r.devices} device(s), ${r.reports} report(s), ${r.events} event(s); ${r.tiles} package tile(s) marked for rebuild (${r.staleTiles} of them not served until rebuilt: their cameras' countries changed).`);
        break;
      }
      case "status":
        await status(db, env);
        break;
      default:
        throw new Error("Usage: cameras <load-boundaries|resolve-countries|status> - see the header of scripts/cameras.mts");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("cameras:", err instanceof Error ? err.message : err);
  process.exit(1);
});
