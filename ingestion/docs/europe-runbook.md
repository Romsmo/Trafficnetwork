# Europe base data — runbook

How the one-time Europe import is run, resumed, checked and (later) updated. The reasoning and the measured numbers are in
[`europe-feasibility.md`](europe-feasibility.md); this file is the procedure. Paths below are the ones used on the project's Windows PC
(`E:` = large HDD, `D:` = SSD); adapt them to the machine that runs it.

## What runs where

| Piece | Where | Why |
|---|---|---|
| Raw extract (35 GB), `.part`, `.verified` | `E:\tn-europe-import\data\downloads\` | sequential IO only, needs the space |
| Section files, state (`progress.ndjson`, `sections/`, `quarantine.ndjson`, `extract-meta.json`) | same `data` directory | the state directory is the only dedup protection — **never delete it** |
| osmium node-location index (≈2 GB, random access) | `D:\tn-europe-idx\` (`OSMIUM_INDEX_DIR`) | SSD |
| Europe server + Postgres | Docker project `tn-europe`, volume on `D:` | dedicated, EMPTY node — never a node that already holds a region |
| Secrets (`europe-node.env`, client credentials) | `E:\tn-europe-import\secrets\` | never in the repo |

## Steps

1. **Free the machine.** Pause other Docker-using work (RAM ≥ 8 GB free, `C:` ≥ 2 GB free). Keep the PC awake for the duration.
1b. **Keep the Docker VM from hoarding host memory** (Windows/WSL2 only): start `deploy/europe-node/keep-vm-memory-low.ps1` (detached, hidden; it stops when its stop file
   appears). Measured 2026-09-25: the VM's page cache, filled by the big file IO, grew `vmmemWSL` to 5.4 GB while the containers used ~1 GB; dropping the cache returned 1.8 GB to
   Windows at once. With Windows' commit memory nearly exhausted this hoarding is the likely reason the VM was killed several times (every container died). It changes no setting,
   it only drops the guest's page cache.
2. **Build the runner image** (ingestion CLI + osmium; a TLS-inspecting antivirus root CA can be supplied as `extra-ca.crt`):
   ```bash
   docker build --build-context certs=<dir with extra-ca.crt> -t trafficnetwork-ingest:europe ingestion
   ```
3. **Start the empty node** (`deploy/europe-node/docker-compose.yml`; create `europe-node.env` with `POSTGRES_PASSWORD`, `JWT_SECRET`):
   ```bash
   docker compose -p tn-europe --env-file <secrets>/europe-node.env -f ingestion/deploy/europe-node/docker-compose.yml up -d
   ```
4. **Mint a `bulk-import` client** on that node with the server's own `create-client` script and store id/secret in a file outside the repo.
5. **Run.** On Windows use the wrapper, which repeats the resumable run after every interruption until it completes (and stops after three attempts without progress):
   ```powershell
   powershell -ExecutionPolicy Bypass -File ingestion\deploy\europe-node\run-europe.ps1 -DataDir <data-dir> -IdxDir <ssd-dir> -NodeEnv <secrets>\europe-node.env -ClientEnv <secrets>\europe-client.env
   ```
   The underlying command (resumable — the same command continues after any abort):
   ```bash
   docker run --rm --memory=5g --network tn-europe_default \
     -v <data-dir>:/data -v <ssd-dir>:/idx --env-file <secrets>/europe-client.env \
     -e SERVER_URL=http://server:3000 -e OSMIUM_INDEX_DIR=/idx \
     trafficnetwork-ingest:europe --region europe
   ```
   Log lines to watch: `download progress` (every 30 s), `osmium still running`, `section started/finished`, `progress` (every 60 s: rows/s, quarantined).
6. **Resume after an abort:** run the same command. The download continues by HTTP Range (the last 64 MiB of the partial file are re-fetched as a safety margin
   and the whole file is hashed at the end), osmium is skipped if its sections are complete for this exact edition, finished sections are skipped without being read,
   and inside the current section every confirmed row is skipped.
7. **Only some sections:** `--section x10_y40,x0_y40`. Section ids are 10° tiles named by their south-west corner (`xm10_y40` = 10°W..0°, 40°N..50°N), listed in `sections/manifest.json`.

## Stop conditions (hold and investigate, do not just resume)

- osmium peak RSS above 3.5 GB (the memory inference in the feasibility report was wrong),
- `C:` below 0.5 GB free,
- import rate below 400 rows/s for 15 minutes,
- the run aborts with "more than N rows were quarantined" — a systematic schema mismatch; read `quarantine.ndjson` first,
- the Docker engine restarted (resume is safe, but find the cause first).

## After the run

The run's own numbers are in `state/europe/osm/`: `sections/*.json` (per-section rows by kind, skipped, quarantined), `quarantine.ndjson`,
`extract-meta.json` (edition, md5, replication header, osmium version and peak RSS, tag filter). Independently of the tool, count in the database:

```sql
select count(*) from speed_limit_segments;  select count(*) from static_signs;  select count(*) from fixed_speed_cameras;
select source, "source_license", count(*) from speed_limit_segments group by 1, 2;
```

The tool's confirmed counts must equal the table counts; any excess points to a batch whose response was lost after the server committed it (≤ one batch per such event).
Take a `pg_dump -Fc` as the seed for later nodes: static data is not federated, so every node needs its own base data and a restore is far cheaper than a re-import.

## Implicit speed limits (`maxspeed:type=DE:urban` …)

Resolved only where the OSM wiki's *Default speed limits* table gives one unambiguous number; skipped and counted otherwise. The rules and the generated table
are described in [`europe-feasibility.md`](europe-feasibility.md) §6; regenerate with `npm run generate:implicit-speeds -- <legal_default_speeds.json>`
(dataset: `westnordost/osm-legal-default-speeds`, CC BY-SA 2.0 / BSD-3, cited in the generated file's header).

## Updating later — NOT built, only noted

`extract-meta.json` stores the extract's replication header (`osmosis_replication_base_url`, `…_sequence_number`, `…_timestamp`). A later run would fetch
Geofabrik's change files from that sequence on (`https://download.geofabrik.de/europe-updates/…/NNN.osc.gz`, one per day), apply the same tag filter and import the
created/modified ways. That needs replace-by-identity on the server (the bulk import is insert-only without dedup): either a per-row `sourceRef` (`way/123@2026-09-24`)
or matching by the corrections feature's geometry key. A changed value for a geometry with an effective community correction must be flagged for review by the server,
never silently overwritten (`work order "addon-speed-limit-corrections" (kept outside the repo)`). This tool stays insert-only.

## Attribution (ODbL)

Every imported row carries `source=osm` and `sourceLicense=ODbL`. Any place that shows the data must credit **© OpenStreetMap contributors** and link to
<https://www.openstreetmap.org/copyright> (ODbL 1.0). The web UI's map/legend and the client documentation carry this notice; the implicit-speed table additionally credits the
OSM wiki (CC BY-SA 2.0).
