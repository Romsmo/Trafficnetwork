# Country-based camera policy (add-on A, server part)

Scope: `Zusatz-Prompts — Blitzer-Funktion aktivierbar machen (länderabhängig)`, part A. The camera categories
(`fixedSpeedCamera`, `mobileSpeedCamera`, `trailerCamera`, `redLightCamera`, `distanceControl`) become deliverable —
**per country**, never by a single global switch, and **nothing is released by code**: until the operator has signed a
policy, every country is `off` and the server delivers no camera data of any kind.

> **This is a legal decision of the operator, not a technical one.** The levels below are a mechanism. Which country
> may be `zones` or `full`, and whether a camera function may be offered at all, depends on the law of each country and
> on the role of the *operator* (which is not the role of the driver) — to be reviewed by the operator before a level
> above `off` is signed. Nothing in this document, the code or its defaults is legal advice.

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
| `full` | the individual camera, exactly as for any other category |

**Effective level of one country** = the strictest of

1. the **signed network policy** (`cameraPolicyByCountry[CC]`, absent = `off`),
2. the **node's local cap** (`CAMERA_POLICY_LOCAL_CAPS`, absent = no cap),
3. the **emergency brake** — `SPEED_CAMERA_NAMESPACE_ENABLED=false` on the node *or* `blitzerEnabled: false` in the signed
   config turns **every** country `off`, whatever else is configured.

A node can therefore be stricter than the network, never more generous. The environment default of the brake stays
`false` (unchanged): to deliver anything an operator must both release the brake **and** sign a country policy.

**Effective level of one camera** = the strictest level over the camera's **country set** (section 3). An empty or
unknown country set is `off`.

## 2. Network configuration

`NetworkConfigPayload` (the root-signed config, `NETWORK_CONFIG_PATH`) gets one optional field:

```jsonc
{
  "version": 7,
  "blitzerEnabled": true,                       // unchanged: network-wide brake
  "cameraPolicyByCountry": { "DE": "full", "FR": "zones", "CH": "off" },   // NEW — ISO 3166-1 alpha-2, upper case
  ...
}
```

* Absent field, empty object or a country that is not listed: `off`.
* Keys must match `^[A-Z]{2}$`, values must be one of the three levels, at most 300 entries — anything else makes the
  file invalid. At start-up an invalid file stops the server (as for every signed-config error). While running, an
  invalid file **fails closed**: the camera policy becomes all-`off` until a valid file is read; everything else on the
  node keeps working.
* Signed like the rest (`npm run network:sign-config -- … --camera-policy DE=full,FR=zones`).
* **Takes effect without a restart** (section 7). `version` must grow: a reload whose `version` is lower than the one
  in use is refused (rollback protection for the running process); the same version with different content is refused
  too — bump the version.
* A node with no signed config has no policy: all `off`. A standalone node generates its own root key and signs its own
  policy, like a federated one.

## 3. Which country a camera is in

**Decision: store, once, a country *set* per camera — computed by the server from the position against a boundary table
at write time, plus an explicit border strip. No importer-supplied code, no guessing per query.**

* New nullable column `countries text[]` on `fixed_speed_cameras` (persistent devices) and `hazard_reports` (filled for
  the camera types only), and `camera_countries text[]` on `event_log` (filled for camera events only, so delta and
  WebSocket decide without re-deriving).
* The set is computed by the SQL function `camera_countries(geometry, margin_m)`: all countries whose boundary is **within
  `CAMERA_POLICY_BORDER_MARGIN_M` (default 1000 m)** of the point. One element almost always; **two or more inside the
  border strip**, and then the **strictest level wins**. The error is made deliberately in one direction: a camera next
  to a border is withheld if either side forbids it.
* A point that is within the margin of **no** boundary (sea, outside the dataset) has the empty set → `off`.
  No boundary data loaded → every camera has the empty set → `off`. Missing data fails closed.
* Why not the other options: an importer cannot know better than the border (OSM nodes carry no country, and trusting
  a supplied code is a way to mislabel a camera into a permissive country); deriving at every query repeats work and
  makes the answer depend on the query path. One stored value is read the same way by every endpoint.
* **The boundary data is not shipped.** It is geodata with its own licence, and its accuracy is the operator's choice:
  `npm run cameras -- load-boundaries <file.geojson>` loads any GeoJSON country dataset (Natural Earth admin-0 at 1:10m
  is public domain and accurate to a few hundred metres; the 1:50m set needs a margin of several km). The loader
  subdivides the polygons (`ST_Subdivide`) so a lookup stays a sub-millisecond index probe, and then re-resolves every
  stored camera (`resolve-countries`).
* Rows that were written before boundaries existed, or while none were loaded, have `countries IS NULL` = unresolved =
  `off`, until `resolve-countries` runs. `npm run cameras -- status` counts them.

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
stored in: a camera event whose set was never filled in counts as "country unknown" and is withheld, so a forgotten column fails closed.

The federation point is a **pre-existing back door** this add-on closes: `GET /v1/federation/events` is unauthenticated and
used to return every device-signed report — camera reports with their exact coordinates included — whatever the camera
flag said.

## 5. Wire contract (all additive)

### 5.1 `GET /v1/config`

