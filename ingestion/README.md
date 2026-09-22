# ingestion

Optional bulk-import client that seeds a Trafficnetwork server's database from OpenStreetMap and other sources. **Not a core system component** — it's a normal client with the `bulk-import` scope, talking only to the server's public, publicly-documented bulk-import API (`server/docs/api.md`). No direct database access, no privileged path, nothing the server needs to know about. It can be run once and never again, run periodically, or never run at all — a server with an empty database is a valid, fully working state.

**Status**: P3.4 — feature-complete for this round (OSM worker, verification, CI). Validated multiple ways against real infrastructure, not just unit tests:
- The OSM worker (`osmium-tool` v1.16.0, matching CI's exact apt package) processed a real Geofabrik extract (Liechtenstein, chosen for its small size) end to end with zero errors: 17,680 filtered features → 1,882 speed-limit segments, 54 signs, 4 fixed cameras, correct coordinate order and `@type`/`@id` extraction throughout.
- The full CLI, run as a real OS process against a real built `server/` (Testcontainers Postgres/PostGIS) and real checked-in `.osm.pbf` fixtures (`tests/fixtures/`), passes all four required end-to-end scenarios (`tests/integration/full-cycle.test.ts`): empty DB → import → API confirms counts; a second run is a fast no-op; forcing a re-stream still dedupes to zero new inserts; a hard `SIGKILL` mid-run followed by an unmodified resume lands the exact expected count, no duplicates.
- 68 unit tests cover the rest (normalization, dedup/state, batching, backoff, config validation, verification logic).

See [`docs/concept.md`](../docs/concept.md) section 7 and [`docs/prompt-phase3-ingestion.md`](../docs/prompt-phase3-ingestion.md) for the full design brief, and [`docs/sources.md`](docs/sources.md) for the evidenced source catalog (licenses, pricing, what's implemented vs. catalog-only).

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
```

Valid `--region` values are the keys in [`config/regions.json`](config/regions.json) — currently `bayern` (the project's chosen first region, ~812MB Geofabrik extract), `germany`, and `europe` (the whole-country/continent extracts work with the exact same code, per the project's requirement that going bigger never needs a code change — just more time and disk).

## Verification

After every real run (not `--dry-run`), the program checks what actually landed on the server, over the same public API any other client uses — no privileged read path (`src/verify/verify.ts`):
1. **The run's own count** (exact, always available) — how many rows this run's own POSTs got back an `inserted` count for.
2. **Spot-checks** against `region.verificationPoints` in `config/regions.json` — a known coordinate + expected speed limit, checked via `GET /v1/speed-limit-segments/nearby`. Empty by default; add these yourself after manually confirming a real known-limit road post-import (never invented ahead of time — see `src/config/regions.ts`).
3. **An approximate cross-check** via the static-data manifest/partitions, summing every static entity in the H3 partitions covering the region's bounding box. Approximate by design (a segment straddling a partition boundary is counted in more than one partition, and this also picks up anything already there from prior runs) — a sanity net, not a second source of truth. Logged clearly as such.

## Testing

```bash
npm run test:unit          # no external dependencies
npm run test:integration   # needs osmium-tool on PATH, Docker (Testcontainers), and server/ already built (npm run build in ../server)
```

`tests/integration/full-cycle.test.ts` either talks to a CI-provisioned server (`INGESTION_TEST_SERVER_URL`/`_CLIENT_ID`/`_CLIENT_SECRET`, set by [`.github/workflows/ingestion-ci.yml`](../.github/workflows/ingestion-ci.yml)) or, locally, boots its own via Testcontainers + the already-built `server/dist/server.js`. Either way it's the real CLI (spawned as an OS process), the real `osmium-tool`, and the tiny checked-in fixtures in `tests/fixtures/` — not mocks.

## Resuming and duplicates

The server's bulk-import endpoints have **no deduplication of their own** — POSTing the same row twice always creates two rows. All idempotency is handled locally, in a per-`(region, source)` progress log under `STATE_DIR` (default `./.ingestion-state`, gitignored). **Never delete this directory** between runs unless you deliberately want to re-import a region from scratch (which will duplicate everything already there — that's what `--fresh` is for, and it warns loudly before doing it).

A run that's killed mid-way can always be resumed by just running the same command again — it replays its own progress log and skips whatever it already confirmed the server accepted. One known, accepted limitation: a hard kill in the narrow window between a batch being accepted by the server and that fact being durably written to disk can duplicate at most one batch's worth of rows (bounded by `BATCH_SIZE`) on resume. This is a real constraint of the server's design (no natural key to reconcile against after the fact), not something this program can fully close from the outside — smaller `BATCH_SIZE` shrinks the window at the cost of more HTTP calls.

## Cost/license warnings

- Only OpenStreetMap is enabled by default. It's ODbL-licensed and unproblematic to redistribute (see `docs/sources.md`).
- HERE and TomTom are pay-per-use beyond a free tier and are **not implemented** in this round — no verified current pricing exists to size a safe kill-switch against (see `docs/sources.md`), and enabling either requires you to supply your own account's actual call limit.
- Mobilithek and Autobahn-API are catalog-only (documented, off, no worker) — Mobilithek because its license varies per dataset and none has been chosen yet, Autobahn-API because it genuinely has no stated license (`"ungeklärt"`).
- Speed-camera (Blitzer) data: imported like any other static entity, but the server's speed-camera namespace stays disabled regardless (`SPEED_CAMERA_NAMESPACE_ENABLED`) — this program never bypasses that flag. `docs/todo.md` still lists a legal review of Blitzer operator risk as outstanding before that namespace is ever turned on for real.
