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

### Status of the add-on (end of Q5, 2026-09-26)

| Milestone | Status | Where to look |
|---|---|---|
| Q0 catalog with evidence and Ampel | done | this file |
| Q1 speed cameras from OSM | done by the Europe import (`highway=speed_camera`); rows are stored, the namespace stays closed. A test proves it: imported cameras are delivered on **no** read path while `SPEED_CAMERA_NAMESPACE_ENABLED` is off, and a second server on the same database with the flag on returns exactly what was imported | `tests/integration/camera-namespace.test.ts` |
| Q2 signs from OSM | done by the Europe import; the raw `traffic_sign` value is kept verbatim, country-prefixed | `pipeline/osm/normalize.ts` |
| Q3 roadworks | done: generic DATEX II reader (v2 and v3), Autobahn GmbH JSON reader, periodic pass, server-side seed reports. **France on** (Licence Ouverte 2.0); **Netherlands and Germany ship off** (`ungeklärt`) | [`roadworks.md`](roadworks.md) |
| Q4 one official sign source | done for **Norway (NVDB, NLOD)**, *not* Sweden as agreed earlier — the Swedish open API contains no signs, see the corrections below | [`config/sign-mappings/no.json`](../config/sign-mappings/no.json), `pipeline/nvdb/` |
| Q5 quality report, docs, CI | `npm run report:quality`, [`attribution.md`](attribution.md), CI runs unit + integration tests against real servers | `src/report/quality.ts` |

### Q1 + Q2 are already delivered — no new code needed

The Europe basemap import (`phase3/europe-basemap`) already processes the *same* Geofabrik PBF this add-on would
otherwise need a second pass for, and already extracts both entities the OSM tag filter includes them:

