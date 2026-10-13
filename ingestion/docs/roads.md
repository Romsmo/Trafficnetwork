# Road network import (`--roads`)

The server (1.1.0, `server/docs/road-network.md`) needs the roads for three things: to **find the road two picked points lie on**
(a limit for a stretch), to **tie signs, cameras and community limits to a road**, and to know that an item **lies off every
road** (and is therefore not served). The speed import deliberately leaves roads out (it filters on speed information; every
drivable way would be ≈ 99 M ways in Europe). `--roads` is the separate, opt-in run for them.

```
npm run ingest -- --roads --region bayern            # download (if needed), filter, stream, post
npm run ingest -- --roads --region bayern --dry-run  # read and count, send nothing
```

## What it does

1. Downloads the region's Geofabrik extract (the same resumable, checksum-verified download the speed import uses; an extract
   already there is reused).
2. `osmium tags-filter` for `w/highway=motorway,…,track` (the list of the server's `DRIVABLE_HIGHWAYS`; `footway`, `path`, `cycleway`
   and the like are not roads here).
3. `osmium export` as GeoJSON-seq, **streamed** into batches (up to 1000 ways or ~600 kB each) for
   `POST /v1/bulk-import/roads`. Nothing is written to disk as GeoJSON.
4. Collects the H3 cells (resolution 8, edge ≈ 460 m) the ways pass through and posts the **complete** ones to
   `POST /v1/bulk-import/road-coverage`.

The server upserts per OSM way id (`w<id>`), so the run is **idempotent**: repeat it after a new extract or after an
interruption; nothing is duplicated and nothing is kept locally (there is no state directory for it).

## Coverage - why it is conservative

An extract does not say where its border is, and the server hides a sign as "off the road" **only in an area it knows
completely**: a wrongly "complete" border cell would hide real signs. So a cell counts as complete only when the roads touch it
**and every neighbour around it**. Cells at the border of the extract, and farmland without a single road vertex, are left out.
That is not wrong, only "not known": items in such cells stay delivered, and the server's own lookup can cover the area later.

## Size and time

* One row per drivable way in the server's `road_ways` table; Europe is ≈ 99 M ways. Plan the database for that, and run
  per region (`--region`) rather than all of Europe at once.
* The coverage step keeps the set of touched cells in memory (millions of cells for a country); for a very large region raise
  `NODE_OPTIONS=--max-old-space-size=…`.
* The server's body limit is 1 MiB; batches are cut by size as well as by count.
* `osmium-tool` must be on the PATH, as for the speed import.
