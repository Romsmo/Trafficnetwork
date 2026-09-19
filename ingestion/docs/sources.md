# Source catalog

Evidence gathered during Phase 3 planning (P3.0), 2026-09-19, unless noted otherwise. Every license/pricing claim below is linked; where a number couldn't be confirmed from a primary, current source, that's stated explicitly rather than guessed (`docs/prompt-phase3-ingestion.md` section 0.4: "nichts erfinden").

## OpenStreetMap — implemented (P3.2), on by default

- **License**: ODbL 1.0. Geofabrik's own extracts page states this directly: "Map data from OpenStreetMap, ODbL 1.0" — [geofabrik.de/geofabrik/free.html](https://www.geofabrik.de/geofabrik/free.html).
- **Attribution**: short form "© OpenStreetMap contributors", ideally linking to `openstreetmap.org/copyright` — [OSM Foundation attribution guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines) (page last modified 2026-09-10).
- **Extracts**: per-Bundesland `.osm.pbf` files at `download.geofabrik.de/europe/germany/<name>-latest.osm.pbf`, each with a same-named `.md5` checksum sidecar (verified live: `bayern-latest.osm.pbf.md5` returns a real MD5 alongside the file). Machine-readable catalog of every extract (id, parent, download URLs) at [download.geofabrik.de/index-v1.json](https://download.geofabrik.de/index-v1.json) — this is what `config/regions.json`'s `bbox` values were computed from (the index's own boundary geometry, not hand-drawn).
- **Tag data used**: `maxspeed`, `maxspeed:type` (implicit limits), `traffic_sign`. Current tag-usage counts per extract, from Geofabrik's own taginfo instance (`data_until: 2026-09-18`):

  | Extract | Size | `maxspeed` ways | `traffic_sign` occurrences |
  |---|---|---|---|
  | [Bayern](https://taginfo.geofabrik.de/europe/germany:bayern) | ~812 MB | 457,027 | 91,551 |
  | [Berlin](https://taginfo.geofabrik.de/europe/germany:berlin) | ~94 MB | 101,893 | 46,334 |
  | [Germany](https://taginfo.geofabrik.de/europe/germany) (whole country) | ~4 GB | 2,864,832 | 672,828 |
  | [Europe](https://taginfo.geofabrik.de/europe) (whole continent) | ~28–30 GB | 13,031,100 | 1,510,717 |

- **Tagging semantics**: `maxspeed=<number>` with no suffix is km/h (mph needs an explicit `"<n> mph"` string) — [Key:maxspeed](https://wiki.openstreetmap.org/wiki/Key:maxspeed) (last edited 2026-08-11). Implicit limits via `maxspeed:type`: `DE:urban`→50, `DE:rural`→100, `DE:zone30`→30, `DE:zone20`→20 — [Key:maxspeed:type](https://wiki.openstreetmap.org/wiki/Key:maxspeed:type) (2025-05-30), [Default_speed_limits](https://wiki.openstreetmap.org/wiki/Default_speed_limits) (2026-03-07). `DE:motorway` has no blanket numeric limit and `DE:living_street` is documented only as the non-numeric `walk` — both are skipped by the normalizer, not resolved to an invented number (see the P3.0 plan's decision 2). `traffic_sign` uses a hyphenated sign-catalog reference (`DE:274-50`), not a comma-embedded value — [Key:traffic_sign](https://wiki.openstreetmap.org/wiki/Key:traffic_sign), [DE:Tag:traffic_sign=DE:274-30](https://wiki.openstreetmap.org/wiki/DE:Tag:traffic_sign=DE:274-30).
- **Processing tool**: `osmium-tool` (subprocess), not a Node library — see the P3.0 plan's decision 2 for the full comparison against `osm2pgsql`, `pyosmium`, native Node PBF parsers, and Overpass API (Overpass explicitly discouraged for bulk regional extraction by its own [fair-use policy](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html) and by [Geofabrik's own guidance](https://www.geofabrik.de/data/overpass-api.html)).

## HERE (Traffic API v7, Route Matching API v8) — catalog only, off by default

- **Status**: not implemented (no developer account/contract as of this round — see the project owner's P3.0 decision). Config accepts `HERE_ENABLED`/`HERE_MONTHLY_CALL_LIMIT` so enabling it later doesn't require a breaking config change, but `pipeline/registry.ts` has no worker for it.
- **Caching/redistribution restriction** (confirmed from primary text): HERE Platform Terms, §6.4(j) — no caching of Results beyond 30 days (Positioning results / Japan-sourced content: 24 hours) — [here.com/en-gb/terms/here-platform-terms-september-2023](https://www.here.com/en-gb/terms/here-platform-terms-september-2023).
- **Pricing**: **could not be confirmed from an authoritative current source.** HERE's own pricing page (`here.com/get-started/pricing`) is JS-rendered and didn't yield a pricing table to a direct fetch. Third-party aggregators disagree with each other by roughly 6x on the free-tier size (~30,000/month vs. 250,000/month on a different distribution channel) and give at least three different overage prices depending on sub-product. `docs/concept.md`'s existing "250,000/month free, then $1/1,000" figure predates this research round and could not be independently re-confirmed today — treat it as unverified, not current fact.
- **Consequence**: `HERE_MONTHLY_CALL_LIMIT` has no default in `src/config/env.ts` — an operator must supply it from their own actual account/contract before this source could ever be enabled.

## TomTom (Traffic Incidents/Flow API) — catalog only, off by default

- **Status**: not implemented (same reason as HERE).
- **Free tier** (confirmed live from TomTom's own pricing page, fetched 2026-09-19): [docs.tomtom.com/pricing](https://docs.tomtom.com/pricing) — Traffic Incidents API (Details) 2,500/month free; Traffic Flow & Incidents API (Vector Tiles) 200,000/month free; Traffic Flow & Incidents API (Raster Tiles) 200,000/month free; Traffic Flow API (Segment Data) 20,000/month free. No overage price is published on this page for any tier.
- **Retention clause**: a 60-day retention limit on downloadable Traffic Analytics products is reported at `docs.tomtom.com/legal/terms-and-conditions` §11.6.12, but that page is also JS-rendered and could not be fetched directly to quote primary text — **unverified, flag for manual confirmation** before relying on it.
- **Consequence**: same as HERE — no default call limit; required config if ever enabled.

## Mobilithek (BASt/BMDV national access point for mobility data) — catalog only, off by default

- **Status**: not implemented. No specific dataset has been identified as worth importing yet (per the project owner's P3.0 decision) — a real worker would need one named dataset with a confirmed license, not the platform in general.
- **What it is**: Germany's National Access Point for mobility data (absorbed the older Mobilitätsdatenmarktplatz/MDM and mCLOUD), operated with BASt support under the BMDV — [bast.de](https://www.bast.de/DE/Themen/Fahren/HF_3/Massnahmen/mobilithek.html), [bmv.de](https://www.bmv.de/SharedDocs/DE/Artikel/G/mobilithek.html). Platform confirmed live at [mobilithek.info](https://mobilithek.info/) (blog activity as recent as 2026-08-25).
- **License**: **varies per dataset** — there is no single blanket platform license. "Datenlizenz Deutschland – Namensnennung – Version 2.0" is one commonly used option (seen on specific dataset pages), but each dataset's publisher chooses independently. Any future Mobilithek worker must record the specific dataset's own license as its `sourceLicense`, never a generic default.

## Autobahn-API (`bundesAPI/autobahn-api`) — catalog only, off by default

- **Status**: not implemented.
- **License**: **none** — confirmed today via the GitHub REST API (`GET /repos/bundesAPI/autobahn-api` → `"license": null`), and no LICENSE file or usage statement in the README or on the [bund.dev listing](https://autobahn.api.bund.dev/). Matches `docs/concept.md`'s existing "ungeklärt" assessment; this is a current re-confirmation, not a stale carry-over.
- **Repo activity**: last actual code push 2023-06-03 (GitHub API `pushed_at`) — 3+ years stale, though the "no license" status is unaffected by that.
- **If ever implemented**: `sourceLicense` would be hardcoded to `"ungeklärt"` on every row (a documented fact about the source, not an operator-configurable choice), per the project owner's original decision to use this source anyway while marking it clearly.

## Rejected: undocumented forum-scraped data

During P3.1 the project owner offered a dataset (`bayern_ohne_stau_panne.json`, ~500 fixed/mobile speed-camera and hazard records covering Bavaria and Tirol/Austria) described as compiled by a self-written scraper across unnamed internet forums. This was **not added to the catalog and no worker was built for it**: there is no identifiable single source with terms to evaluate, the underlying content originates from third-party forum posters who haven't consented to redistribution through a federated network, and speed-camera data is already this project's highest-risk category pending the legal review `docs/todo.md` already flags as outstanding. Recorded here so the decision and its reasoning aren't lost — see the project conversation history for the full exchange.
