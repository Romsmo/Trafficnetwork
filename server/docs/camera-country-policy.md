# Country-based camera policy (add-on A, server part)

Scope: `Zusatz-Prompts — Blitzer-Funktion aktivierbar machen (länderabhängig)`, part A. The camera categories
(`fixedSpeedCamera`, `mobileSpeedCamera`, `trailerCamera`, `redLightCamera`, `distanceControl`) are **released**: they are
reported, delivered and filtered like any other category. **By default every country is `full`.** What the policy adds is the
ability for an operator to take single countries back — to coarse zones (`zones`) or to nothing (`off`) — without changing
code, and an emergency brake that switches everything off.

> **Whether a country should be restricted is a legal decision of the operator, not a technical one.** The levels below are a
> mechanism. The legal position differs by country and — which is not the driver's position — by the role of the *operator* of
> a service. Known special cases the operator should look at first: **Switzerland** (a broad ban, hints included) and
> **France** (only general danger zones, no concrete spots); in **Germany** use while driving is forbidden, also for passengers,
> while possession and use outside driving are not; in Austria, Italy, Belgium and the Netherlands POI warnings are
> permitted and active radar detectors are not. Nothing in this document, the code or its defaults is legal advice, and the
> default (`full` everywhere) is the operator's decision, not a statement that it is lawful everywhere.

Status: implemented on `feature/camera-country-policy`. This file is both the design record and the wire contract that
the web UI (part B) and the client library (part C) build against. Where a number or a name below is a *default*, the
variable that changes it is named.

## 1. What the policy is

```
level ∈ { "off", "zones", "full" }        off < zones < full   ("stricter" = smaller)
```

| Level | What a client receives for a camera whose country has this level |
|---|---|
| `off` | nothing. Not the item, not a zone, not an event, not an id, not a hint that something exists |
| `zones` | a **zone** — an H3 cell of a fixed, coarse resolution with the camera types present in it. Never a coordinate finer than the cell, never an id, timestamp or count of a single camera |
| `full` | the individual camera, exactly as for any other category — **the default for every country** |

**Effective level of one country** = the strictest of

1. the **signed network policy**: `cameraPolicyByCountry[CC]`; **a country it does not list is `full`**,
2. the **node's local cap** (`CAMERA_POLICY_LOCAL_CAPS`, absent = no cap),
3. the **emergency brake** — `SPEED_CAMERA_NAMESPACE_ENABLED=false` on the node *or* `blitzerEnabled: false` in the signed
   config turns **every** country `off`, whatever else is configured.

A node can therefore be stricter than the network, never more generous. The brake is released by default
(`SPEED_CAMERA_NAMESPACE_ENABLED=true`); it exists so that an operator can switch every camera off at once, for example while a
legal question is open, without editing or re-signing anything.

**Effective level of one camera** = the strictest level over the camera's **country set** (section 3). A camera whose country
is **unknown** (no boundary data, outside every boundary) gets the **strictest level any country has** (`unknownLevel`): that is
`full` while nothing is restricted — so a node needs no boundary data at all in the default state — and as soon as some country is
restricted it is that restriction, because a camera that could not be placed might be in the restricted country.

## 2. Network configuration

`NetworkConfigPayload` (the root-signed config, `NETWORK_CONFIG_PATH`) gets one optional field:

```jsonc
{
  "version": 7,
  "blitzerEnabled": true,                       // unchanged: the network-wide emergency brake (false = everything off)
  "cameraPolicyByCountry": { "CH": "off", "FR": "zones" },   // NEW — the EXCEPTIONS; ISO 3166-1 alpha-2, upper case
  ...
}
```

* Absent field, empty object or a country that is not listed: `full`. Listing a country as `full` is allowed and changes nothing.
* Keys must match `^[A-Z]{2}$`, values must be one of the three levels, at most 300 entries — anything else makes the
  file invalid. At start-up an invalid file stops the server (as for every signed-config error). While running, an
  invalid file **fails closed**: the camera policy becomes all-`off` until a valid file is read; everything else on the
  node keeps working. (A broken file may be exactly the file that held the restriction, so the safe reading is "nothing".)
