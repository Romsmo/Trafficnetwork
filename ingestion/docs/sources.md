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

## Add-on Q (source catalog: speed cameras, traffic signs, roadworks) — Q0, 2026-09-26

Research for `docs/prompt-addon-source-catalogue.md`. Legal frame per that prompt (§0): a source is added only if its
terms *explicitly* permit redistribution (never assumed from "the data looks free"); §87a UrhG / EU database-directive
sui-generis protection applies even to individually-unprotected data points once a substantial part of a maintained
database is taken. Traffic-light column (Ampel): **frei** (redistribution explicitly permitted, cited) / **auflagen**
(permitted with conditions — stated) / **ungeklärt** (off by default, needs the operator's decision) / **verboten**
(not built). Every entry below was checked live on 2026-09-26 unless noted.

### Q1 + Q2 are already delivered — no new code needed

The Europe basemap import (`phase3/europe-basemap`) already processes the *same* Geofabrik PBF this add-on would
otherwise need a second pass for, and already extracts both entities the OSM tag filter includes them:

- **Fixed speed cameras** (`highway=speed_camera`, node only) — [Tag:highway=speed_camera](https://wiki.openstreetmap.org/wiki/Tag:highway%3Dspeed_camera)
  (page last edited 2026-04-20; de-facto status, not an officially standardized tag). `normalize.ts` emits a
  `fixed-speed-camera` row with `source=osm, sourceLicense=ODbL`. **The server's speed-camera namespace stays disabled**
  (`SPEED_CAMERA_NAMESPACE_ENABLED`) regardless — rows are stored, never served, unchanged from the existing policy.
  Related tags the wiki documents (`direction`, `maxspeed`, `ref`, `surveillance:type=ALPR`) are **not** captured —
  matches the project's existing "don't guess, only what's evidenced" stance; could be added later as optional columns
  if a real use case needs them.
- **Traffic signs** (`traffic_sign=*`, node or way) — [Key:traffic_sign](https://wiki.openstreetmap.org/wiki/Key:traffic_sign).
  `splitSignUnits()` (commit `ff4ebf7`) already keeps the raw, country-prefixed value verbatim (`DE:274-50`,
  `DE:239,1022-10`, free-text bracket values) — exactly what §3.3 of the add-on prompt asks for ("Rohwert erhalten,
  unbekannte Codes unverändert durchreichen"). No per-country mapping table exists yet (there's nothing to map:
  the value is stored as OSM wrote it), which is fine for §3.3's OSM baseline but not yet for §3.3's "amtliche
  Quellen... nationale Schildcodes auf das gemeinsame Schema abbilden" (see Q4 below — a real mapping table is only
  needed once a *second*, differently-coded source is added).
- **Gap, not yet closed:** neither row type stores the OSM id as a queryable field (only as the ingestion tool's own
  local dedup key) — the server schema (`db/schema/cameras.ts`, `static.ts`) has no `source_ref` column. Matches the
  same gap already flagged in `europe-feasibility.md` §8 for speed-limit segments; relevant here too if a later
  DATEX II/NVDB import needs to deduplicate against the OSM rows by position rather than a shared id.

### Roadworks (`construction`, time-limited) — DATEX II and national feeds

| Source | Country | Format | Access | License | Ampel | Notes |
|---|---|---|---|---|---|---|
| [transport.data.gouv.fr — Événements routiers](https://transport.data.gouv.fr/datasets/evenements-routiers-sur-le-reseau-routier-national-non-concede) | FR (non-concédé national network) | DATEX II XML | direct download, **no registration** | **Licence Ouverte 2.0** (Etalab) — attribution required, otherwise unrestricted reuse incl. commercial | **frei** | Real-time XML + hourly aggregate; verified via [etalab.gouv.fr/licence-ouverte-open-licence](https://www.etalab.gouv.fr/licence-ouverte-open-licence/). Best-documented candidate found. |
| [verkehr.autobahn.de/o/autobahn](https://verkehr.autobahn.de/o/autobahn/) (`bundesAPI/autobahn-api`) | DE (Autobahnen) | **bespoke JSON, NOT DATEX II** (see correction below) | direct, no key, no registration (live-tested `GET /A9/services/roadworks` → 200, 79 entries incl. GeoJSON geometry) | **none stated anywhere** — no LICENSE, no ToS in the [OpenAPI spec](https://autobahn.api.bund.dev/openapi.yaml) (`termsOfService`/`license` fields empty), only a contact address | **ungeklärt** | Official origin (Die Autobahn GmbH des Bundes), fed from their internal MIA system. Absence of any stated terms is not a grant — §0's database-right risk applies at Europe/country scale. **Operator decision needed** (see questions). |
| Autobahn GmbH roadworks **via Mobilithek** (DATEX II v2/v3) | DE | DATEX II XML | 3-tier registration (personal + organization + per-offer subscription) or open-data download when marked open; M2M via X.509 client cert — [BASt guide](https://www.bast.de/DE/Publikationen/Daten/VerhaltenundSicherheit/MDC/Datenbezug/Datenbezug_node.html) | **per dataset** — one live example (Bayern roadworks, GovData mirror) uses **GeoNutzV §2**, attribution *waived* under §3 (redistribution-friendly); other offers may differ | **auflagen** | Same underlying content as the row above, official DATEX II copy with documented per-dataset terms — the safer path if the JSON API's "ungeklärt" status is not acceptable. Needs an "Organisation" in Mobilithek, which an individual operator may not have — flagged as an access hurdle, not just a legal one. |
| [NDW open data](https://opendata.ndw.nu/) — `wegwerkzaamheden`/planning feed | NL | DATEX II v2.3 (v3 in transition, cutover 2027-02-09) | **file download, no login** (confirmed: registration only required for the service/SOAP push-pull variant) | Rijkswaterstaat general policy "open, tenzij" — quoted live: *"Iedereen mag de open data van Rijkswaterstaat vrij inzien... Hergebruik mag meestal zonder bronvermelding."* ([rijkswaterstaat.nl/zakelijk/open-data](https://www.rijkswaterstaat.nl/zakelijk/open-data)) — but this is the *general* RWS page, not NDW's own explicit grant text | **auflagen** (probably frei, exact NDW-specific wording not yet found) | Good second candidate once the exact license page for opendata.ndw.nu itself is read (not just the parent-agency policy). |
| [opentransportdata.swiss](https://opentransportdata.swiss/en/road-traffic/) (FEDRO/ASTRA Traffic Data Platform) | CH | DATEX II (SOAP Pull, e.g. `TrafficSituations`) | registration + API key for service-based access; [general ToU](https://opentransportdata.swiss/en/terms-of-use/) explicitly carves out that **ASTRA TDP data has its own, separate FEDRO Terms of Use** | not yet read (the FEDRO-specific ToU, not the platform's general one) | **ungeklärt** | Two layers of terms — don't rely on the platform's general ToU for this specific product. |
| [National Highways / data.gov.uk](https://www.data.gov.uk/dataset/1d9d6499-6ff5-4450-839a-68023c58452d/live-roadworks-api) | GB (strategic road network) | DATEX II (`Road and Lane Closures` v2.0) | developer-portal registration + subscription key for the live API; a mirrored dataset is listed on data.gov.uk | **Open Government Licence v3.0** per the data.gov.uk listing | **auflagen** | Direct developer-portal FAQ page 403'd on fetch (bot-blocked) — OGL v3.0 confirmed via the data.gov.uk mirror instead, not yet cross-checked against the portal's own terms page. |
| [mobilitaetsdaten.gv.at](https://www.mobilitaetsdaten.gv.at/) | AT | DATEX II (platform-wide) | registration; "License Options: Multiple license types... free to paid" per the platform | **not resolved to one dataset** | **ungeklärt** | Only the search/catalog page was reached; needs a specific dataset picked (parallel to the Mobilithek situation) before it can be rated. |
| Belgium (`data.mobility.brussels`, `data.gov.be`), further NAPCORE members | various | DATEX II (NAPCORE-networked) | varies | **not researched this round** | **ungeklärt** | Per the add-on prompt's own §3.2 ("weitere Länder sind dann Konfiguration, nicht neuer Code") — deferred until a generic DATEX II reader exists and a country is prioritized. |

### Traffic signs — official, non-OSM

| Source | Country | License | Ampel | Notes |
|---|---|---|---|---|
| ~~Digiroad~~ | FI | was CC BY-like ("open for everyone to use") | **not viable** | **Correction to the operator's research:** Digiroad is being decommissioned. Responsibility moved from Väylävirasto to Fintraffic 2026-01-01, and Fintraffic's own page states operations end **2026-09-30** (i.e. this week) — [fintraffic.fi/sv/digitrafficroadnetwork](https://www.fintraffic.fi/sv/digitrafficroadnetwork). Successor "Digitraffic Road Network" is not yet live. Do not build against a system being switched off. |
| [NVDB](https://bransch.trafikverket.se/tjanster/data-kartor-och-geodatatjanster/) (Trafikverket) | SE | **CC0** — Trafikverket's stated general policy for its open data | **frei** (pending final per-dataset confirmation) | **New recommendation replacing Digiroad.** Speed limits, road-authority and 10 other feature types (traffic signs among the documented NVDB object classes) available via the Open API; reading needs no login, an account (free) is needed only to *download*. Current and actively maintained, unlike Digiroad. |
| [Vejman.dk / Vejdirektoratet](https://www.vejdirektoratet.dk/viden-og-data/planlaegning-og-drift/TrafficeventsandRoadworks-datafeed) | DK | not yet found in primary text | **ungeklärt** | DATEX II v3.2 feed for roadworks confirmed to exist; a dedicated traffic-sign dataset and its license weren't reached this round. |
| Mapillary API (crowd-sourced sign detections) | — | Images: CC-BY-SA (confirmed) — but the **API Terms of Use** explicitly require that "each application... must be designed to provide products or services that materially supplement those provided via the Mapillary Services (**and not to merely redistribute Content** or create applications that substantially replicate the functionality of Mapillary Services)" — [mapillary.com/terms](https://www.mapillary.com/terms) | **auflagen, effectively verboten for this use case** | A bulk import that stores detections in our own database to redistribute over the federation reads as exactly the "merely redistribute Content" case the ToU excludes. Matches the add-on prompt's own instruction to keep this off by default; recommend treating it as settled rather than open (see the questions below) unless Mapillary grants a specific written exception. |
| KartaView | — | not researched this round (same "off by default, needs explicit go-ahead" treatment as Mapillary per the prompt) | **ungeklärt** | |
| GTSRB / BTSD / STSD / Mapillary Traffic Sign Dataset | — | various academic/research licenses | **not import material** | Per the add-on prompt §3.3: these are ML benchmark datasets, not a live data source — recorded here only so the option isn't silently lost, never imported. |

### Corrections to the operator's research brief

1. **"Autobahn GmbH API" is not DATEX II.** `verkehr.autobahn.de/o/autobahn/` is a bespoke, Autobahn-GmbH-specific JSON
   schema (confirmed live: `identifier`, `title`, `description` as free-text lines, `geometry` as GeoJSON, no DATEX II
   envelope). The *DATEX II* copy of the same underlying roadworks exists, but only via Mobilithek, with different
   (documented) terms and a registration hurdle. These are two different access paths to overlapping content, not one.
2. **Digiroad is being shut down this month** (see table above) — dropped as a candidate; NVDB (Sweden) proposed instead.
3. **Speed cameras and traffic signs from OSM are already done** via the Europe basemap import, not new work — see above.
4. **Mapillary's own Terms of Use, read directly, point toward "don't build this"** rather than "check ToS, then
   decide" — the "merely redistribute" clause is close to a direct match for what a bulk detection import would do.

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
