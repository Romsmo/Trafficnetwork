# Attribution — what a source's license makes us say

Every imported row carries `source` and `sourceLicense` (the server returns both on signs, segments, cameras and reports), so a client or the web UI can
show the right credit for exactly the data it displays, and a source can be removed again with one query. This page collects what each license
requires. It is the operator's evidence base, not legal advice.

**What has to appear in the web UI / any public presentation of the data** (the last column of the table is the one to hand to the UI):

| Source (`source` value) | License (`sourceLicense`) | What the license requires | Credit line to show |
|---|---|---|---|
| OpenStreetMap (`osm`) | ODbL 1.0 | Credit OpenStreetMap and its contributors, make clear the data is under the ODbL (link to the copyright page); **share-alike**: a database derived from OSM data may be distributed only under the ODbL. [openstreetmap.org/copyright](https://www.openstreetmap.org/copyright) | `© OpenStreetMap contributors` linking to https://www.openstreetmap.org/copyright |
| OSM wiki "Default speed limits" table (used to resolve `maxspeed:type=DE:urban` etc. into numbers; `pipeline/osm/implicit-speeds.generated.ts`) | CC BY-SA 2.0 | Attribution (the authors are listed in the page history) and share-alike for adaptations. [wiki.openstreetmap.org/wiki/Wiki_content_license](https://wiki.openstreetmap.org/wiki/Wiki_content_license) | covered by the OSM credit above; the generated file names its source page and date |
| Bison Futé / DIR, via transport.data.gouv.fr (`seed` reports of feed `fr-tipi-rrn`) | Licence Ouverte 2.0 (Etalab) | Free to copy, redistribute, modify and use commercially **if** the source (at least the licensor's name) **and the date of last update** are stated; must not suggest endorsement. [SPDX text](https://spdx.org/licenses/etalab-2.0.html) | `Source : Bison Futé / directions interdépartementales des routes (DIR), via transport.data.gouv.fr — Licence Ouverte 2.0 — mise à jour du <date>`; the date is the feed's own publication time (`publishedAt` in the roadworks report, `updated_at` of the row) |
| NVDB Norway, Statens vegvesen (`nvdb-no`) | NLOD (Norwegian License for Open Government Data) | Right to copy, use and distribute the information, provided the contributors are credited; the licensor gives no warranty for quality. Statens vegvesen prescribes the credit text. [nvdb.no terms](https://www.nvdb.no/rammer-regelverk/vilkar-og-ansvar/vilkar-for-bruk-av-data/), [NLOD 1.0](https://data.norge.no/nlod/en/1.0) | `Inneholder data under norsk lisens for offentlige data (NLOD) tilgjengeliggjort av Statens vegvesen.` |
| Die Autobahn GmbH des Bundes API (`seed` reports of feed `de-autobahn`) | `ungeklärt` — the publisher states no terms | Nothing can be derived. Ships **off**. If the operator switches it on: credit it anyway, as a courtesy, and expect to remove it if the publisher objects. | `Quelle: Die Autobahn GmbH des Bundes (verkehr.autobahn.de)` |
| NDW (`seed` reports of feed `nl-ndw`) | not confirmed — ships **off** | The parent agency's general "open, unless" policy is not NDW's own license text; ask NDW before enabling. | `Bron: NDW (Nationaal Dataportaal Wegverkeer)` (proposal, unconfirmed) |

The same lines are stored next to each feed as `attribution` in `config/roadworks-feeds.json`, and for NVDB in `nvdb-no-meta.json` in the run's state directory.

## Notes per license

* **ODbL / share-alike.** The static data imported from OSM (speed-limit segments, signs, cameras) is a *derivative database*. If this server's data is
  distributed (its API, the federation, published partitions), that distribution has to stay under the ODbL, which is why `sourceLicense = ODbL` is on every row.
  Data from other sources sits in the same tables; the tables are not one "derived database" in the ODbL sense as long as rows of each source can be told apart and
  removed — `source` is what makes that possible. Whether mixing them in one *published* dataset creates further obligations is a question for the legal review that
  `docs/todo.md` already lists as open for speed cameras.
* **Licence Ouverte 2.0.** The date of last update is required in the credit. The roadworks importer records the feed's publication time
  (`STATE_DIR/roadworks/fr-tipi-rrn.report.json`, field `publishedAt`); the row's own `updated_at` moves with every pass. Show one of the two next to the credit.
* **NLOD.** Also states that the data may contain errors and comes without guarantee; the credit line above is the licensor's own wording.
* **Removing a source** (each is one statement): `delete from static_signs where source = 'nvdb-no';`, `delete from hazard_reports where source_feed = 'fr-tipi-rrn';`,
  `delete from fixed_speed_cameras where source = 'osm';` (then also remove the local progress state of that region/source, or a re-run would think it is done, and **restart the server**: it caches its static-data packages by a version counter that only its own writes bump, so a manual delete alone would keep serving the old packages).

## What the web UI has to show — to be confirmed with the owner of `server/web`

1. A permanent credit for OpenStreetMap wherever OSM-derived data is displayed (signs, speed limits, cameras, and any OSM base map): `© OpenStreetMap contributors` with the link.
2. The credit of every other source **that is present in the data being displayed** (query `source` of the visible rows), from the table above: NVDB (Norway), Bison Futé (France, with the date), and — if their feeds are ever switched on — the Autobahn GmbH and NDW lines.
3. For roadworks the source feed of a report is `source_feed` in the database; the public API of hazard reports does not expose it yet (only `source: seed` and `sourceLicense`). A UI that must name the roadworks publisher needs that field added to the API — **open point for the server owner.**
