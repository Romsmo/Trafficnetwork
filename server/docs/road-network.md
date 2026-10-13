# The road network: stretches of road, items on roads, entries marked as wrong (server 1.1.0)

Three things belong together because they all need to know *where the road is*:

1. **A limit for a stretch of road.** A visitor picks **two points on the map** (ideally on the road). The node finds the road
   that runs between them and writes the limit **along the road's own shape**, so a road coloured by limit looks like every other.
   This replaces the earlier "which way does the road run?" question (the 8 direction buckets of D13).
2. **Items sit on roads.** Speed-limit lines, signs and cameras are tied to the road network: a sign or camera is moved onto its
   road (never "schief"), and what lies off every road of a *known* area is not served.
3. **Entries that are wrong can be taken out.** A visitor marks an entry on the map as wrong; enough *other* devices confirming
   it removes it - and a re-import does not bring it back.

Endpoint shapes are in `api.md`, tables in `schema.md`, the operator runbook in `operating.md`, the wire format of a signed vote
in `federation-protocol.md`.

## Where the roads come from

| Source | What it gives | When it is used |
|---|---|---|
| **Import** (`ingestion --roads`, `POST /v1/bulk-import/roads`) | every drivable OSM way of an extract, plus the areas the extract holds *completely* (`POST /v1/bulk-import/road-coverage`) | once per region, again after a new extract |
| **Lookup** (`ROAD_LOOKUP_URL`, an Overpass API) | the ways in the area around two picked points, or around items still waiting to be tied to a road | on demand, one request at a time, a few areas per background pass |
| **The imported speed-limit lines** | roads, too (they are ways with a limit) | as a fallback where no way is stored |

A node with no import and the lookup turned off (`ROAD_LOOKUP_URL=none`) simply answers `NO_ROAD_DATA` for areas it has no roads
for; nothing else breaks. The lookup is an outward call **by the node**: it sends the *area* of the picked points (never who
picked them) to the service, which the privacy notice says (`/privacy`, section 8). Operators who do not want that set
`ROAD_LOOKUP_URL=none` or run their own Overpass instance.

**Coverage.** An area (H3 resolution 8, edge ≈ 460 m) is *covered* when the node holds its whole road network - after an
import that says so, or after a lookup whose box contained the whole area. Only a covered area can say "no road here"; in an
uncovered area nothing is hidden for being off the road (see below).

## A limit for a stretch: two points

```
POST /v1/roads/resolve            { from: {lat,lng}, to: {lat,lng} }   -> the stretch, for a preview
POST /v1/speed-limit-intervals    { from, to, value, unit, reason?, deviceAssertion? }  -> the proposal
```

**What the node does with two points** (`modules/roads/resolve.ts`, `pathfinder.ts`):

1. Quantises both to 1e-5° (≈ 1.1 m) and orders them: *the same two points picked in the other order name the same stretch*.
2. Makes sure the roads of the area are there (lookup of the uncovered cells, one request for all of them).
3. Takes the ways within `ROAD_PICK_TOLERANCE_M` (35 m) of each point - the nearest few - and finds the shortest path along the
   road graph between them. A way with the same name as the nearest road is preferred, so a parallel service road does not
   win; a path more than 3× the straight distance is no stretch.
4. The stretch is the path's own shape, from the point on the road nearest to the first pick to the one nearest to the second.
   Its key is the geometry key of those vertices (7 decimals) - what votes and corrections for it are stored under.

**Errors** (HTTP 422 with `error.code`): `NO_ROAD_DATA` (no roads for that area and no lookup), `NO_ROAD_FOUND` (no road within
the tolerance of a point), `NO_ROAD_BETWEEN_POINTS` (no connected road), `INTERVAL_TOO_LONG` (more than `ROAD_INTERVAL_MAX_M`,
3000 m), `INTERVAL_TOO_SHORT` (less than 10 m).

**The proposal** is a vote like any other (docs D1-D4 of `speed-limit-corrections.md`): distinct devices naming *the same
stretch* make the same proposal; at `COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED` (3) it is applied. Applied means:

* a row with `source = 'community'` along the resolved shape is written to `speed_limit_segments`;
* imported lines *under* the stretch (within 5 m of it, with at least 25 m overlap) are **cut open**: the part under the
  stretch is dropped, the rest stays as pieces with the imported value. `speed_limit_splits` remembers the original so that
  *removing* the community value (denials, operator reset, feature off) **joins the pieces again** and the road is whole as
  before. Announced as `StaticDataRemoved` for the whole line and `StaticDataUpdated` for each piece and the stretch;
* a proposal for the value that at least 90 % of the stretch already carries is refused (`CORRECTION_NO_CHANGE`).

Two visitors who pick points more than about a metre apart name different stretches; that is intended (a stretch is exactly
what was picked). Others **confirm** a proposal they can see: `POST /v1/roads/resolve` lists the open proposals for exactly
that stretch (`proposals`) and `GET /v1/speed-limit-corrections?tiles=…` lists them by area, with the stretch's geometry.

**Federation.** A signed vote names the stretch as the reference `ivl:<lat>,<lng>:<lat>,<lng>` (integer 1e-5°, smaller pair
first) - something a device computes without any road data. Every node resolves it against its own roads, so nodes with
different road data may derive slightly different shapes (and therefore different keys) for the same picked points; a vote for a
reference a node cannot resolve yet is **kept under the reference** and moved onto the stretch by the background step once the
roads of that area are there (`modules/roads/pending.ts`). Votes by the old `gap:<cell>:<axis>` reference are still understood
(D13).

## Items sit on roads: "attached"

A background step (`modules/roads/worker.ts`, every `ROAD_ATTACH_INTERVAL_SECONDS`, first pass 15 s after start;
`npm run roads -- attach` does one pass at once) looks at signs and cameras:

| Status | Meaning | Served |
|---|---|---|
| `pending` | not looked at yet (every imported row starts here) | yes |
| `attached` | a road lies within `ROAD_SNAP_TOLERANCE_M` (25 m): the item was **moved onto it** (nearest point), its road and offset remembered; a camera's country set is recomputed for the new place | yes |
| `off_road` | the area is *covered* and no road lies near | **no** (`hidden_reason = off_road`) |
| `unknown` | no road near, but the area is not covered: nothing can be said | yes; looked at again when coverage arrives |

"Not served" means: not in `GET /v1/…` reads, not in snapshots and static packages, announced to clients as removed, and
included again when the item becomes attached. The row stays in the table. Nothing is guessed: **where the node does not know
the roads, it hides nothing.**

The same applies to community stretches from before intervals (the synthetic 120 m line through a tapped place, D13): in a
covered area a line that does not run along a road (fewer than 60 % of sampled points within 12 m of one) is hidden as
`off_road` - the "line in the field".

Bulk import keeps its rule (no events per row): new rows are `pending`, so the step brings them through, bumps the
static-data version and marks the tiles it touched; clients catch up through the packages.

## Entries marked as wrong

```
GET  /v1/data-defects/near?lat&lng&radiusM   -> items near a point (speed-limit lines and signs) with reports/threshold
POST /v1/data-defects                         { targetType, targetId, reason? } -> { recorded, reports, threshold, removed }
```

* Targets: `speedLimitSegment` and `staticSign`. (Cameras have their own, older "this camera is gone" vote.)
* One mark per reporter and entry. The reporter is the bound device key where the client has one, else the calling client -
  the same identity rules as a vote.
* At `DEFECT_REMOVAL_THRESHOLD` (3) distinct reporters the entry is **hidden**: `hidden_reason = 'defect'`, announced as
  `StaticDataRemoved`, packages rebuilt. A per-caller budget (`COMMUNITY_CORRECTIONS_RATE_LIMIT_*`) stops one client emptying a
  map.
* **Stays out.** `data_defect_removals` remembers what identifies the entry (a line: its geometry key; a sign: type + place).
  A re-import that brings the same line or sign again inserts it hidden.
* **Reversible.** `npm run roads -- defects` lists what was taken out, `npm run roads -- restore <type> <match-key>` shows it
  again (events, tiles, version). `DEFECT_REPORTS_ENABLED=false` removes the endpoints (entries already out stay out).
* Not federated: like node-local reports, marks are the node's own judgement.

## Configuration

| Variable | Default | |
|---|---|---|
| `ROAD_LOOKUP_URL` | public Overpass instance | `none` = never ask anybody |
| `ROAD_LOOKUP_TIMEOUT_MS` | 25000 | |
| `ROAD_PICK_TOLERANCE_M` | 35 | how far from a road a picked point still counts |
| `ROAD_SNAP_TOLERANCE_M` | 25 | how far a sign/camera is moved onto a road |
| `ROAD_INTERVAL_MAX_M` | 3000 | longest stretch of one proposal |
| `ROAD_ATTACH_WORKER_ENABLED` | true | the background step |
| `ROAD_ATTACH_INTERVAL_SECONDS` | 300 | |
| `ROAD_ATTACH_TILES_PER_RUN` | 5 | uncovered areas looked up per pass (be polite to the service) |
| `DEFECT_REPORTS_ENABLED` | true | |
| `DEFECT_REMOVAL_THRESHOLD` | 3 | |

`GET /v1/config` tells clients: `roadNetwork { intervalMaxMeters, pickToleranceMeters, lookup }` and, where enabled,
`defectReports { enabled, removalThreshold }`.

## Limits and honest caveats

* The road a stretch lies on is **as good as the road data**: where OSM has a gap, there is `NO_ROAD_FOUND` and no stretch.
* Two nodes with different road data can resolve the same picked points to different shapes; their votes still converge per
  node, and a vote that cannot be resolved yet is kept, not lost. They do not converge on *one* key across nodes with different
  geometry - the price of letting a device name a stretch with two points and no road data.
* Hazard reports are **not** snapped (they are device-signed at the reported position).
* Europe-sized imports: `ingestion --roads` streams ≈ 99 M ways; plan the database size (one `road_ways` row per drivable way)
  and run it per region; the coverage step is conservative on purpose (`ingestion/docs/roads.md`).

## Tests

| Rule | Where |
|---|---|
| Geometry (projection, quantisation, interval reference), path finding (picks beside the road, name preference, detour limit, too short/long, no connection), Overpass answer parsing | `tests/unit/road-network.test.ts` |
| Resolve (shape follows the way, other order = same stretch, covered/proposals, refusals), threshold writes the limit along the road and cuts the imported way, denial joins it again, support brings it back, tie/overtake, no change, device counted once, operator reset, federated `ivl:` votes (resolved / kept until the road arrives / legacy `gap:`) | `tests/integration/road-network.test.ts` |
| Attach: sign moved onto its road, off-road item of a covered area hidden, uncovered area keeps it and re-looks, camera moved, legacy line hidden, no events for bulk work | same |
| Defect reports: list, threshold, event, stays out after a re-import, restore, signs, refusals, switch off | same |
| Web: two points picked on the map, grey stretch drawn, proposal sent; refusal text; marking an entry | `e2e/duration-and-limits.spec.ts` |
| Client library: reference computed on the device, queued offline and sent signed, resolve and mark calls | `client-lib/core/src/api/tests.rs`, `client-lib/conformance/scenarios.json` |
| Ingestion: way rows, coverage rule, batches, dry run | `ingestion/tests/unit/roads.test.ts` |
