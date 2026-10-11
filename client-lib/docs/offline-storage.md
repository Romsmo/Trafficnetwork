# Offline area and storage (client library 1.2.0)

What a device keeps of the static data (road speed limits, signs, camera data), how much room that takes, and what the
library does when room runs out. Until 1.1.0 a client fetched **everything** the server lists; with Europe on one node
that is ≈ 4 GB on the device (measured, below). From 1.2.0 the device chooses.

The calls are in [`api.md`](api.md), "Offline area". This page is the behaviour behind them and the numbers.

## What is kept — three modes

| `mode` | Kept | Use |
|---|---|---|
| `auto` (default) | The **home area**, the **surroundings of the current position** with a buffer, and the **places driven through lately** | A navigation or driver app: follows the person, takes tens of megabytes |
| `regions` | Exactly the countries/regions chosen from `listOfflineRegions` | "I drive in DE and AT" |
| `all` | Everything the server's manifest lists (the behaviour before 1.2.0) | A kiosk, a dashboard, a test harness |

The server cuts its data into H3 tiles (resolution 4 by default, ≈ 1,770 km², ≈ 22 km across) and lists one package per
tile. The device works in those tiles.

### Automatic: how the area is cut

`getOfflineSettings().auto` — all of it can be changed with `setAutoRegionPolicy`:

| Setting | Default | Meaning |
|---|---|---|
| `homeRadiusTiles` | 3 | tiles around home (the tile itself = 0, its six neighbours = 1, 19 tiles = 2, 37 = 3) — **never let go of** |
| `currentRadiusTiles` | 2 | around where the device is now: the buffer that keeps lookups local while driving (19 tiles, ≈ ±50 km) |
| `recentPlaces` | 4 | how many of the most recently driven-through places are kept besides (at most 24 are remembered) |
| `recentRadiusTiles` | 1 | around each of them (7 tiles) |

Home is whatever the host app gives with `setAutoRegionPolicy({ homeLat, homeLng })`. Until it does, **the first position
the device reports becomes home** (so the place the app is first used is never evicted); a host that knows better sets it.
Position comes from `updatePosition` (and `getSpeedLimitAt` / `lookupSpeedLimit`, which note where the device is).

**Behaviour to know:** with `auto` and neither a position nor a home known, **nothing is selected** and a sync fetches no
static data. `sync()` says so (`needsLocation: true`, also in `getStoragePlan`); the host app should give a position, a home
or choose regions. A host that wants the old everything-behaviour sets `mode: "all"`.

A tile that falls out of the automatic area is **not deleted at once**: it stays as a cache of recent places and is let go of
only when room is needed (least recently used first). Home tiles are never evicted. In `regions` and `all` mode what is no
longer chosen is let go of by the next sync.

## How much room — the storage limit

`setStorageLimits({ maxBytes })` caps what the offline data may take on the device; `maxBytes: null` removes the cap. The
library **estimates before it downloads** (the device size of a package ≈ 0.7 × its JSON size, measured below) and decides:

1. Packages that would not be wanted any more are let go of (regions/all) or become the cache (auto).
2. Wanted packages are fetched in order of importance: the tile of the current position first, then the rest by priority.
3. If a package does not fit, **cached** packages are evicted, least recently used first — never home, never a tile the
   selection wants. If that is still not enough, the package is **not fetched** (nothing is thrown away for nothing) and
   counts as `deferred` with the reason `storageLimit`.

`getStoragePlan()` shows the outcome *before* a sync: what would be fetched (tiles, JSON bytes, estimated device bytes),
let go of, held back (`deferredForLimit`, `deferredForMetered`) and whether it fits. `getStorageUsage()` lists what is stored,
least recently used first, with what the store occupies and the limit. If the device itself runs out of space the sync stops
with `storageFull` and **resumes** where it stopped once there is room.

## Metered connections — "WLAN only"

The library cannot tell what kind of connection the phone is on; the host app says: `setConnectionMetered(true|false)`.
With `wifiOnly` on (default) and the connection metered, **only the tile of the current position** is fetched (a position
without its data is the one thing worth mobile data); everything else is held back (`deferredForMetered`) and fetched by the
first sync after `setConnectionMetered(false)`. `setStorageLimits({ wifiOnly: false })` turns the rule off.