* Signed like the rest (`npm run network:sign-config -- … --camera-policy "CH=off,FR=zones"`; `--blitzer-enabled` now
  defaults to `true`). Signing again without `--camera-policy` lifts every exception; the CLI prints what it signed.
* **Takes effect without a restart** (section 7). `version` must grow: a reload whose `version` is lower than the one
  in use is refused (rollback protection for the running process); the same version with different content is refused
  too — bump the version.
* A node with no signed config has no exceptions: every country is `full` (subject to its own brake and caps).

## 3. Which country a camera is in

**Decision: store, once, a country *set* per camera — computed by the server from the position against a boundary table
at write time, plus an explicit border strip. No importer-supplied code, no guessing per query.**

* New nullable column `countries text[]` on `fixed_speed_cameras` (persistent devices) and `hazard_reports` (filled for
  the camera types only), and `camera_countries text[]` on `event_log` (filled for camera events only, so delta and
  WebSocket decide without re-deriving).
* The set is computed by the SQL function `camera_countries(geometry, margin_m)`: all countries whose boundary is **within
  `CAMERA_POLICY_BORDER_MARGIN_M` (default 1000 m)** of the point. One element almost always; **two or more inside the
  border strip**, and then the **strictest level wins**. The error is made deliberately in one direction: a camera next
  to a border is withheld if either side restricts it.
* A point that is within the margin of **no** boundary (sea, outside the dataset) has the empty set; no boundary data loaded →
  every camera has the empty set. An empty or unresolved set means "country unknown" and gets `unknownLevel` (section 1): full
  while nothing is restricted, the strictest restriction otherwise. Missing data never makes a restriction leak.
* Why not the other options: an importer cannot know better than the border (OSM nodes carry no country, and trusting
  a supplied code is a way to mislabel a camera into a permissive country); deriving at every query repeats work and
  makes the answer depend on the query path. One stored value is read the same way by every endpoint.
* **The boundary data is not shipped.** It is geodata with its own licence, and its accuracy is the operator's choice:
  `npm run cameras -- load-boundaries <file.geojson>` loads any GeoJSON country dataset (Natural Earth admin-0 at 1:10m
  is public domain and accurate to a few hundred metres; the 1:50m set needs a margin of several km). The loader
  subdivides the polygons (`ST_Subdivide`) so a lookup stays a sub-millisecond index probe, and then re-resolves every
  stored camera (`resolve-countries`). **Boundary data is only needed once a country is restricted.**
* Rows that were written before boundaries existed, or while none were loaded, have `countries IS NULL` = unresolved, until
  `resolve-countries` runs. `npm run cameras -- status` counts them.

## 4. Where the rule is applied: one place

`src/modules/cameras/policy/` owns the rule. The queries return **candidates** (`CameraRecord`: the public item plus the camera's
country set and position, which are never part of the item, so a forgotten `.map()` cannot put them on the wire) and everything that
delivers camera data goes through one function family - `projection.ts` (`individualItems`, `zonesForCells`: pure), `delivery.ts`
(`readCamerasNear`, `readCamerasInTiles`, `readCamerasForSnapshot`, `zoneStates`, `answerForWrite`: fetch candidates, then project)
and `events.ts` (`classifyEvent`, `projectDeltaEvents`, `mayLeaveNode`) - and none of the endpoints contains a copy of it. The
policy object (`policy.ts`) is immutable: a request takes `app.cameraPolicy.current()` once and uses that one object throughout.

