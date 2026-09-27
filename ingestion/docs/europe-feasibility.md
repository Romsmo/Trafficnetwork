# Europe base data — feasibility report (add-on A)

Status: written 2026-09-25 **before the run** (sections 1–12); section 13 records the Bayern rehearsal and the amendments made before the real run started
(2026-09-25 16:16). The run's outcome is reported separately (`europe-run-report.md`). Every number is labelled
**measured** (real run on this PC), **cited** (public source) or **estimated** (extrapolation, with the method).

## 1. Verdict

The import is feasible, in one uninterrupted window of roughly **4–6 hours** (3.1 h optimistic, 8 h pessimistic).
Both the user's PC and a rented server can do it; the PC is the only machine that exists today.
The PC has enough disk (raw data on `E:`, database on `D:`) and enough RAM **if nothing else heavy runs in Docker at the
same time**. The two real risks are environmental, not algorithmic: `C:` fluctuates between 0.1 and 3 GB free, and Docker Desktop
restarted its engine on 2026-09-24 while several chats were running containers (two of my measurement runs died with
`unexpected EOF` within a minute, and other chats' containers exited with code 255 at the same time).
Recommendation: run it on the PC into a **dedicated, empty Europe node** (own compose project, own volumes), with the other
Docker-using chats paused, and keep a `pg_dump` afterwards as the seed for the later rented server (see section 9).

## 2. Source

| Item | Value | Kind |
|---|---|---|
| Newest file today | `https://download.geofabrik.de/europe-260924.osm.pbf` (= `europe-latest.osm.pbf`) | cited |
| Size | **35,036,992,377 bytes (32.6 GiB)** | cited (`Content-Length`) |
| Last-Modified | Thu, 24 Sep 2026 22:17:39 GMT | cited |
| MD5 | `567554275ccd6a3f87caa415d07bc97a` (`…osm.pbf.md5`) | cited |
| Range requests | `Accept-Ranges: bytes` — the download is resumable | cited |
| Dated snapshots present | `europe-260922`, `-260923`, `-260924` (35.03 GB each) | cited |
| Replication | `https://download.geofabrik.de/europe-updates` (sequence 4922 was 2026-09-23T20:22:04Z) | cited |

`europe-latest` moves every night. **The run pins the dated URL** (`europe-YYMMDD.osm.pbf`) so a resume after a pause never
mixes two editions; the md5, the header timestamp and the replication sequence are written to `extract-meta.json` at start
and checked on every resume. Geofabrik only keeps a limited number of dated files, so a resume after a long pause must finish
the download before the file disappears (the download refuses to continue against a different size/md5).

Download rate measured on this PC on 2026-09-24: **8.06 MB/s** → 35.04 GB ≈ **72 min**. A datacenter link would take minutes.

## 3. Measurements (Bayern, real extract, osmium 1.16.0 in Docker)

Extract: Bayern 852,581,936 B, 80,459,441 nodes, 11,897,271 ways, header timestamp 2026-09-22T20:22:59Z (sequence 4912).

| Step | Old filter `w/highway nw/traffic_sign n/highway=speed_camera` | **New filter** `w/maxspeed,maxspeed:type,source:maxspeed nw/traffic_sign n/highway=speed_camera` |
|---|---|---|
| `tags-filter` wall / peak RSS | 15.8 s / 2.10 GB | 16.4 s / 2.06 GB |
| Filtered PBF | 244.6 MB (18.65 M nodes, 3.22 M ways) | **60.3 MB** (3.33 M nodes, 0.51 M ways) |
| `export` wall / peak RSS | 11.5 s / 0.56 GB | 2.0 s / 0.16 GB |
| GeoJSON-seq | 1,298 MB, 3.81 M features | **324 MB, 0.80 M features** |
| Normalized rows | 548,383 | **548,383** |

* **The two filters produce identical output.** Compared on the host with the real `normalizeFeature`: same 548,383 keys,
  same content hash for every row (438,595 speed-limit segments, 109,646 signs, 142 cameras; 0 keys only in one side).
  The old filter only adds ways that carry no speed information (2.77 M "no maxspeed" skips). At Europe scale that is the difference
  between 98.8 M highway ways (taginfo) and 13.0 M ways with `maxspeed` — ≈53 GB vs ≈10–13 GB of GeoJSON.
* `--index-type=sparse_file_array` (node index on disk instead of RAM) gives a byte-identical export at 0.19 GB RSS.
* Peak RSS of `tags-filter` is the same (≈2.1 GB) for a 18.6 M-node and a 3.3 M-node result. That fits osmium's ID sets
  being bitmap chunks sized by the **highest OSM ID**, not by the amount of data (≈13.5 B node IDs / 8 ≈ 1.7 GB + way IDs ≈ 0.2 GB).
  **Inference, not measured on Europe:** RSS stays ≈2.1–2.4 GB for the full file. The run caps the runner container at 5 GB and
  logs `/usr/bin/time -v` for every osmium step, so a wrong inference kills only that container.
* Launch L (measured 2026-09-23): 548 k rows imported in 242 s including osmium (≈2,300 rows/s all-in), database
  169 MB (≈308 B/row), server RSS 250 MB → 1.04 GB after import, Postgres 138–370 MB.
* This PC (measured today): `E:` HDD (Seagate ST5000LM000) sequential **write 136 MB/s, read 122 MB/s**, 4.5 TB free;
  `D:` SSD 455 MB/s read (write 89 MB/s sustained, 3 GiB), 54 GB free; `C:` 0.1–3.0 GB free (fluctuating);
  RAM 15.9 GB of which only 2.4–4.5 GB were free while other chats' containers were running; Docker VM 7.7 GB.

## 4. Scaling to Europe (estimated)

Factors: input ×41 (35.0 GB / 0.85 GB); rows ×≈27 (13.04 M `maxspeed` ways per taginfo + ≈1.5–2 M signs + a few thousand cameras
≈ **15 M rows**, planning range 12–18 M, hard cap 20 M).

| Resource | Estimate | Basis |
|---|---|---|
| Download | 72 min | 8.06 MB/s measured |
| `tags-filter` (2 passes over 35 GB) | 12–20 min | 2×35 GB / 122 MB/s ≈ 10 min I/O; Bayern CPU rate 52 MB/s ≈ 11 min |
| `export` (≈100 M node locations, on-disk index) | 3–8 min | Bayern 2.3 s ×41, index I/O |
| Row normalization | 2–4 min per pass | Node parse of ≈10–13 GB GeoJSON-seq |
| Import | **1.6 h** at 2,600 rows/s … **3.2 h** at 1,300 rows/s (index growth) | Launch L |
| **Total** | **≈3.1 h – 4.7 h**, plan 6 h, worst case 8 h | |
| Raw PBF | 35.0 GB on `E:` | cited |
| Filtered PBF + section files + state | ≈2.5 + 10–13 + 0.7 GB on `E:` | Bayern ×27–41 |
| osmium node index | ≈1.6–2 GB on `D:` (random access → SSD) | 100 M × 16 B |
| Database | **≈5–6 GB** (4.6 GB at Launch L density + ≈1 GB for the corrections `geometry_key` column/index), plan 10 GB incl. WAL and bloat on `D:` | 308 B/row |
| RAM peak | osmium 2.1–2.4 GB + Postgres 0.4–1 GB + server 0.3–1.1 GB + ingestion 0.4–0.8 GB = **≈4–5 GB inside the 7.7 GB Docker VM** | measured parts, summed |

Disk plan on the PC: **`E:` ≈50 GB** (raw + intermediates + state), **`D:` ≈12 GB** (database, index), **`C:` nothing** (the run
sets `TEMP`/`TMP` to `E:`; but Windows, pagefile and Docker Desktop live on `C:`, which is why its 0.1 GB moments matter).

Side finding for parts B/C: the static-data snapshot was 195 MB for Bayern (measured), so ≈**5 GB for Europe**, and the
manifest took 6 s per call (≈160 s at Europe scale). That is the "static data fully on every device" question of part C.

## 5. One Europe file or per-country extracts?

**Decision: one pinned `europe-YYMMDD.osm.pbf`, imported in geographic sections that are cut after filtering.**

| Criterion | One Europe file | Per-country extracts |
|---|---|---|
| Peak RAM | ≈2.1–2.4 GB (bounded by ID space, see §3) | same or smaller, but no real gain |
| Peak disk | 35 GB raw on `E:` | ≈5 GB (largest country), raw deleted after each |
| Resume after abort | download by Range; osmium ≈20 min restart; import by per-batch log | per-country restart; import as before |
| **Coverage** | exactly what Geofabrik calls Europe | must be assembled from the index (meta-extracts `alps`, `britain-and-ireland`, `dach` overlap; islands and small states can fall through) → gaps/overlaps that are hard to notice |
| **Border ways** | every way exactly once | complete-ways extracts contain border-crossing ways in **both** countries → needs a shared dedup group |
| Edition | one timestamp + one replication sequence → clean update path | ≈45 files, possibly different sequences/dates |
| Failure isolation | via sections (below) | natural |

Memory does not favour per-country (the filter is streaming and bounded), and resume is equally good (Range download, per-batch
state). Per-country only wins on disk, and disk is plentiful on `E:`. It loses on coverage correctness, duplicates and edition
consistency, which are exactly what the report after the run has to prove. Where per-country would help — independent, restartable
sections with their own progress — the import gets that from **sections cut from the filtered output**: the exporter's
GeoJSON-seq stream is split once into coarse geographic tiles by the first vertex of each feature (10°×10° grid,
≈60 non-empty tiles, ≈0.2–3 GB each). Each tile is a section with its own `done` marker, progress and error report; the
state keys are global per OSM object, so a way can never be imported twice regardless of tile.

## 6. Filter and implicit limits

* **Filter:** `w/maxspeed,maxspeed:type,source:maxspeed nw/traffic_sign n/highway=speed_camera`. No buildings, POIs, landuse, and no
  highway ways without speed information. Ways that carry `maxspeed` but no `highway` (railways etc.) are dropped in
  `normalizeFeature`, as before. Proven equal to the old filter in §3.
* **Implicit limits (`maxspeed:type` / `source:maxspeed`, e.g. `DE:urban`) — decision: resolve only what is evidenced and
  unambiguous, omit the rest, count every omission by reason.** Evidence: `legal_default_speeds.json` from
  `westnordost/osm-legal-default-speeds` (code BSD-3, data CC BY-SA 2.0), generated from the OSM wiki page *Default speed limits*,
  revision 2951812 of 2026-02-04. Rules:
  1. `CC:urban` / `CC:rural` resolve to the country's plain entry **iff** it is a plain number (or `NN mph`) and **no refinement
     of the same base type in that country carries a different value** (e.g. `FR:rural` = 80 but 90 on 2×n-lane roads,
     `ES:urban` = 30 but 20/50 for other sub-types → **omitted**, because a blanket number would be wrong on some ways).
     Result today: **76 resolved country/type pairs**; **13 deliberately omitted as ambiguous** (CZ, ES, FR, IS, LT, LV, MK, NL, PL, TR, XK …).
  2. `CC:zoneNN` resolves to `NN` km/h (the number is in the tag itself; not in mph countries).
  3. `motorway`, `living_street`, `nsl_*` (GB) and everything else stay **unresolved** (no blanket numeric limit / mapping not evidenced by the dataset).
  The existing four DE values stay identical, so Bayern and Europe are consistent.
  Effect on volume: implicit-only ways are ≈225 k of ≈13 M (≈1.7 %) — the choice moves the row count by less than 2 %, which is why
  the conservative option costs almost nothing. The generated table lives in the repo with the CC BY-SA 2.0 notice; the run report
  lists the skip counts per reason.

## 7. Robustness design (what gets built before the run)

1. **Pinned download**, HTTP-Range resume, md5 against the sidecar, `.part` file, refusal to mix editions.
2. **Streaming everything:** state replay is streamed line by line (the old `readFile` of the whole log breaks at Europe size —
   V8 string limit ≈536 M chars); done-keys live in a compact numeric open-addressing set (≈0.2 GB for 15 M keys instead of ≈1.4 GB as strings).
3. **Sections** (§5) with per-section markers, progress lines and a final per-section report; `--section` re-runs one.
4. **Idempotency:** unchanged rule — a progress line is fsynced only after the server confirms `inserted == batch size`.
   Residual window: a batch whose HTTP response is lost *after* the server committed is retried and can duplicate ≤ one batch (2,000 rows).
   The post-run check compares DB row counts with the confirmed counts and looks for equal-geometry duplicates.
5. **Pre-validation + bisect/quarantine:** rows are validated client-side against the server's schema; if the server still answers
   400, the batch is bisected, the offending row is written to `quarantine.ndjson` with the server's `error.details`, and the run continues
   (the `maxspeed=0` incident took down a whole batch).
6. **Backoff:** full-jitter exponential retry on 429/5xx already exists; it additionally honours `Retry-After`, and a pacing floor between batches keeps the server's CPU bounded.
7. **Preflight guard:** the tool refuses to start against a server that already contains rows unless `--allow-non-empty` is given —
   the server has no dedup, so importing Europe on top of node A (which holds Bayern) would double Bayern.

## 8. Corrections (K-A) and ODbL

* **Corrections.** The import is **insert-only**; it never updates or deletes rows. Community corrections live in the server's overlay
  keyed by `segmentKey` (a generated column over the geometry, branch `feature/speed-limit-corrections`, not merged). If a later import
  brings a different value for a geometry that has an effective correction, the server keeps the correction and flags `needsReview`
  against `base_value`; nothing is silently overwritten. For this first run the target node is empty and has no corrections, so the
  rule is trivially satisfied; the tool's part is (a) insert-only, (b) stable geometry (coordinates are passed through unchanged), (c)
  the empty-target guard. If K-A is merged before the run, the node uses the migrated schema (the ≈5 min exclusive-lock migration measured by K-A at ≈21 s per million rows is avoided by migrating while empty).
* **ODbL.** Every row carries `source=osm` and `sourceLicense=ODbL` (unchanged, never obscured). The server schema has **no per-row
  source id or edition**, so the edition (file, timestamp, sequence, md5) is recorded in `extract-meta.json` and in the run report.
  Recommendation for part B: an optional `sourceRef` column (`way/123@2026-09-24`) would make the later update path exact.
  Attribution "© OpenStreetMap contributors, ODbL 1.0" goes into `ingestion/README.md`, `ingestion/docs/sources.md` and the web UI (part D). The
  derived implicit-speed table additionally credits the OSM wiki (CC BY-SA 2.0) and `westnordost/osm-legal-default-speeds` (BSD-3).

## 9. Where to run

| | User's PC | Rented server |
|---|---|---|
| Exists today | yes | **no** (Launch P not started) |
| Download 35 GB | 72 min | ≈6 min at 100 MB/s |
| Disk / RAM | fits (`E:` 50 GB, `D:` 12 GB, ≈5 GB RAM) | fits on any 8 GB / 100 GB machine |
| Stability | Docker engine restarted on 2026-09-24 under concurrent load; `C:` 0.1–3 GB | stable, no other chats |
| Result | database on the PC → `pg_dump` (est. 2–3 GB) as seed for the server later | database where it is needed |

Static data is **not** federated (only device-signed hazard reports are), so every node needs its own base data; a dump/restore
of the finished Europe database is far cheaper than repeating the import. **Recommendation: PC now, into a dedicated empty Europe
node, other Docker chats paused, keep-awake on, `pg_dump` at the end.** If the rented server exists first, the same tool runs there unchanged
(only `SERVER_URL`, credentials and paths differ).

## 10. Preconditions and abort criteria

Before start: (1) the user's go and the location decision; (2) other Docker chats paused (RAM ≥ 8 GB free); (3) `C:` ≥ 2 GB free;
(4) a dedicated empty Europe node built from `main` (own compose project, own port, own volumes on `D:`); (5) work directory
`E:\tn-europe-import\`.
Abort/hold: RSS of an osmium step > 3.5 GB; `C:` < 0.5 GB; import rate < 400 rows/s for 15 min; more than 500 rows quarantined in total
(the tool aborts by itself — indicates a systematic schema problem, not stray bad rows); Docker engine restart (resume is safe, but the cause
must be understood first).

## 11. Update path (documented, **not built**)

The header of the pinned file carries `osmosis_replication_base_url`, `osmosis_replication_sequence_number` and
`osmosis_replication_timestamp`; the run stores them in `extract-meta.json`. A later run fetches the Geofabrik change files
(`europe-updates/…/NNN.osc.gz`, one per day) from that sequence on, filters them with the same tag filter and imports created/modified
ways. This needs one thing the server does not have today: **replace-by-identity**. The current bulk import is insert-only without
dedup, so applying changes safely requires either the `sourceRef` column above or `geometry_key`-based matching from K-A. That is a
server task (part B / K), not part of this run.

## 12. After the run

The report will list rows per entity, duration per phase, DB size (before/after, and dump size), skip counts by reason, quarantined rows,
retries/backoff events, and spot-checks of known places in at least eight countries (a speed-limit way, a sign and, where present, a
camera per country) by direct database query, plus the section table with per-tile counts.

## 13. Rehearsal on Bayern (2026-09-25) and amendments to the plan

Before the Europe run the whole new pipeline was run once end to end on the Bayern extract (edition Last-Modified 2026-09-25 04:04 GMT, replication sequence 4914),
in the runner container (osmium 1.15.0), against a throwaway server, with 1° sections (21 sections):

| | Result |
|---|---|
| Download (real Geofabrik, Range-capable client) | 12.6 MB/s |
| `tags-filter` / `export` | 23.6 s, peak RSS 2,048 MB / 6.8 s, 187 MB (osmium's own `time -v`, recorded in `extract-meta.json`) |
| Sections | 21 files, 803,066 features |
| Import | 438,719 segments + 109,840 signs + 142 cameras = 548,701 rows in 235 s ≈ 2,335 rows/s; **5 rows quarantined** |
| DB | **exactly the tool's confirmed counts**; 169 MB (≈308 B/row, as at Launch L) |
| Progress log | 18.9 MB for 548 k rows (≈35 B/row → ≈0.5 GB for Europe) |

* The 5 quarantined rows are real Bayern data: five neighbouring ways (way/1496199848–52) tagged `maxspeed=300`. The plausibility ceiling (200 km/h, 125 mph)
  stops them; the old tool would have imported "300 km/h" limits. They stay in `quarantine.ndjson` with the full row.
* Compared with Launch L (438,595 / 109,646 / 142 on the 2026-09-22 edition) the counts differ by the newer edition, the wider implicit-limit table and these 5 rows — not by the filter change.
* **Interruption test.** One `docker kill` mid-import, then two involuntary Docker-VM restarts during the resumed runs, then a final resume: the database ended with the expected signs and cameras and **exactly 2,000 segments too many**
  — one re-posted batch, i.e. the documented worst case for *one* of the three interruptions (a hard stop between "server committed" and "progress line written"). It is detected by comparing table counts with the confirmed
  totals and by `scripts/europe-duplicate-check.sql` (2,000 repeated segment rows found). The tool cannot close this window from the outside, because the server offers no way to ask "is this batch already in?".
* Resume behaved as designed: finished sections skipped without reading them, `alreadyDone` keys restored from the streamed log, download/osmium skipped, no unresolved state.
* The 5 integration tests (real server, real osmium, fixtures) pass, including the new ones: empty-target guard refuses a populated server, sectioned region imports the same rows, re-run skips finished sections.

Amendments made because of the rehearsal and of the environment:

1. **Auto-resume wrapper** (`deploy/europe-node/run-europe.ps1`): Docker Desktop's VM restarted several times on 2026-09-24/25 (every few minutes at worst, also without my involvement; host commit memory was down to 1.7–2.9 GB free of 20 GB, `C:` at 0.1–3 GB),
  killing every container. The wrapper re-runs the resumable import until it completes and stops when three attempts in a row change nothing.
2. **Row validation** also rejects fractional limits (the server column is `integer`, its schema is not — a 500 that no retry fixes) and NUL characters in text.
3. **Duplicate check** SQL for after the run (segments only; identical signs at identical positions are normal in OSM: 2,684 in Bayern).
4. `traffic_sign` on areas (closed ways exported as polygons) is logged at debug level; it happened tens of thousands of times in the rehearsal.
