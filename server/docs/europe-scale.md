# Europe-scale storage and delivery (add-on E-B, server part)

Scope: `docs/prompt-addon-europe-basemap.md`, part B. The operator decided that
the base data covers **all of Europe**, imported once, and that "static data
completely on every device" stays the concept until measurements say otherwise.
Part B is: make storage and delivery on the server carry that, measure instead of
guess, and say what a node needs. Parts A (the import itself), C (what a phone
pays) and D (the map) are other instances' work — what they need from here is in
[Interfaces for the other parts](#interfaces-for-the-other-parts).

**Honesty about the numbers.** The real Europe import (part A) was still running
when this was written (started 2026-09-25, ≈ 15 M rows expected, range 12–18 M). Everything measured below was measured on a scratch PostGIS database filled
with **the real Bayern import (438,595 segments / 109,646 signs, from the operator's
local node) copied 23 times to different places in Europe** — same geometry
statistics (7.4 vertices per segment, 145 B per geometry, 212 characters of GeoJSON),
same density inside each copy, but a uniform spread over the continent. It is a
sound test of size, index depth, throughput and memory; it is *not* a forecast of
how many segments Europe really has, or of how unevenly they are distributed.
`npm run measure-scale` and `npm run static-packages -- status` are how the same
numbers get recorded against the real import when it exists.

## What was found before changing anything

Measured on the branch as it was (real Bayern data, 0.55 M static rows):

| | Result | At ≈ 15 M rows (the operator's estimate for Europe) |
|---|---|---|
| `GET /v1/speed-limit`, `…/nearby` | **1.2 s** per call — every query was a sequential scan (`::geography` hides the GiST index). Fixed by the already-written `fix/spatial-index-prefilter` (bbox prefilter); this branch includes it, because nothing else can be measured without it | ~40 s per call |
| Package manifest / partitions | built **all** packages in memory on the first request after every version bump: 6.2 s, **1.6 GB** process memory for 0.55 M rows (≈ 2.5 KB of RSS per row) | ≈ 37 GB of process memory — impossible. Confirmed: at 3.3 M rows the process dies with *heap out of memory* under a 1.5 GB heap |
| `GET /v1/snapshot` (with static data) | 4.3 s, 215 MB response, 1.9 GB memory | ≈ 6 GB response, ≈ 50 GB of memory: one request takes the server down |
| `POST /v1/bulk-import/*` | one `INSERT` per row: **1,240 rows/s** | ≈ 3.4 hours |
| Any change to static data (a corrected speed limit, a camera) | invalidates the whole in-memory cache ⇒ full rebuild | unusable |

So "does storage and delivery carry Europe?" was **no** on four counts, three of
them fatal. The rest of this document is what changed.

## Decisions

### D1. Packages are files on disk, built ahead of time, addressed by content

`STATIC_PACKAGES_DIR/<tile>/<sha256>.json.gz` and `.json.br`. The hash is the
sha256 of the *uncompressed* JSON — the value the manifest has always exposed as
`hash`. A URL naming a hash never changes meaning, so it can be cached forever
(`immutable`) by clients, a reverse proxy or a CDN; a rebuild that yields the same
bytes touches nothing; replaced files stay for `STATIC_PACKAGES_KEEP_MINUTES`
(default 2 h) for downloads already in progress. Only the compressed forms are
stored (≈ 4.3× smaller); a client accepting neither gets the gzip file
decompressed on the fly. The database keeps only per-tile state (`static_packages`),
so a manifest request costs two small queries however big the dataset is.

*Alternatives rejected:* keeping the in-memory cache (dies, see above); a
streaming response computed per request (the work repeats for every bootstrap of
every client — exactly what part B item 3 asks to avoid); an object store or CDN
integration (a deployment choice — the file layout and immutable URLs are what
makes one possible, `STATIC_PACKAGES_PUBLIC`).

### D2. The builder streams one tile at a time — memory does not depend on the dataset

For a tile: one read-only `REPEATABLE READ` transaction; the first statement reads
`static_data_state.version` (what this tile corresponds to); the rows come through a
server-side cursor (`declare … cursor`, `fetch` in pages of
`STATIC_PACKAGES_PAGE_ROWS`) found by a GiST bounding-box match and narrowed with
the vertex rule the old builder used (a segment belongs to every tile that contains
one of its vertices); each page is serialised and pushed into gzip, brotli and the
sha256 at once. The bytes are **exactly** what `JSON.stringify(partition)` produced
before (`tests/integration/europe-scale.test.ts` compares hash and JSON with the old
implementation, through a deliberately tiny 7-row page). Rows are ordered by id, so the
hash is now also **stable** — the old order was whatever the heap gave it, so a vacuum
could change a package's hash without changing its content.

The bounding box of an H3 cell is a superset computed by sampling the great-circle
arcs of its edges (a property test over hundreds of thousands of points at every
resolution found two ways the obvious "corner box + padding" loses rows — coarse cells
near a pole, whose edges bulge to 88.8° from corners at 79° — before this shipped).

### D3. Finding the populated tiles without scanning the data

Descend the H3 hierarchy from the 122 base cells, probing each cell's box through the
GiST indexes (`exists`); a probe is a few index pages, and only populated parents are
expanded. Enumerating a 10 M row / 1,627-tile dataset takes ~55 s in total, once — no
full scan, no dependence on the data's extent.

### D4. Writers mark the tiles they touch; the builder rebuilds only those

Every writer of static data — bulk import, camera create/removal, and (K-A) a community
correction changing a segment's effective value or the corrections switch flipping —
inserts the affected tiles into `static_packages` as `dirty` **in the same transaction
as, and after, the `static_data_state.version` bump**, carrying that version. The builder
clears a mark only if the snapshot it built from has a version ≥ the mark's, so a write
that lands *during* a build is never lost. One correction therefore rebuilds one tile,
not Europe. A fingerprint (`resolution | camera namespace | corrections overlay`) makes a
changed setting invalidate everything; anything done by hand with SQL marks nothing —
`npm run static-packages -- build --full` is the escape hatch, documented in
`operating.md`.

### D5. Who builds, and when

* **Small datasets (≤ `STATIC_PACKAGES_INLINE_BUILD_MAX_ROWS`, default 200 k):** the first
  request that needs packages builds them, as it always did — nothing changes for a small
  node, and the existing tests run unchanged.
* **Large datasets:** a request never builds. The background worker (`STATIC_PACKAGES_WORKER_ENABLED`,
  in the API process; or `npm run static-packages -- build` by hand) does. Until a
  complete set exists the manifest answers **503 `PACKAGES_BUILDING` + `Retry-After`**;
  from then on the last complete set keeps being served while newer changes wait for
  the next build (the packages' `built_for_version` says how current each tile is).
* **Debounce.** A bulk import marks tiles for hours; rebuilding per batch would redo the
  same tiles, so the worker waits until writes have been quiet for
  `STATIC_PACKAGES_DEBOUNCE_SECONDS` (30) — but never longer than `…MAX_WAIT_SECONDS` (900) since the
  oldest unbuilt change, so a steady trickle cannot starve it.
* **Lease.** A row in `static_package_state` (owner + expiry, renewed per tile) keeps the worker,
  the CLI and a second server process from building at once; a crashed builder blocks others for at
  most two minutes.
* **Resumable.** Every finished tile is in the database; an interrupted first build continues with
  what is left (a test builds one tile, stops, and checks nothing is built twice).

### D6. Delivery: cacheable, resumable, compressed

`ETag` (per representation: `"<hash>-br"`, `"<hash>-gzip"`, `"<hash>"`) with `If-None-Match` → 304;
`Accept-Encoding` negotiation between brotli, gzip and plain; `Range`/`If-Range` on the stored
representations so an interrupted multi-hundred-MB download **resumes** (client-lib item C.2);
`Vary: Accept-Encoding`; a content-addressed `…/packages/<tile>/<hash>` with `Cache-Control: … max-age=31536000, immutable`.
**`STATIC_PACKAGES_PUBLIC` (off by default)** makes that one route need no credential so a proxy or
CDN can serve it. Reason for a switch rather than a decision: the data is public OSM data and the URL is
unguessable-but-unsecret content, yet it lets anyone download from the operator's bandwidth without a
client credential, which contradicts "kein Sonderzugang am Auth-System vorbei" unless the operator opts
in. The manifest and the by-tile route stay authenticated either way.

### D7. The manifest stays small; `?since=` for updates

The manifest lists tiles with data, ~130 bytes each (`tile, hash, sizeBytes, gzipBytes, brotliBytes, path`);
at the recommended resolution that is a few hundred KB (numbers below), gzip'd to a fraction, and revalidated
with an `ETag`. Because a client that already has version *V* should not re-read a list of all of Europe,
`GET /v1/static-data/manifest?since=V` returns only tiles built after *V*, plus `removed` tombstones. This is
additive; the endpoint without a parameter is unchanged in meaning.

### D8. Partition resolution

The former default (H3 resolution 2, ≈ 86,000 km² per tile) was chosen for a small dataset; at Europe density its
tiles are hundreds of MB — too coarse to download, cache or resume sensibly. **Decided by the operator on 2026-09-25:
resolution 4** (≈ 1,770 km², a few MB per tile) **as the default in code**, not just as a recommendation:
every node of a network has to use the same value or their packages are incompatible and clients download twice, so it
must not depend on each operator remembering an environment variable. It changes the tile ids, which is harmless now
(no real users, the data set is rebuilt anyway) and would be a forced full bootstrap for every device later.
The resolution is written into every manifest (`partitionResolution`) as well as `GET /v1/config`, so a client
can tell a mismatch apart from data and re-bootstrap instead of silently syncing garbage; a node whose setting changes
logs a warning and rebuilds all packages. *Not built (a possible follow-up):* carrying the value in the root-signed network
configuration so that a node with a deviating value refuses to join.

### D9. `/v1/snapshot` refuses what it cannot carry

A snapshot with static data reads every row into memory. Above `SNAPSHOT_STATIC_MAX_ROWS` (1 M, planner estimate —
free) it answers `413 STATIC_DATA_TOO_LARGE_FOR_SNAPSHOT` and names `?staticData=false` plus the manifest. Below the
limit nothing changes. Better a clear refusal than one client request killing the node.

### D10. Bulk import: one statement per batch, still no events

`insert … select … from unnest(arrays)` per call instead of one `INSERT` per row (numbers below), the row cap is
`BULK_IMPORT_MAX_ROWS` (default 5000, up to 50,000; the route's body limit is raised to match). The rule is unchanged
and now has a test: **however much is imported, `event_log` gets zero rows**, the version rises once per call, and the
touched tiles are marked in the same transaction (so package versions are reliable).

### D11. Corrections (K-A) are unaffected, by design

`segmentKey` is a stored generated column; packages read the same overlay query as every other read path (so a package
always agrees with `nearby`/`lookup`); a correction's effective change marks its tile. K-A's rule "only a change of the
*effective* value bumps the version" matters more now: at Europe scale a version bump is a package rebuild for the tiles
concerned.

### D12. Migration 0007's table rewrite stays, documented as a maintenance window

The operator asked whether the lock is necessary at all, because the same migration will one day run on a
node with users. Checked against the online recipe (constant defaults, `CREATE INDEX CONCURRENTLY`, batched
backfill, `CHECK … NOT VALID` + `VALIDATE`): a *stored generated column* has no online form on PostgreSQL 16, and
the substitutes (trigger + batched backfill, expression index, side table) cost more than they save — bloat and
WAL from updating every row, a second non-transactional migration phase because the migrator runs everything
in one transaction, a readiness state for the half-backfilled window, or a permanent per-read cost (the backfill's
cost is an argument until `measure-scale --phase keycolumn` has run on a copy, see "Recording the numbers"). What
protects users is *when* the migration runs (the Europe node, before it has any), not making it online.
Instead of a fix, the branch adds a **migration lock policy**: `tests/unit/migration-locks.test.ts` requires every
lock-heavy statement (from 0007 on) to carry a `-- lock-ok(<table>): …` / `-- lock-trivial: …` comment, and the
migrate step prints the annotated ones as a warning with the table's row estimate. Full reasoning and the
window table: `operating.md`, "Migrations that take a heavy lock".

## Measured

All on PostGIS 16 in Docker on the operator's PC (16 GB RAM, the container capped at 2.5–3 GB), Node 24.
"Bayern" is the real import; the larger stages are it replicated across Europe (see the top of this document).

**Storage** (`npm run measure-scale -- --phase sizes`):

| rows (segments + signs) | database | segment table incl. indexes | per segment row |
|---|---|---|---|
| 0.44 M + 0.11 M (real Bayern) | 428 MB | 182.5 MB | 436 B |
| 2.63 M + 0.66 M | 1,456 MB | 1,111 MB (heap 702 + `geometry_key` 196 + GiST 108 + pkey 106) | 443 B |
| 10.09 M + 2.52 M | 4,876 MB | — | ≈ 440 B (linear) |

Index sizes and bytes per row do not move with the dataset — storage is linear, no surprises.

**Reads** (`--phase reads`, in-process, warm second pass, milliseconds):

| | real Bayern (0.44 M segments): median / p95 | 2.6 M segments: median / p95 |
|---|---|---|
| `GET /v1/speed-limit` (lookup) | 1.6 / 2.0 | 1.4 / 1.6 |
| `nearby` r = 200 m | 1.7 / 2.1 | 1.4 / 1.6 |
| `nearby` r = 2 km (≈ 220 KB) | 8.0 / 27 | 3.6 / 6.2 |
| `nearby` r = 20 km (14.6 MB) | 296 / 307 | 54 / 198 |
| `nearby` r = 50 km, the API maximum (43 MB) | 970 / 990 | 266 / 665 |
| `GET /v1/static-signs/nearby` r = 2 km | 1.7 / 3.4 | 1.3 / 1.8 |

*Before* the index fix the lookup took 1.2 s at 0.44 M rows (and would take ~30 s at 10 M): the fix is what makes the
point-lookup endpoints independent of the dataset size, and it is the only reason the numbers above look like this.
Latency is flat from 0.44 M to 2.6 M rows (the 2.6 M sample points happened to fall in sparser copies, hence smaller
responses). Response size, not dataset size, is what grows: **the large-radius `nearby` calls are the expensive ones**
(43 MB in one JSON response) and the map layer should not use them.

**Package generation** (`npm run static-packages -- build`, resolution 4, rows ordered by id):

| | old in-memory builder | streaming builder |
|---|---|---|
| 0.55 M rows | 6.2 s, **1.6 GB** peak process memory, one 108 MB response for the biggest tile | — (not re-run on this size) |
| 3.3 M rows | **dies** (heap out of memory under a 1.5 GB cap, after 9 s) | — |
| 12.6 M rows | impossible | enumeration of 1,627 candidate tiles 55 s; **75 tiles processed under a 512 MB heap cap** at ≈ 0.6–0.9 s per tile (65 with data: 188 MB of JSON → 44.7 MB gzip + 43.0 MB brotli, 2.9 MB average) — then the test database was killed by a Docker engine restart |

Compression at maximum effort: gzip 4.2×, brotli 4.4× on this data (at quality 5 both were 4.3×: the coordinates are
the bulk and are close to incompressible beyond that). A binary encoding would be the next lever (see "Not done").

**Bulk import** (5000-row batches over the real HTTP handler, local Postgres): **1,238 rows/s** with one INSERT per
row. The batched statement is implemented and tested; its throughput on the same database is to be recorded.

**Not measured yet — needs Docker, which is held back while the real Europe import runs** (the operator paused
other Docker work; the scratch database also proved to be one more thing competing for the same VM's memory):
* a *complete* package build on 12.6 M rows: wall-clock time, peak RSS of the process, tile-size distribution at
  resolutions 2/3/4/5, manifest size at each;
* batched-import throughput; the time of one incremental (single-tile) rebuild; `VACUUM ANALYZE`/`REINDEX` durations;
* all of the above **on the real Europe import** once it finished (`npm run measure-scale` and
  `npm run static-packages -- status` work against any `DATABASE_URL`) — the synthetic dataset is a stand-in for it.

## Interfaces for the other parts

* **A (ingestion):** nothing to change. The bulk-import endpoints are unchanged on the wire; a larger
  batch (`BULK_IMPORT_MAX_ROWS`, up to 50,000) is now cheaper per row. An import into a server that has
  the new code marks package tiles as it goes and builds them afterwards; into a server that has not,
  build with `npm run static-packages -- build` after upgrading (see the upgrade notes below).
  Migration 0007 (K-A) rewrites the segment table once under an exclusive lock (≈ 21 s per million rows) — do it while the
  node is empty or has no users; it is why a node with users and big data needs a maintenance window
  (`operating.md`, "Migrations that take a heavy lock", which also says why there is no online variant).
* **C (client-lib):** the manifest and partitions keep their shape; new, additive: `gzipBytes`/`brotliBytes`/`path`
  per tile, `?since=<version>` (with `removed`), `Range` + `If-Range` on packages (resume without starting over),
  the immutable `…/packages/<tile>/<hash>` URL, `503 PACKAGES_BUILDING` + `Retry-After` while the first build is
  running (retry, do not fail), `413 STATIC_DATA_TOO_LARGE_FOR_SNAPSHOT` from `/v1/snapshot` (use
  `?staticData=false`), and the partition resolution from `GET /v1/config` (recommended 4 — read it, never hard-code).
  What a complete bootstrap costs on the wire: ≈ 93 B per row over gzip, i.e. **≈ 1.4 GB for 15 M rows** (a measured
  ratio, not a forecast of the real row count) — that number is for the decision C is asked to inform.
* **D (web):** no server change needed; `GET /v1/speed-limit` stays point-wise and cheap (≈ 2 ms). Do not use
  `nearby` with a radius above a few km for the map — the API allows 50 km, which is 43 MB in dense areas.

## Recording the numbers on the real import

```bash
cd server
export DATABASE_URL=…            # the Europe node's database (a copy of it, or the node itself with the operator's OK)
export STATIC_DATA_PARTITION_H3_RESOLUTION=4  STATIC_PACKAGES_DIR=/somewhere/with/room
npm run measure-scale -- --phase sizes,reads --label "real Europe" --json europe-reads.json
NODE_OPTIONS=--max-old-space-size=512 npm run static-packages -- build      # time it; note the peak RSS
npm run static-packages -- status                                            # tiles, GB uncompressed/gzip/brotli
npm run measure-scale -- --phase packages,compression --label "real Europe"  # manifest size, largest tile, ratios
npm run measure-scale -- --phase import --import-rows 50000 --import-impl legacy   # then --import-impl batched
```

A node that predates this branch (the Europe node was set up from `main`) needs migrations 0007 and 0008 first —
0007 is the ≈ 21 s-per-million-rows rewrite of the segment table (K-A), so on 13 M segments about **5 minutes with
the table locked**. Operator's decision (2026-09-25): measure on a copy (`pg_dump`/restore into a scratch container)
first, then run the migration on the node itself — 5 minutes are harmless while it has no users. On the copy, also
measure the two things `operating.md` ("Migrations that take a heavy lock") only argues so far:
the migration itself (`npm run db:migrate`, wall time, the row estimate the warning printed), and, for the
rejected online variant, `npm run measure-scale -- --phase keycolumn --probe-rows 1000000` (rewrite vs. plain column +
batched backfill by ctid range + `CREATE INDEX CONCURRENTLY` on scratch tables built from a sample; time, WAL, table and
index growth, and a check that both produce the same keys) — the claim in `operating.md` is "slower and heavier than the rewrite",
still an argument until this has run. The phase never writes to the real tables, but generates WAL and I/O: a copy only.

## Not done, on purpose

* **A compact binary package format.** Coordinates delta-encoded as varints would be roughly 1.5× smaller than gzip'd
  JSON — real, but it is a wire-format change for every client; a proposal, not part of this task.
* **CLUSTER-ing the segment table on its GiST index.** Would make tile builds read sequentially. Untested here (needs a
  second copy of the table on disk); listed under maintenance in `operating.md`.
* **Multi-process package directories.** One directory, one builder at a time (the lease). Several API processes sharing
  a directory work (they only read); several *hosts* need the directory on shared storage or a CDN in front.
* **Removing `MAX radius` results.** `GET …/nearby` with the API maximum radius (50 km) returns tens of MB in a dense
  area (43 MB measured on Bayern). It does not depend on the dataset size, so it is not a scale problem — but the web layer
  should never ask for it.
