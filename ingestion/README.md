# ingestion

Optional bulk-import client that seeds a Trafficnetwork server's database from OpenStreetMap and other sources. **Not a core system component** — it's a normal client with the `bulk-import` scope, talking only to the server's public, publicly-documented bulk-import API (`server/docs/api.md`). No direct database access, no privileged path, nothing the server needs to know about. It can be run once and never again, run periodically, or never run at all — a server with an empty database is a valid, fully working state.

**Status**: complete for all three assignments — Phase 3 (OSM worker, verification, CI), add-on A (Europe basemap) and add-on Q (source catalogue). The three stages are stacked branches (`phase3/ingestion` → `phase3/europe-basemap` → `phase3/source-catalogue`). Validated against real infrastructure, not just unit tests:
- The OSM worker (`osmium-tool` v1.16.0, matching CI's exact apt package) processed a real Geofabrik extract (Liechtenstein, chosen for its small size) end to end with zero errors, and the whole of Europe from one pinned extract (13.68 M rows, 4.1 GB database — [`docs/europe-run-report.md`](docs/europe-run-report.md)).
- The full CLI, run as a real OS process against a real built `server/` and checked-in fixtures, passes the end-to-end scenarios for each source (see "Testing"): empty DB → import → API confirms counts; a second run is a no-op; a hard kill mid-run followed by an unmodified resume lands the exact expected count with no duplicates.
- The unit tests cover normalization, dedup/state, batching, backoff, config validation, verification logic, the DATEX II and Autobahn readers (on verbatim excerpts of the live feeds) and the NVDB reader (on real API responses).

**Europe (add-on A, branch `phase3/europe-basemap`)**: the same tool imports the whole continent from one pinned Geofabrik extract — resumable Range download, a narrow tag filter, geographic sections with their own progress markers, streaming state with a compact dedup set, client-side validation with bisect-and-quarantine of rejected rows, and a "target must be empty" guard. Feasibility, measurements and decisions: [`docs/europe-feasibility.md`](docs/europe-feasibility.md); procedure: [`docs/europe-runbook.md`](docs/europe-runbook.md); a ready-made runner image is the [`Dockerfile`](Dockerfile).

**Source catalogue (add-on Q, branch `phase3/source-catalogue`)**: three more kinds of data, each behind its own switch and each with its license evidence in [`docs/sources.md`](docs/sources.md):
- **Roadworks** — time-limited `construction` reports from a generic DATEX II reader (v2/v3) and the Autobahn GmbH JSON API, run *periodically* (one poll pass per invocation; `npm run ingest -- --roadworks`). France is on, the Netherlands and Germany ship off (`ungeklärt`). Operation, cost of a permanent run and safety rules: [`docs/roadworks.md`](docs/roadworks.md).
- **Official traffic signs** — NVDB Norway (`--region norway`, license NLOD), with the national sign codes kept verbatim behind a country prefix and a per-country mapping table in [`config/sign-mappings/`](config/sign-mappings/).
- **Speed cameras and signs from OSM** are part of the Europe import above; the camera namespace stays closed.
`npm run report:quality` prints, per source, what was taken over, discarded (with the reasons) and merged; what each license makes us credit is in [`docs/attribution.md`](docs/attribution.md).

See [`docs/concept.md`](../docs/concept.md) section 7 and `docs/prompt-phase3-ingestion.md` (ausgelagert nach `../Trafficnetwork-prompts/`, nicht mehr im Repo) for the full design brief, and [`docs/sources.md`](docs/sources.md) for the evidenced source catalog (licenses, pricing, what's implemented vs. catalog-only).

## Setup

Requires [`osmium-tool`](https://osmcode.org/osmium-tool/) on `PATH` for the OSM worker (Ubuntu/CI: `apt-get install osmium-tool`; other platforms: see osmium-tool's own install docs). This program shells out to the real `osmium` CLI rather than reimplementing PBF parsing — see `docs/sources.md` for why.

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- `SERVER_URL`, `CLIENT_ID`, `CLIENT_SECRET` — credentials for a client provisioned on the target server with the `bulk-import` scope. The operator creates this from `server/`, not from here:
  ```bash
  cd ../server && npm run create-client -- --name "ingestion" --scope bulk-import
  ```
- Everything else has a sensible default — see the comments in `.env.example`. Notably: `HERE_MONTHLY_CALL_LIMIT`/`TOMTOM_MONTHLY_CALL_LIMIT` have **no default** and are only required if you ever set `HERE_ENABLED`/`TOMTOM_ENABLED=true` (neither source is implemented yet — see `docs/sources.md`).

## Running

```bash
npm run ingest -- --region bayern --dry-run   # validates config + server credentials, sends nothing
npm run ingest -- --region bayern             # real run — requires osmium-tool on PATH (apt: osmium-tool; see docs/sources.md)
npm run ingest -- --region bayern --fresh     # wipes local progress state and starts over — see "Resuming" below before using this
npm run ingest -- --region bayern --batch-size 500
npm run ingest -- --region europe --section x10_y40   # only some sections (regions with "sections"); the run is then not marked complete
npm run ingest -- --region bayern --allow-non-empty   # deliberately import into a server that already holds data (see below)
npm run ingest -- --roadworks [--feed fr-tipi-rrn] [--dry-run]   # one roadworks poll pass, then exit — schedule it (docs/roadworks.md)
npm run ingest -- --region norway --allow-non-empty   # NVDB sign plates; set OSM_ENABLED=false NVDB_NO_ENABLED=true (docs/sources.md)
npm run report:quality                        # per-source report: taken over / discarded / merged
```

Valid `--region` values are the keys in [`config/regions.json`](config/regions.json) — currently `bayern` (the project's chosen first region, ~812MB Geofabrik extract), `germany`, and `europe` (the whole continent; **pinned to one dated Geofabrik edition** so a resume never mixes two editions — bump it deliberately), and `norway` (official sign plates from NVDB, not from OSM: it has no Geofabrik extract and lists `officialSources` instead — a source that cannot import a region is skipped with the reason). The same code handles all of them, per the project's requirement that going bigger never needs a code change — just more time and disk.

**Empty-target guard.** The server has no dedup. A *fresh* run (no local progress for the region) therefore refuses to start against a server that already holds any static data, because importing a region it already contains would silently double it. `--allow-non-empty` overrides this on purpose (e.g. a different region into a populated server). A resume is never affected.

**Rows that are not imported are never dropped silently.** Rows the server's schema would reject (or that are implausible, e.g. `maxspeed=500`, or fractional where the server stores integers) go to `quarantine.ndjson` in the state directory with the reason and the full row; a batch the server rejects with 400 is bisected down to the offending row. More than `MAX_QUARANTINED` (default 500) aborts the run.

## Verification

After every real run (not `--dry-run`), the program checks what actually landed on the server, over the same public API any other client uses — no privileged read path (`src/verify/verify.ts`):
1. **The run's own count** (exact, always available) — how many rows this run's own POSTs got back an `inserted` count for.
2. **Spot-checks** against `region.verificationPoints` in `config/regions.json` — a known coordinate + expected speed limit, checked via `GET /v1/speed-limit-segments/nearby`. Empty by default; add these yourself after manually confirming a real known-limit road post-import (never invented ahead of time — see `src/config/regions.ts`).
3. **An approximate cross-check** via the static-data manifest/partitions, summing every static entity in the H3 partitions covering the region's bounding box. Approximate by design (a segment straddling a partition boundary is counted in more than one partition, and this also picks up anything already there from prior runs) — a sanity net, not a second source of truth. Logged clearly as such.

## Testing

```bash
npm run test:unit          # no external dependencies
npm run test:integration   # needs Docker (Testcontainers) and server/ already built (npm run build in ../server); osmium-tool on PATH for full-cycle
```

Every integration test file gets **its own database and server process** (`tests/integration/setup.ts`), because the importer refuses a fresh start on a server that already holds static data and several files import static data. Locally that database is a Testcontainers Postgres/PostGIS; in CI ([`.github/workflows/ingestion-ci.yml`](../.github/workflows/ingestion-ci.yml)) it is a fresh database on the workflow's postgres service (`INGESTION_TEST_PG_ADMIN_URL`). In both cases the real CLI runs as an OS process against the built `server/dist`, with tiny checked-in fixtures — not mocks:

- `full-cycle.test.ts` — OSM: the real `osmium-tool` and `tests/fixtures/*.osm.pbf`;
- `roadworks-cycle.test.ts` — roadworks: the CLI against two local feed servers (DATEX II and Autobahn JSON) whose content the test changes between passes;
- `nvdb-cycle.test.ts` — NVDB Norway: the CLI against a stand-in that serves **real API responses** (`tests/fixtures/nvdb-no/`: a whole municipality and two pages of Oslo); half-way abort, resume, no duplicates;
- `camera-namespace.test.ts` — imported speed cameras are not delivered while the server's flag is off.

The DATEX II and Autobahn fixtures (`tests/fixtures/roadworks/`) are verbatim excerpts of the live feeds, fetched 2026-09-26.

## Resuming and duplicates

The server's bulk-import endpoints have **no deduplication of their own** — POSTing the same row twice always creates two rows. All idempotency is handled locally, in a per-`(region, source)` progress log under `STATE_DIR` (default `./.ingestion-state`, gitignored). **Never delete this directory** between runs unless you deliberately want to re-import a region from scratch (which will duplicate everything already there — that's what `--fresh` is for, and it warns loudly before doing it).

A run that's killed mid-way can always be resumed by just running the same command again — it replays its own progress log and skips whatever it already confirmed the server accepted. One known, accepted limitation: a hard kill in the narrow window between a batch being accepted by the server and that fact being durably written to disk can duplicate at most one batch's worth of rows (bounded by `BATCH_SIZE`) on resume. This is a real constraint of the server's design (no natural key to reconcile against after the fact), not something this program can fully close from the outside — smaller `BATCH_SIZE` shrinks the window at the cost of more HTTP calls.

## Attribution and provenance

Every source's credit line and what its license requires is collected in [`docs/attribution.md`](docs/attribution.md).

### ODbL (OpenStreetMap)

The OSM-derived data comes from OpenStreetMap: **© OpenStreetMap contributors**, licensed under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/) — <https://www.openstreetmap.org/copyright>. Every row is stored with `source=osm` and `sourceLicense=ODbL`, and the tool never alters those fields. Anything that displays or redistributes the data (the server's web UI, client apps, dumps) must show that credit. Speed limits resolved from `maxspeed:type` use the OSM wiki's *Default speed limits* table (CC BY-SA 2.0, via `westnordost/osm-legal-default-speeds`, BSD-3 code) — credited in the generated `src/pipeline/osm/implicit-speeds.generated.ts`. The exact edition of an import (file, size, md5, Last-Modified, replication sequence/timestamp, osmium version, tag filter) is written to `extract-meta.json` in the state directory.

## Cost/license warnings

- Only OpenStreetMap is enabled by default. It's ODbL-licensed and unproblematic to redistribute (see `docs/sources.md`).
- HERE and TomTom are pay-per-use beyond a free tier and are **not implemented** in this round — no verified current pricing exists to size a safe kill-switch against (see `docs/sources.md`), and enabling either requires you to supply your own account's actual call limit.
- Mobilithek is catalog-only (documented, off, no worker) — its license varies per dataset and it needs an organisation account. The Autobahn GmbH API has a roadworks reader now but **ships off**: it genuinely has no stated license (`"ungeklärt"`), every row it writes says so, and it needs a deliberate switch (`AUTOBAHN_API_ENABLED=true` or `ROADWORKS_FEEDS_ON=de-autobahn`). The NDW feed ships off for the same kind of reason (no license text of its own found).
- Speed-camera (Blitzer) data: imported like any other static entity, and whether the server delivers them is the server's decision, not this program's: its emergency brake (`SPEED_CAMERA_NAMESPACE_ENABLED`) and its per-country camera policy (`server/docs/camera-country-policy.md` — since 2026-10-04 cameras are delivered in full by default, single countries can be restricted by the operator) — this program never bypasses either. The legal assessment per country is the operator's.