- **Fixed speed cameras** (`highway=speed_camera`, node only) — [Tag:highway=speed_camera](https://wiki.openstreetmap.org/wiki/Tag:highway%3Dspeed_camera)
  (page last edited 2026-04-20; de-facto status, not an officially standardized tag). `normalize.ts` emits a
  `fixed-speed-camera` row with `source=osm, sourceLicense=ODbL`. **Whether they are served is the server's
  decision** (its emergency brake `SPEED_CAMERA_NAMESPACE_ENABLED` and the per-country camera policy, `server/docs/camera-country-policy.md`;
  default since 2026-10-04: delivered in full, single countries can be restricted) — the importer only stores the rows.
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
| [NDW open data](https://opendata.ndw.nu/) — planning feed `planningsfeed_wegwerkzaamheden_en_evenementen.xml.gz` | NL | **DATEX II v3** (verified on the live file 2026-09-26: the earlier note about v2.3 with a v3 cutover in 2027 does not match what the file contains; the reader handles v2 and v3) | **file download, no login**, ~18 MB gzip, carries a `Last-Modified` header, served as plain `application/xml` without `Content-Encoding` | Rijkswaterstaat's general policy "open, tenzij" — quoted live: *"Iedereen mag de open data van Rijkswaterstaat vrij inzien... Hergebruik mag meestal zonder bronvermelding."* ([rijkswaterstaat.nl/zakelijk/open-data](https://www.rijkswaterstaat.nl/zakelijk/open-data)) — the *general* RWS page; **no license text of NDW itself was found** on opendata.ndw.nu or docs.ndw.nu | **ungeklärt** (probably frei) | **Built, ships `enabled: false`** (`nl-ndw`); ask mail@servicedeskndw.nu for the license, then switch it on. On 2026-09-26: 67,330 records, 13,893 roadworks, 4,586 active. |
| [opentransportdata.swiss](https://opentransportdata.swiss/en/road-traffic/) (FEDRO/ASTRA Traffic Data Platform) | CH | DATEX II (SOAP Pull, e.g. `TrafficSituations`) | registration + API key for service-based access; [general ToU](https://opentransportdata.swiss/en/terms-of-use/) explicitly carves out that **ASTRA TDP data has its own, separate FEDRO Terms of Use** | not yet read (the FEDRO-specific ToU, not the platform's general one) | **ungeklärt** | Two layers of terms — don't rely on the platform's general ToU for this specific product. |
| [National Highways / data.gov.uk](https://www.data.gov.uk/dataset/1d9d6499-6ff5-4450-839a-68023c58452d/live-roadworks-api) | GB (strategic road network) | DATEX II (`Road and Lane Closures` v2.0) | developer-portal registration + subscription key for the live API; a mirrored dataset is listed on data.gov.uk | **Open Government Licence v3.0** per the data.gov.uk listing | **auflagen** | Direct developer-portal FAQ page 403'd on fetch (bot-blocked) — OGL v3.0 confirmed via the data.gov.uk mirror instead, not yet cross-checked against the portal's own terms page. |
| [mobilitaetsdaten.gv.at](https://www.mobilitaetsdaten.gv.at/) | AT | DATEX II (platform-wide) | registration; "License Options: Multiple license types... free to paid" per the platform | **not resolved to one dataset** | **ungeklärt** | Only the search/catalog page was reached; needs a specific dataset picked (parallel to the Mobilithek situation) before it can be rated. |
| Belgium (`data.mobility.brussels`, `data.gov.be`), further NAPCORE members | various | DATEX II (NAPCORE-networked) | varies | **not researched this round** | **ungeklärt** | Per the add-on prompt's own §3.2 ("weitere Länder sind dann Konfiguration, nicht neuer Code") — deferred until a generic DATEX II reader exists and a country is prioritized. |

**Built (Q3):** the generic DATEX II reader (v2 and v3) with the feeds `fr-tipi-rrn` (**on**), `nl-ndw` (off) and the Autobahn GmbH JSON reader `de-autobahn` (off; `sourceLicense = ungeklärt` on every row) — operation, cost of permanent running, safety rules and how to add a country are in [`roadworks.md`](roadworks.md). The Mobilithek, Swiss, British and Austrian rows above need an account or an API key from the operator and are therefore **not built**; each becomes a configuration entry once its access is in place and its license is read (the reader already understands DATEX II v2/v3, a `service`-based transport with SOAP push/pull or a client certificate is the part that is not there).

### Traffic signs — official, non-OSM

| Source | Country | License | Ampel | Notes |
|---|---|---|---|---|
| ~~Digiroad~~ | FI | was CC BY-like ("open for everyone to use") | **not viable** | **Correction to the operator's research:** Digiroad is being decommissioned. Responsibility moved from Väylävirasto to Fintraffic 2026-01-01, and Fintraffic's own page states operations end **2026-09-30** (i.e. this week) — [fintraffic.fi/sv/digitrafficroadnetwork](https://www.fintraffic.fi/sv/digitrafficroadnetwork). Successor "Digitraffic Road Network" is not yet live. Do not build against a system being switched off. |
| [**NVDB Norway**](https://nvdbapiles.atlas.vegvesen.no/) (Statens vegvesen, "NVDB API Les V4") — object type 96 *Skiltplate* (sign plate), 1,153,655 objects | NO | **NLOD** — Norwegian License for Open Government Data: *"the right to copy, use and distribute information"*, credit required, no warranty ([NLOD 1.0](https://data.norge.no/nlod/en/1.0); NVDB's [terms](https://www.nvdb.no/rammer-regelverk/vilkar-og-ansvar/vilkar-for-bruk-av-data/) name NLOD without a version and prescribe the credit text *"Inneholder data under norsk lisens for offentlige data (NLOD) tilgjengeliggjort av Statens vegvesen."*) | **auflagen** (attribution) | **Built (Q4), off unless `NVDB_NO_ENABLED=true`.** No account or key; the API refuses a request without an `X-Client` header (HTTP 400) and publishes a rate-limit budget in `x-ratelimit-remaining` (199 left after the first request). Positions come as WGS 84 **latitude, longitude** (`srid=4326`), sign numbers per Håndbok N300 as a text enum (642 values). Details, quirks and the mapping table: see "NVDB Norway — how it is imported" below. |
| [NVDB Sweden](https://bransch.trafikverket.se/tjanster/data-kartor-och-geodatatjanster/) (Trafikverket) | SE | **CC0** — Trafikverket's stated general policy for its open data ("Trafikverket använder generellt Creative Commons CC0 för våra öppna data") | **frei** for the license — but **not usable by this tool** | **Correction to the earlier note (2026-09-26, later that day):** the 12 NVDB datasets in the *Open API* are speed limit (Hastighetsgräns), road number, road keeper, road width, functional road class, forbidden direction and six others — **no traffic signs**. The other 100+ NVDB data products are downloaded from *Lastkajen*, which needs a registered account (free, but an account the operator has to create — this tool must not). Whether a traffic-sign product exists there could not be established from the public pages (they name speed limits, road keeper, guard rails, rest areas and wildlife fences as examples). Not built: it would need the operator's account and a sample file first. Sources: [nvdb.se — hämta aktuella data](https://www.nvdb.se/sv/kund/hamta-aktuella-data/), [Trafikverket news 2025](https://bransch.trafikverket.se/tjanster/data-kartor-och-geodatatjanster/nyheter-om-trafikverkets-data/2025/nvdb-vagdata-tillgangliga-i-trafikverkets-datautbytesportal-for-anvandning-i-oppet-api/). |
| [Vejman.dk / Vejdirektoratet](https://www.vejdirektoratet.dk/viden-og-data/planlaegning-og-drift/TrafficeventsandRoadworks-datafeed) | DK | not yet found in primary text | **ungeklärt** | DATEX II v3.2 feed for roadworks confirmed to exist; a dedicated traffic-sign dataset and its license weren't reached this round. |
| Mapillary API (crowd-sourced sign detections) | — | Images: CC-BY-SA (confirmed) — but the **API Terms of Use** explicitly require that "each application... must be designed to provide products or services that materially supplement those provided via the Mapillary Services (**and not to merely redistribute Content** or create applications that substantially replicate the functionality of Mapillary Services)" — [mapillary.com/terms](https://www.mapillary.com/terms) | **auflagen, effectively verboten for this use case** | A bulk import that stores detections in our own database to redistribute over the federation reads as exactly the "merely redistribute Content" case the ToU excludes. Matches the add-on prompt's own instruction to keep this off by default; recommend treating it as settled rather than open (see the questions below) unless Mapillary grants a specific written exception. |
| KartaView | — | not researched this round (same "off by default, needs explicit go-ahead" treatment as Mapillary per the prompt) | **ungeklärt** | |
| GTSRB / BTSD / STSD / Mapillary Traffic Sign Dataset | — | various academic/research licenses | **not import material** | Per the add-on prompt §3.3: these are ML benchmark datasets, not a live data source — recorded here only so the option isn't silently lost, never imported. |

### NVDB Norway — how it is imported (Q4)

Run (its own region, next to the OSM data already on the server):

```powershell
$env:OSM_ENABLED = "false"; $env:NVDB_NO_ENABLED = "true"
npm run ingest -- --region norway --allow-non-empty
```

`--allow-non-empty` is needed because the server already holds the Europe data (the importer refuses a fresh start on a populated server, since the server has no
dedup). It also means: **nothing deduplicates NVDB plates against OSM's Norwegian signs** — where both sources know a sign, it exists twice, once per `source`.
Set `NVDB_NO_CONTACT` to a contact address (sent as `X-Kontaktperson`, which Statens vegvesen recommends) and, if wanted, `NVDB_NO_MAX_REQUESTS` to cap one run (it resumes).

* **Volume** (2026-09-26): 1,153,655 sign plates in NVDB; the imported series 1–4 are **455,756** of them (39.5 %). About 1,300 requests (≈570 pages of up to 800 plates, plus per municipality one closing empty page and one count request), spaced 200 ms apart — an estimate of 20–40 minutes including the inserts; it has not been run on all of Norway.
* **Sections**: one per municipality (`kommune-0301` …), each resumable; the run report per municipality (`skips/<section>.json`) says how many plates the municipality has, how many were imported and what was left out.
* **What is stored**: one row per plate — `signType = NO:<Skiltnummer>` verbatim (`NO:362.50` speed limit 50, `NO:202` give way, `NO:146.1` moose), `source = nvdb-no`, `sourceLicense = NLOD`, position, key `nvdb-no/96/<NVDB id>`.
* **Mapping table**: [`config/sign-mappings/no.json`](../config/sign-mappings/no.json) — a file, not code. Series 1 (warning), 2 (priority), 3 (prohibitory and regulatory, incl. speed limits `362.xx`) and 4 (mandatory) are imported; 5 (information), 6 (service), 7 (wayfinding — the largest group), 8 (supplementary plates) and 9 (markers) are left out, each with its reason. `codes` overrides single codes. **A code that matches no known series is passed through unchanged, never discarded.** The series names are descriptive, derived from the real enum entries (examples are verbatim), not quoted from Håndbok N300.
* **The real API's quirks, all handled and tested on real responses** (`tests/fixtures/nvdb-no/`, fetched 2026-09-26):
  * positions are **latitude first** (`POINT(59.98 10.93)`, also for `srid=WGS_84`), sometimes `POINT Z (lat lon -999999)` with an unknown height — the reader checks every position against Norway's extent, where latitude and longitude ranges do not overlap, so a changed axis order is refused; a whole page of implausible positions **stops the run**;
  * the enum's `kortnavn` is **truncated** for two entries (`711.V13` for `711.V135`), so the code is read from the entry's text, not from `kortnavn`;
  * **the end of the data is an empty page that repeats the last cursor, forever** — `metadata.neste` is never absent; the loop ends on an empty page;
  * a page can hold fewer objects than asked and still have a successor (the size limit is on the response), so the page size says nothing about the end;
  * `X-Client` is mandatory (HTTP 400 without it) and the rate limit shows in `x-ratelimit-remaining`; the client pauses when it runs low and honours `Retry-After`;
  * the series filter is done **on the server** (`egenskap(5530)in[…132 enum ids…]`) to spare the API 60 % of the transfer; the reader still decides every series itself, so a server that ignored the filter changes nothing.
* **Not covered**: supplementary plates (series 8) — a plate that only qualifies another is left out, so "50 km/h, trucks only" is stored as the 50 km/h plate; the flip-plate and display-period properties (`Klappskilt`, `Visningsperiode`); plates of other object types (variable signs, type 97).
* **Not refreshed by a later run**: like every static import, a re-run of a finished region does nothing, and the bulk API has no update; a newer NVDB state means a new import into a fresh database (or removing `source = 'nvdb-no'` first, see `attribution.md`).

### Corrections to the operator's research brief

1. **"Autobahn GmbH API" is not DATEX II.** `verkehr.autobahn.de/o/autobahn/` is a bespoke, Autobahn-GmbH-specific JSON
   schema (confirmed live: `identifier`, `title`, `description` as free-text lines, `geometry` as GeoJSON, no DATEX II
   envelope). The *DATEX II* copy of the same underlying roadworks exists, but only via Mobilithek, with different
   (documented) terms and a registration hurdle. These are two different access paths to overlapping content, not one.
2. **Digiroad is being shut down this month** (see table above) — dropped as a candidate; NVDB (Sweden) was proposed instead, which did not work out (item 5) — NVDB Norway was built.
3. **Speed cameras and traffic signs from OSM are already done** via the Europe basemap import, not new work — see above.
4. **Mapillary's own Terms of Use, read directly, point toward "don't build this"** rather than "check ToS, then
   decide" — the "merely redistribute" clause is close to a direct match for what a bulk detection import would do.
5. **NVDB Sweden has no signs in its open API** (checked 2026-09-26): the 12 datasets of the Open API are speed limit, road number, road keeper, road width, functional road class, forbidden direction and six others. The earlier note that signs were among them was wrong. Norway's NVDB, which has an open, keyless API with 1.15 million sign plates, was built instead (Q4); Sweden stays open until the operator can supply a Lastkajen account and a sample file.
6. **Roadworks facts corrected against the live feeds**: the French national feed is an *hourly aggregate* (`resource 79174`, DATEX II 2.0 wrapped in a SOAP envelope, 3.4 MB; `79173` is a directory of per-event files); the Dutch NDW planning feed is already **DATEX II v3**; the Autobahn API has **108 roads** (109 requests per pass) and its times exist only as German free text; every one of the 120 `validPeriod` elements of the French feed carries only a *name* ("Uniquement de jour" / "de nuit"), no times.

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