| Path | How |
|---|---|
| `GET /v1/speed-cameras/nearby`, `…/by-tile` | queries return candidate *records* (item + countries + position); the projection decides |
| `GET /v1/snapshot` (`fixedSpeedCameras`, `enforcementDevices`, camera `hazardReports`, new `cameraZones`) | same projection |
| `GET /v1/delta` | camera events pass through `projectDeltaEvents`; the cursor advances over withheld events |
| `GET /v1/ws` push | the same `classifyEvent`, per event, after commit |
| static packages (`fixedSpeedCameras`, `enforcementDevices`, new `cameraZones`) | the tile builder projects; tile population and dirty-marking follow the same classification |
| write responses (`POST /v1/hazard-reports` for camera types, `POST …/removal-reports`, `POST …/confirmations` on a camera report) | answered with the projection of the result, see 5.4 |
| federation: `GET /v1/federation/events` pull and gossip push | a camera event is forwarded to a peer only if its effective level is `full` |

`GET /v1/hazard-reports/nearby|by-tile` never contained camera types and still do not.

Camera events are recognised **by content** (entity type, or a camera `type` in the payload), not by the column the country set is
stored in: a camera event whose set was never filled in counts as "country unknown" and gets `unknownLevel`, so a forgotten column
cannot let a restricted country through.

The federation point is a **pre-existing back door** this add-on closes for the restricted levels: `GET /v1/federation/events` is
unauthenticated and used to return every device-signed report — camera reports with their exact coordinates included — whatever the
camera flag said. Camera reports now leave a node only at level `full`.

## 5. Wire contract (all additive)

### 5.1 `GET /v1/config`

New object `cameraPolicy`; the existing `speedCameraNamespaceEnabled` stays and is now *"the node delivers camera data"* (brake released
**and** some level above `off`), which is what old clients always meant by it. With the defaults it is `true`.

```jsonc
"cameraPolicy": {
  "version": "9c1f0a52d7b3e6a1",          // fingerprint of everything below — changes whenever the effective policy changes
  "namespaceEnabled": true,               // the brake: false = every country is off
  "defaultLevel": "full",                 // level of every country not listed in byCountry
  "byCountry": { "CH": "off", "FR": "zones" },   // the EXCEPTIONS, as EFFECTIVE levels (network ∧ local caps ∧ brake)
  "zoneResolution": 6,                    // H3 resolution of zones on this node
  "notice": { "version": 1, "text": { "de": "…", "en": "…" } }   // see 5.5
}
```

A client reads the level of a country as `byCountry[country] ?? defaultLevel`. `networkConfig` (the full signed envelope) keeps carrying
the raw network policy. A client that knows the network root key should take the **stricter** of `networkConfig.payload.cameraPolicyByCountry`
(verified; a country it does not list is `full`) and `cameraPolicy` (the node's own claim, which can only be stricter).

### 5.2 Zone item

```jsonc
{
  "id": "0b5f5d2c-3f0f-5c3e-9e55-6c8b1ac1f2f4",      // derived from the cell — identical on every node
  "cell": "861f1d48fffffff",                         // H3 index
  "resolution": 6,
  "boundary": { "type": "Polygon", "coordinates": [[[lng, lat], …, [lng, lat]]] },
  "cameraTypes": ["fixedSpeedCamera", "mobileSpeedCamera"],   // sorted; the kinds present in the cell
  "status": "active"                                 // "removed" only inside events
}
```

There is deliberately **nothing else**: no `position`, no source, no timestamps, no counts, no camera id.

### 5.3 Reads

* `GET /v1/speed-cameras/nearby` and `/by-tile` → `{ "cameras": [ … ], "zones": [ … ] }`. `zones` is always present (empty while no country is at `zones`).
* `GET /v1/snapshot` → new `cameraZones: []` next to `fixedSpeedCameras` / `enforcementDevices`: the zones of the persistent devices
  (omitted with `?staticData=false`, as the devices are) plus the zones of the cells the requested `tiles` speak for - which is where
  the live camera reports of `zones` countries show up, as zones.
* Static package of a tile → new key `cameraZones: [ … ]`, **omitted when empty** (a tile without zones keeps its bytes and hash).
  A zone is carried by the package of the tile that is the H3 parent of the zone cell, whichever tile the camera itself is in.
  A package holds persistent devices only, so its zones list the kinds of devices; `nearby`, `by-tile`, the snapshot and events also
  count the live reports of the cell. A client keys zones by `id` and unions their `cameraTypes`.
* `GET /v1/delta` and WebSocket → events with `entityType: "cameraZone"`, `entityId` = the zone id, type `StaticDataUpdated`
  (the zone exists with this content now) or `StaticDataRemoved` (no camera of the requested kinds is left in the cell). The payload is
  the zone item, `regionTile` is `null`, `source` is `"zone"`. Events of one cell inside a delta page are collapsed into one, carrying the
  cell's state *now*. A zone event goes to a client that asked about a tile the **cell** touches (delta: `tiles`; WebSocket: a subscription
  tile of the region resolution inside the cell) - not to the client that listens to the tile the camera is in: at the region resolution
  (7) that would tell a listener in which seventh of the cell the camera is. Events about persistent devices carry no tile and are global,
  like the devices. Old clients skip the unknown entity type. The delta cursor moves over withheld events, also on a page that held
  nothing deliverable.