New object `cameraPolicy`; the existing `speedCameraNamespaceEnabled` stays and is now *"the node may deliver camera data for at least one
country"* (brake released **and** some effective level above `off`), which is what old clients always meant by it.

```jsonc
"cameraPolicy": {
  "version": "9c1f0a52d7b3e6a1",          // fingerprint of everything below — changes whenever the effective policy changes
  "namespaceEnabled": true,               // the brake: false = every country is off
  "defaultLevel": "off",                  // level of every country not listed
  "byCountry": { "DE": "full", "FR": "zones", "CH": "off" },   // EFFECTIVE levels (network ∧ local caps ∧ brake); absent = off
  "zoneResolution": 6,                    // H3 resolution of zones on this node
  "notice": { "version": 1, "text": { "de": "…", "en": "…" } }   // see 5.5
}
```

`networkConfig` (the full signed envelope) keeps carrying the raw network policy. A client that knows the network root
key should take the **minimum** of `networkConfig.payload.cameraPolicyByCountry` (verified) and `cameraPolicy.byCountry`
(the node's own claim, which can only be stricter).

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

* `GET /v1/speed-cameras/nearby` and `/by-tile` → `{ "cameras": [ … ], "zones": [ … ] }`. `zones` is always present.
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

* Camera at level `full`: as today (`201` new / `200` merged, with `camera` / `report` and `merged`).
* Camera at level `zones` or `off` (or an unresolved country): **`202 { "accepted": true }`**, plus `"zone": { … }` when the level is
  `zones`. No `merged`, no object, the same status for new and merged.
* `POST /v1/speed-cameras/:id/removal-reports` and `POST /v1/hazard-reports/:id/confirmations` on a camera: `recorded` / `removed`
  as before; the `camera` / `report` object only at level `full`.

### 5.5 Legal notice

`cameraPolicy.notice` carries a short default text (German and English) saying that using camera data while driving is
forbidden in several countries — in Germany also for passengers — and that in Switzerland even hints are unlawful. It exists
so that web and library show one wording; hosts may ship their own translation. The text is **not** a legal assessment and is
the operator's to review before any level above `off` is signed.

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
* The first start after the upgrade has no stored policy; it is taken as the empty policy, so whatever the signed file lists is "new" and the tiles
  of those countries are marked. `npm run cameras -- load-boundaries` / `resolve-countries` mark the tiles of the cameras whose country
  they set, like a bulk import.
* **A stricter policy never leaves old packages reachable.** The tiles that hold cameras of a country whose level went *down* are marked
  `policy_stale` (next to `dirty`). Their package - the current one *and* the superseded ones that are normally kept for two hours so running
  downloads can finish - is not served (`503 PACKAGES_BUILDING`, also through the content-addressed URL) until a rebuild has replaced it, and
  the rebuild deletes the old files at once instead of keeping them. A small dataset is rebuilt by the request that finds a stale tile, a
  large one in the background straight away (not after the worker's debounce); the manifest answers `503` meanwhile rather than listing a
  tile as gone (a client would drop its other data). A looser policy only marks tiles dirty: until rebuilt they just lack the new data.
* On a change of the **effective** policy the node (a) swaps the policy atomically — requests in flight see one consistent policy —
  (b) compares it with the last one it stored (`static_data_state.camera_policy`), (c) marks only the package tiles that contain
  cameras of the countries whose level changed (and the parent tiles of their zones) as dirty and (d) bumps the static-data
  version once. Clients see `cameraPolicy.version` change in `GET /v1/config` and a new static-data version; no event is sent
  per camera.
* A client library that finds a stricter policy than the one under which it stored data **removes the data locally** (part C).

## 8. Operating

See `operating.md`, "Camera policy". In short: load boundaries, generate/keep the root key, sign
`--blitzer-enabled true --camera-policy DE=full,FR=zones`, distribute the file to every node, release the brake on the nodes
that may deliver. To withdraw: sign a higher version without the country (or with `--blitzer-enabled false`) and distribute it; the
nodes drop the data within the reload interval. For an immediate local cut-off set `SPEED_CAMERA_NAMESPACE_ENABLED=false` and restart.

## 9. Not built / open for the operator

* **No country is `full` or `zones` by default**, anywhere, ever; the example above is illustration.
* **The user's own country is not considered.** The policy is about the country *of the camera*. A driver in a country that forbids
  hints who asks near a border receives what the *camera's* country allows. A host app that knows where the driver is should also
  hold back by the driver's country — `cameraPolicy.byCountry` gives it the levels. Whether the server should also use the position
  of the request is a decision for the operator (it would not work for packages and `by-tile`).
* Boundary data and its accuracy; the notice wording; whether the emergency-brake default should become `true` once a policy exists.
* Camera events written before this feature get their country from the entity they are about (`load-boundaries` / `resolve-countries`); an
  expiry event of such a report has no position and is not delivered at level `zones`.
* The content of a zone differs by source (section 5.3): packages count persistent devices only. A client unions by zone id.
* Camera data in the database is not encrypted or aggregated at rest: the node holds exact positions even for `off` and `zones` countries
  (it must, to write, merge and later release them). Protecting the database is the operator's.
* Persistent devices are node-local and the signed policy is distributed by file; automatic distribution of the signed config over
  federation is not part of this add-on.
