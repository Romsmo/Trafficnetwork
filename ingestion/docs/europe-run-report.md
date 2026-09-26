# Europe base data — run report (add-on A)

Run of 2026-09-25/26 on the project PC, against a dedicated, initially empty node (`tn-europe`), from the pinned Geofabrik edition
`europe-260924.osm.pbf`. Plan and reasoning: [europe-feasibility.md](europe-feasibility.md); procedure: [europe-runbook.md](europe-runbook.md).
Numbers below are **measured** on this run unless marked otherwise.

## Result

| Entity | Rows in the database | Confirmed by the tool | Difference |
|---|---:|---:|---|
| speed_limit_segments | 12,083,574 | 12,081,574 | **+2,000** — one re-posted batch, identified exactly (see "Duplicates") |
| static_signs | 1,550,801 | 1,550,801 | 0 |
| fixed_speed_cameras (stored, not served) | 45,025 | 45,025 | 0 |
| **Total** | **13,679,400** | **13,677,400** | |

* Every row carries `source=osm`, `sourceLicense=ODbL` (checked: one provenance group per table). Cameras stay stored-but-not-served: the server's namespace flag is off.
* 49 rows were **quarantined** (not imported, kept with the full row in `quarantine.ndjson`): 25 fractional limits (the server column is `integer`; e.g. `8.75`),
  23 implausible limits above 200 km/h (`240`/`250`/`300` — mapping typos), 1 implausible mph value. No batch was rejected by the server for content reasons (0 bisects after a 400).
* Estimated in the feasibility report: ≈15 M rows (12–18 M). Actual 13.68 M.

## Edition (provenance of the import)

| | |
|---|---|
| File | `https://download.geofabrik.de/europe-260924.osm.pbf`, 35,036,992,377 B, md5 `567554275ccd6a3f87caa415d07bc97a` (verified over the whole file) |
| Last-Modified | Thu, 24 Sep 2026 22:17:39 GMT |
| Replication header | sequence 4923, timestamp 2026-09-24T20:21:20Z, base URL `https://download.geofabrik.de/europe-updates` (recorded in `extract-meta.json` for a later update run) |
| Tag filter | `w/maxspeed,maxspeed:type,source:maxspeed` · `nw/traffic_sign` · `n/highway=speed_camera` (osmium 1.15.0) |
| Sections | 33 tiles of 10°×10°, 23,129,423 exported features |

## Duration

The run took **18 h of wall clock, but only about 3.3 h of work**; the rest was interruptions (below). Net time per phase, from the log:

| Phase | Net time | Note |
|---|---|---|
| Download 35.04 GB | ≈1 h 10 min | 12–13 MB/s, in two pieces (16.6 GB, then the rest after the Range resume) |
| md5 over the whole file | ≈10 min | E: HDD, sequential |
| osmium `tags-filter` | ≈10 min | **peak RSS 2,152 MB** — the feasibility inference (bounded by the ID space, 2.1–2.4 GB) held |
| osmium `export` into 33 tiles | ≈4 min | peak RSS 1,814 MB with the on-disk node index (Bayern: 0.19 GB) |
| Import | ≈1 h 30 min | 13.68 M rows at ≈2,500 rows/s (server side included; Launch L: 2,300 rows/s) |

Feasibility estimate for the whole run: 3.1–4.7 h. Actual net ≈3.3 h — the low end.

## Sizes

* **Database 4,122 MB**: speed_limit_segments 3,816 MB (heap 2,834 + indexes 975), static_signs 279 MB, fixed_speed_cameras 8 MB. ≈301 B/row (Launch L: 308 B/row) — the estimate of 4.6 GB (+≈1 GB for the K-A key column) was on the high side.
* `E:` data directory 41.5 GB (raw PBF 35 GB, 33 section files, progress log ≈0.5 GB, quarantine, meta); the Docker disk file on `D:` is 26.1 GB in total (holds this DB and the other stacks).
* Progress log ≈35 B/key → 0.5 GB for 13.7 M keys; the streamed replay and the compact numeric key set made resuming take seconds.

## Interruptions and errors (all resumed without data loss; details of each fix are in git)