## Interrupted downloads

A package is stored together with its hash in one transaction, so there is never half a package. An interrupted sync
(connection lost, app killed) leaves the finished packages in place; the next sync fetches the rest. The plan is recomputed
every time — nothing about "where it stopped" has to be remembered.

## Coverage and the online fallback

- `getCoverage(lat, lng)` (local) tells whether the offline data answers for a position: `stored`, `wanted` (in the area as it
  is cut now, not here yet — a sync fetches it) or `outside`.
- `getSpeedLimitAt` is local and answers `null` for "nothing here" — which can mean *no limit on record* **or** *outside
  what is stored*. `lookupSpeedLimit` tells them apart: `found` (`source: "offline"` or `"online"`), `notRecorded` (the data
  was looked at and holds no limit), or **`outsideOfflineArea`** (not stored and no network: nothing could be looked at). A
  place outside the offline area is asked of the server with one small request (`GET /v1/speed-limit`) — nothing is stored
  from it, and without a network the answer is the explicit `outsideOfflineArea`, never a silent "no limit".

A host app should show `outsideOfflineArea` as such ("not available offline here"), not as "no speed limit".

## What it costs — measured and derived

Honest labels: **measured** means a real run of the real code; **derived** means calculated from measured per-row costs.

| What | Value | Basis |
|---|---|---|
| Whole of Europe, packages as stored on the server | 6,027.7 MB JSON = 443 B per row, 13.63 M rows, 5,825 tiles | measured (Europe import 2026-09) |
| … as sent | **1,442 MB brotli** / 1,493 MB gzip ≈ 106 / 110 B per row | measured |
| … on the device after import (SQLite + R*Tree) | **≈ 4.0 GB** = 270–300 B per object | measured, [`bootstrap-measurements.md`](bootstrap-measurements.md) |
| Bavaria (real data) | 548,241 objects → 204 MB JSON, **149 MB on the device** | measured |
| Average tile | 1.03 MB JSON → ≈ 0.7 MB on the device | measured (6,027.7 MB / 5,825) |
| Largest tile | 38.7 MB JSON → ≈ 27 MB on the device; the median tile is 0.2 MB | measured |
| Germany | ≈ 3.5 M objects → ≈ 370 MB sent, **≈ 1.0 GB on the device** | **derived** (OSM taginfo × per-row cost) |
| Any one country | objects × ≈ 106 B sent / ≈ 300 B on the device | derived |
| Automatic area, default policy, an average region | 37 + 19 + 4 × 7 = up to 84 tiles × 0.7 MB ≈ **60 MB** | **derived** from the average tile |
| Automatic area in the densest regions | tiles of 10–30 MB each: **hundreds of MB** — set a `maxBytes` | derived, an upper bound, not measured |

**Per country, exactly:** the node's own `GET /v1/static-data/regions` gives `sizeBytes` / `brotliBytes` per country and per
region; the library puts them in `listOfflineRegions()` as `downloadBytes` (what is sent), `sizeBytes` and
`estimatedDeviceBytes` — the app shows "France: ≈ 410 MB" from the server's own numbers rather than from this table. The
figures on this page for single countries other than Bavaria are derived, not measured; the operator's note in
`server/docs/operating.md` ("Offline regions") says how to replace them with the node's real totals after the next package
build.

The ratio the library uses for planning is `0.7 × JSON bytes` (299 B per object on the device against 443 B per row as JSON,
rounded). It is an estimate: the real figure per package depends on how long the roads' geometry is. `getStorageUsage`
reports both the packages' JSON bytes and what the store actually occupies (`storeBytes`, the whole database file for SQLite),
so a host app can check the estimate against reality on its own data.

## Not in the library

- Choosing *which* regions to offer, and the wording ("France — 410 MB, download on Wi-Fi?"), is the host app's.
- Whether the connection is metered is the host app's to say.
- The library never deletes data on its own initiative beyond the rules above, and never fetches over a metered connection
  more than the current tile while `wifiOnly` is on.