* `by-tile` / snapshot tiles so coarse that they span more than 5,000 zone cells are refused with `400` rather than silently truncated.
* Items of cameras at level `full` look exactly as before. The internal country set (`camera_countries`) never appears in an event.

### 5.4 Writes

Writing is never blocked. What changes is what the **answer** discloses, because an answer that says "merged with an existing
camera" or returns the merged camera is a read in disguise (a probe at 800 m spacing would map a country that is `off`).

* Camera at level `full` (the default): as always (`201` new / `200` merged, with `camera` / `report` and `merged`).
* Camera at level `zones` or `off` (or while the brake is on): **`202 { "accepted": true }`**, plus `"zone": { … }` when the level is
  `zones`. No `merged`, no object, the same status for new and merged.
* `POST /v1/speed-cameras/:id/removal-reports` and `POST /v1/hazard-reports/:id/confirmations` on a camera: `recorded` / `removed`
  as before; the `camera` / `report` object only at level `full`.

### 5.5 Legal notice

`cameraPolicy.notice` carries a short default text (German and English) saying that using camera data while driving is
forbidden in several countries — in Germany also for passengers — and that in Switzerland even hints are unlawful. It exists
so that web and library show one wording (the web UI and the library show it when a user switches the camera category on); hosts
may ship their own translation. The text is **not** a legal assessment and is the operator's to review.

## 6. Zones: why repeated queries cannot re-condense them into a point

A zone is a cell of a **fixed grid** (H3, `CAMERA_ZONE_H3_RESOLUTION`, default 6 ≈ 36 km², edge ≈ 3.7 km) and the only thing a zone
says is *"at least one camera of these types is somewhere in this cell"*. The properties that make this hold:

1. **Membership is a function of the cell only.** Whether a zone is delivered is decided by the cell's geometry against the query
   area (`nearby`: cell polygon intersects the circle; `by-tile`: the cell is the parent of a requested tile; package: the cell's
   parent tile) — **never by the camera's own position or distance**. A camera 5 m inside the cell and a camera 3 km inside it
   produce byte-identical answers for every possible query. There is no boundary at which a result flips with a camera's position,
   so there is nothing to bisect.
2. **The output contains no per-camera information**: no coordinate, id, timestamp or count — only the cell and the set of types.
3. **Anything that varies with a camera varies with the cell:** event timing and removal reveal only "something changed in cell X";
   consecutive events for one cell are collapsed; the zone id is derived from the cell, not from the camera's UUID.
4. **The same projection serves every path**, so no path answers more precisely than another (a zone from `nearby` and from the
   package are equal), and the write answer carries no `merged` signal.

The information an observer can gather is therefore bounded by the grid: one bit per cell and type, however often and from wherever
they ask. This is tested by probing one cell from many points and radii, from inside it and just outside it, and asserting that the
answers are identical (inside) and empty (outside), and that no coordinate in any response is finer than a cell vertex.

What a zone does **not** do is make the position unknowable *to the node*: the exact position stays in the node's database (the
node must know it to build zones). Operators can only protect it with ordinary means (access to the database, backups).

## 7. Changing the policy