1. **Docker VM killed** (16:39, "unexpected EOF") — several times during 24–26 Sep, also without this job. Evidence: the VM's Linux page cache, filled by the 35 GB download and the osmium/import IO, made `vmmemWSL` grow to 5.4 GB while the containers used ~1 GB; dropping the guest cache returned 1.8 GB at once. Windows commit memory was down to 1.7–2.9 GB free of 20 GB. Countermeasure: `deploy/europe-node/keep-vm-memory-low.ps1` (drops the cache when it exceeds 1.2 GB; no settings changed).
2. **The wrapper died with the Claude session** (a child process is killed when the session ends): 4.5 h without progress and Docker left crashed. Since then wrapper and cache-dropper are started detached (WMI parent).
3. **Docker Desktop startup crash (AF_UNIX rename bug)** twice after such crashes — the known `start-docker-desktop.ps1` workaround.
4. **Real bug: "413 Request body is too large"** (22:41–22:43). The server sets no `bodyLimit` (Fastify default 1 MiB); a 2,000-row batch of long LineStrings exceeded it, and the tool aborted instead of splitting the batch. The wrapper's no-progress guard stopped itself after 3 identical attempts, as designed. **Fixed** (`f30615b`): a 413 is bisected exactly like a 400 (safe: the size check runs before the route handler, so nothing is inserted); observed live afterwards — batches halved until accepted, no quarantine, section finished.
5. **PC went to sleep** at 00:51 (session idle) and was rebooted at 10:07; the import resumed at 10:11 and finished 10:19.

No download corruption (final md5 check passed over the resumed file), no server errors, 0 HTTP retries with backoff.

## Duplicates

The server has no dedup. A hard stop between "server committed the batch" and "progress line written" makes the resumed run post that batch again (documented worst case: one batch per such interruption). **Exactly one such event happened**: the resume at 10:12 re-posted 2,000 segments.

* Detected two independent ways: table count minus the tool's confirmed count = 2,000; and `scripts/europe-duplicate-check.sql` finds 2,105 repeated segment rows, of which **exactly 2,000 are ≥1 h apart in `imported_at` (all inserted within one second at 08:12:10 UTC)** and 105 are natural twins (identical geometry, limit and source on different OSM ways, inserted minutes apart, i.e. redundant but real data).
* Signs: 39,116 repeated rows are normal in OSM (identical signs at one spot) and equal the tool's count — no duplicate batch. Cameras: 4, same reasoning.
* **Clean-up is NOT done**: the deletion of the 2,000 re-posted rows was blocked by the permission system when I tried it, so it is left to the operator. The statement is ready (one transaction; deletes only repeated rows that are ≥1 h younger than the first copy; expected result 12,081,574 segments):

  ```sql
  begin;
  with ranked as (
    select id, imported_at,
           first_value(imported_at) over w as first_at,
           row_number() over w as rn
    from speed_limit_segments
    window w as (partition by md5(ST_AsEWKB(geometry)::text), speed_limit, speed_limit_unit, source order by imported_at, id)
  )
  delete from speed_limit_segments where id in (select id from ranked where rn > 1 and imported_at - first_at >= interval '1 hour');
  select count(*) from speed_limit_segments;  -- expect 12081574
  commit;
  ```

  The dump for later nodes should be taken after this clean-up.

## Coverage

Rows per 10° tile straight from the database (tile of the first vertex / the position; the 2,000 duplicates are included in the segment count of the tile where they were re-posted):

| Section | Segments | Signs | Cameras |
|---|---:|---:|---:|
| xm40_y30 | 95 | 0 | 0 |
| xm30_y30 | 4014 | 356 | 3 |
| xm30_y60 | 17477 | 62 | 17 |
| xm20_y30 | 8848 | 76 | 4 |
| xm20_y50 | 575 | 36 | 0 |
| xm20_y60 | 4194 | 38 | 2 |
| xm10_y30 | 168294 | 26553 | 869 |
| xm10_y40 | 651559 | 81285 | 1822 |
| xm10_y50 | 1300692 | 17329 | 3054 |
| xm10_y60 | 1938 | 41 | 0 |
| x0_y30 | 52294 | 3179 | 106 |
| x0_y40 | 2338321 | 275137 | 7812 |
| x0_y50 | 2700134 | 477187 | 5214 |
| x0_y60 | 43559 | 234 | 107 |
| x10_y30 | 32190 | 3869 | 143 |
| x10_y40 | 1421250 | 169341 | 7812 |
| x10_y50 | 1660849 | 326275 | 3859 |
| x10_y60 | 147217 | 3386 | 703 |
| x10_y70 | 250 | 7 | 0 |
| x20_y30 | 82293 | 4863 | 573 |
| x20_y40 | 554347 | 15832 | 1566 |
| x20_y50 | 357698 | 31478 | 1666 |
| x20_y60 | 203260 | 93690 | 1177 |
| x20_y70 | 2723 | 623 | 0 |
| x30_y30 | 33593 | 878 | 411 |
| x30_y40 | 77006 | 2100 | 1180 |
| x30_y50 | 131453 | 12740 | 4996 |
| x30_y60 | 12484 | 1191 | 587 |
| x30_y70 | 188 | 2 | 0 |
| x40_y30 | 2888 | 98 | 53 |
| x40_y40 | 45806 | 838 | 636 |
| x40_y50 | 24579 | 1887 | 532 |
| x40_y60 | 1506 | 190 | 121 |
| **Total** | **12083574** | **1550801** | **45025** |