* The signed file is re-read every `CAMERA_POLICY_RELOAD_SECONDS` (default 30; `0` disables) and verified against
  `NETWORK_ROOT_PUBLIC_KEY`. A restart also reads it. There is no signal handler (Windows has none) and no admin endpoint.
* The package builder takes the policy once per tile, inside the tile's snapshot and after the version, and a policy change swaps the policy
  first and bumps the version second: a tile built under the old policy can never be recorded as current for the new one.
* The first start after the upgrade has no stored policy; it is measured against "nothing was delivered" (the version before this add-on
  delivered no cameras unless its switch was on), so the cameras of a node that upgrades are marked for its first package build. A package set
  that was built with the old switch **off** is otherwise current and is not rebuilt for the upgrade; one built with it **on** is rebuilt once.
  `npm run cameras -- load-boundaries` / `resolve-countries` mark the tiles of the cameras whose country they set, like a bulk import.
* **A stricter policy never leaves old packages reachable.** The tiles that hold cameras of a country whose level went *down* (or all
  tiles, when the default level goes down, e.g. the brake) are marked `policy_stale` (next to `dirty`). Their package - the current one *and*
  the superseded ones that are normally kept for two hours so running downloads can finish - is not served (`503 PACKAGES_BUILDING`, also
  through the content-addressed URL) until a rebuild has replaced it, and the rebuild deletes the old files at once instead of keeping them.
  A small dataset is rebuilt by the request that finds a stale tile, a large one in the background straight away (not after the worker's
  debounce); the manifest answers `503` meanwhile rather than listing a tile as gone (a client would drop its other data). A looser policy
  only marks tiles dirty: until rebuilt they just lack the new data.
* On a change of the **effective** policy the node (a) swaps the policy atomically — requests in flight see one consistent policy —
  (b) compares it with the last one it stored (`static_data_state.camera_policy`: default level, unknown level, exceptions, zone size),
  (c) marks only the package tiles that contain cameras of the countries whose level changed (and the parent tiles of their zones) as dirty
  and (d) bumps the static-data version once. Clients see `cameraPolicy.version` change in `GET /v1/config` and a new static-data version;
  no event is sent per camera.
* A client library that finds a stricter policy than the one under which it stored data **removes the data locally** (part C).

## 8. Operating

See `operating.md`, "Camera policy". In short: out of the box nothing has to be done — cameras are delivered. To restrict a country:
load boundaries (`npm run cameras -- load-boundaries`), generate/keep the root key, sign
`--blitzer-enabled true --camera-policy "CH=off,FR=zones"`, distribute the file to every node. To lift a restriction: sign a higher version
without the country and distribute it; the nodes pick it up within the reload interval. For an immediate cut-off of everything set
`SPEED_CAMERA_NAMESPACE_ENABLED=false` (restart) or sign `--blitzer-enabled false`.

## 9. Not built / open for the operator

* **The default is `full` everywhere**, by the operator's decision. A node therefore delivers cameras in countries in which the operator
  has not (yet) assessed them; restricting a country is an act the operator has to take — this is the trade-off of "released by default".
* **The user's own country is not considered.** The policy is about the country *of the camera*. A driver in a country that forbids
  hints who asks near a border receives what the *camera's* country allows. A host app that knows where the driver is should also
  hold back by the driver's country — `cameraPolicy` gives it the levels. Whether the server should also use the position
  of the request is a decision for the operator (it would not work for packages and `by-tile`).
* Boundary data and its accuracy; the notice wording.
* Camera events written before this feature get their country from the entity they are about (`load-boundaries` / `resolve-countries`); an
  expiry event of such a report has no position and is not delivered at level `zones`.
* The content of a zone differs by source (section 5.3): packages count persistent devices only. A client unions by zone id.
* Camera data in the database is not encrypted or aggregated at rest: the node holds exact positions even for `off` and `zones` countries
  (it must, to write, merge and later release them). Protecting the database is the operator's.
* Persistent devices are node-local and the signed policy is distributed by file; automatic distribution of the signed config over
  federation is not part of this add-on.