Value distribution (top): 50 km/h 3.90 M, 30 km/h 3.30 M, 30 mph 544 k, 70 km/h 525 k, 80 km/h 514 k, 60 km/h 468 k, 40 km/h 463 k, 20 mph 436 k … — mph appears only in GB/IE-type regions, as expected.

### Spot checks (25 well-known places in 19 countries; `scripts/europe-spot-checks.sql`)

Every place has data within 2 km, and the nearest limits are plausible for the setting: urban 20/30/50 km/h, **mph in London** (20 mph at Trafalgar Square), 15 km/h in Madrid's pedestrian centre, 30 km/h in central Rome/Milan/Vienna/Bern. Highlights: Berlin 2,576 segments and 1,361 signs within 2 km; Helsinki 5,806 signs; Athens (585) and Lisbon (362 segments) are the thinnest. Sign coverage is patchy between countries because OSM's is (Budapest 1, Stockholm 1, Oslo 4 signs within 2 km vs Berlin 1,361) — a property of the source, not of the import. Full table: run the SQL file.

## Skipped rows by reason (features that were not turned into a row)

The import log runs at info level, where skips are not recorded. After the run the same normalizer was run again over all 33 section files (23,129,423 features):
it produces **13,677,449 rows** (12,081,623 segments, 1,550,801 signs, 45,025 cameras) — exactly the tool's confirmed 12,081,574 segments **plus the 49 quarantined rows**, i.e. the import and the recount agree to the row.

| Reason (features without a resulting row) | Count |
|---|---:|
| no `maxspeed` / `maxspeed:type` / `source:maxspeed` (e.g. ways kept only for a `traffic_sign`) | 437,485 |
| non-numeric `maxspeed` (`none`, `signals`, `variable`, `walk` …: no fixed numeric limit) | 428,704 |
| implicit `maxspeed:type` not resolved (deliberate, §6 of the feasibility report) | 53,620 |
| non-positive `maxspeed` (`0`) | 37 |
| `traffic_sign` on an area (closed way exported as polygon: no single position) | 9,067 |

Most frequent unresolved implicit values: `sign` 10,569 (a `source:maxspeed` of "sign" is not a limit), `CZ:urban` 10,422 and `FR:rural` 8,204 and `ES:urban` 6,060 (ambiguous sub-types → omitted on purpose), `GB:nsl_restricted` 7,025 / `GB:nsl_single` 1,301 / `GB:nsl_dual` 120 (mapping not evidenced by the wiki dataset), `PL:rural` 1,849, `IT:rural` 1,407, `CZ:rural` 1,104, `BE:urban` 1,095, `DE:motorway` 301. Together 53,620 ways = 0.4 % of the imported segments, so the conservative implicit-limit policy costs almost nothing (feasibility estimate: < 2 %).

## What is not done / left for later

* Duplicate clean-up and then `pg_dump -Fc` as the seed for further nodes — waiting for the operator (see above).
* The update path is documented only (replication header stored; the server needs replace-by-identity first) — see the runbook.
* Static-data volume for parts B/C: 12.1 M segments + 1.55 M signs. The Bayern snapshot was 195 MB, so the full snapshot is now the order of **5 GB**, as estimated.
* ODbL attribution: README and docs carry it; the web UI (part D) still has to show "© OpenStreetMap contributors" wherever the data is displayed.
