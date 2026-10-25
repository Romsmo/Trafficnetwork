# Context signs: traffic signs that apply on a stretch of road (server 1.4.0, client library 1.3.0)

A **context sign** says: "this traffic sign applies *here* (a stretch of road), *this way* (one direction or both), *then* (always, at certain
hours, for a period)". People enter them, other devices confirm or object, and the library tells an app which signs apply at the
position and just ahead. The first use is a display in the car with two columns of signs next to the big speed-limit sign; the signs of
the display's catalogue (58) are the start.

The stock **starts empty**. There is no import and no seed; nothing is taken from sources of unclear licence. Every endpoint, the page
and the library work with "none" (empty lists, never an error, never a placeholder).

This page is the planning document in the style of `speed-limit-corrections.md`: each decision with its reason. Where the requirement
says *must*, it is binding; the rest is our design. Endpoint shapes are in `api.md`, tables in `schema.md`, the operator runbook in
`operating.md`, the attacks in `threat-model.md`, the wire format of a signed vote in `federation-protocol.md` (5.4).

## Hard rules and how they are met

| Rule | How |
|---|---|
| Additive, switchable | New tables and endpoints only. `CONTEXT_SIGNS_ENABLED=false` unregisters the endpoints and the page layer; federation ignores the votes; entries and votes stay in the database |
| Nothing personal beyond what is needed | A vote is stored with the pseudonymous reporter id (`device:<key id>`, or `local:<client>` / `web:<session>` for an unsigned vote), exactly as for reports and corrections. No position, no free text |
| Safety before completeness | A sign nobody confirmed is marked `confirmed: false`; the library delivers confirmed ones unless asked for more. Disputed and expired entries are not delivered. A one-way sign is not delivered when the heading is unknown |
| Server delivers raw data | No columns, no sides, no replacement logic (276 replaces 277, 283 replaces 286): the app decides by `sign-rules.json` of the display project |
| Only this repository | The app and the display project are not touched |

## Decisions

### D1. Catalogue

`signType` is a country-prefixed reference like `static_signs.sign_type` (`DE:276`, `DE:142-10`). The catalogue
(`modules/context-signs/catalog.ts`) holds the **58 signs** of the display (Appendix A of the requirement): 31 warnings
(101 ... 151) and 27 prohibitions/commands (250 ... 286). Per sign it knows the longest stretch, whether it stands at one place, whether
it carries a value (253, 262-5, 263-8: tonnes; 264-2, 265-3, 266-10, 273-70: metres) and whether it is temporary.

* A code outside the catalogue (another country, an unknown number) is **rejected** (`UNKNOWN_SIGN`), never stored as "unknown": a
  sign the app cannot draw is useless to it and a stored unknown would have to be carried by every node for ever.
* Speed limits (274) stay with the speed-limit logic and are not in the catalogue.
* Another country is added by giving it a catalogue; nothing else changes. The bytes on the wire stay the same.

### D2. The descriptor: what an entry is

```
{ v: 1, signType, geometry: [[lng, lat], ...], direction: "along" | "both", validity, value, unit }
```

It is what a device signs and what nodes replicate, **stored as signed**. Its **normal form** (coordinates at 1e-7 degrees, a stretch
without direction in canonical orientation, windows sorted and days unique) is hashed (RFC 8785 canonical JSON, SHA-256, 32 hex
characters): that is the **entry key** `id`. The same proposal made by different devices, on different nodes, is the same entry with no
coordination.

Why the shape and not a road id: a re-import that cuts the road network differently must not orphan entries (the problem the
corrections have with `segmentKey`, "orphans"). The entry is self-contained.

### D3. The stretch (question 1) and the direction (question 2)

* **Two points** on the road, as for a speed-limit interval: the node finds the road between them (`roads/resolve.ts`) and the entry
  is the road's own shape. The shape is **oriented in the direction of travel the sign applies in** (first pick to second pick), so
  `along` means "driving along the stored line". `both` is stored in canonical orientation.
* A sign that **stands at one place** (a crossing, an end sign, 280-282, 151, 131 ...) is picked with **one point** and the direction of
  travel (`heading`): the shape is 8 m of the nearest road from there, in that direction.
* A sign that covers a stretch needs **two points**. We considered "from here to the next junction"; it was dropped: from the road
  data alone the end of a prohibition is not a junction (a driveway is not one, a side road may be), and a guessed end is a made-up sign.
  "Until the end sign" is expressed the way it is on the road: with an end sign (280, 281, 282) as its own entry.
* Never a shape off a road: a proposal is refused unless its first, middle and last vertex lie on a way this node knows
  (`SHAPE_OFF_ROAD`, `NO_ROAD_DATA`).
* **Direction in the library** (`getContextSigns`): the heading is compared with the bearing of the stretch at the position. `along`
  applies within 60 degrees of it. `both` applies either way. **Unknown heading** (no fix, standing still): only `both` entries that
  contain the position are delivered, one-way entries are not, and nothing "ahead" can be told.

### D4. Thresholds (question 4)

An entry is `confirmed` when enough **distinct** devices support it:

| Class | Signs | Needed | Why |
|---|---|---|---|
| prohibition | 250 ... 286 | **3** (`CONTEXT_SIGNS_CONFIRMATIONS_PROHIBITION`) | a prohibition shown wrongly misleads a driver most; the same threshold as speed-limit corrections |
| hazard | 101 ... 151 | **2** (`CONTEXT_SIGNS_CONFIRMATIONS_HAZARD`) | a warning shown wrongly costs a glance; it is also the class that changes most, so it must be quick |

An entry is `disputed` when at least `CONTEXT_SIGNS_DISPUTE_MIN_DENIALS` (2) devices object **and** at least as many as support: it is
no longer delivered. A confirmed entry with three supporters survives two objections. Supporters and objectors are counted by their
**standing** stance (the latest vote of each device in `(timestamp, id)` order), so changing one's mind counts once.

### D5. Duplicates (question 5)

* Exactly the same descriptor: the same entry (D2).
* A near-duplicate (the same sign on the same road, 15 m tolerance, the stretches overlapping): `POST /v1/context-signs/resolve` returns
  `similar` entries with both overlap shares. The client shows them; the person decides "this is it" (a vote for the existing entry)
  or "different" (a new one). The node never merges two entries on its own, because that would depend on the order the proposals
  arrived in, and nodes must converge from the set of votes alone.

### D6. Reporter identity and Sybil resistance

* A signed vote: reporter `device:<keyId(devicePublicKey)>` on every node. A locally sent `deviceAssertion` must use the key **bound to
  the calling client**; otherwise a client could mint "distinct devices" by generating keys.
* An unsigned vote: `device:...` if the client has a bound key (so one device never counts twice), `local:<client>` otherwise;
  node-local, never replicated.
* **Web visitors** (anonymous sessions that are free to create) are counted **together as at most one voice** per entry: they support when
  more of them support than object, object when more object, and say nothing on a tie. A page alone can therefore never confirm
  anything; with the 2 of a hazard sign it needs one app device on top.
* Budgets per **calling client** and day: `CONTEXT_SIGNS_PROPOSALS_PER_DAY` (20) new entries and `CONTEXT_SIGNS_VOTES_PER_DAY` (100)
  votes. A cap on unconfirmed entries around one place (`CONTEXT_SIGNS_MAX_UNCONFIRMED_PER_CELL`, 50 within 3.7 km). Operator `ban`.
* Residual risk (documented, not solved; `threat-model.md`): whoever can create many device credentials can reach a threshold.
  Mitigations: the budgets above, the threshold as the operator's decision, `remove`/`ban`, excluding a node.

### D7. Time (question 3)

A small format of its own, not OSM `opening_hours` (whose grammar is large, has no stable canonical form for hashing and would need a
parser in every binding):

```
validity = { v: 1, tz: "Europe/Berlin",
             windows?: [{ days: [1..7], from: "HH:MM", to: "HH:MM" }],   // ISO weekdays, local time; from > to crosses midnight
             period?:  { from: "YYYY-MM-DD", to: "YYYY-MM-DD" | null } } // local dates, inclusive; to null = until revoked
```

No `windows` and no `period` = always. Windows and dates are read in the **local time of the place** (`tz`), so a rule written down in
autumn means the same after the clock change. A window that crosses midnight belongs to the day it starts on (22:00-06:00 on Friday
runs until Saturday 06:00).

* `tz` is proposed by the node from the country of the place (a small table of European countries; where boundary data is not loaded,
  `CONTEXT_SIGNS_DEFAULT_TIMEZONE`). A proposal may change it, within `CONTEXT_SIGNS_TIMEZONE_PREFIXES` (default `Europe/`):
  **Europe first, the rest of the world is open** by adding prefixes.
* **Public holidays: not modelled** in this version. A wrong holiday calendar shows a sign that does not apply, which is worse than
  not showing a rule that needs one. The format carries a version so they can be added later.
* Temporary signs: roadworks (123) must carry a period with an end, at most 90 days; a traffic-jam warning (124) at most 3 days.

### D8. Plausibility (question 8)

Per sign the **longest stretch**: 20 km for prohibitions, 3 km for warnings, 5 km for some (wild animals, slopes), 10 km for roadworks,
2 km for no-stopping, **60 m** for signs that stand at one place. Neighbouring vertices at most 2.5 km apart, at most 300 vertices, at
least 2 m of length. Values within the sign's range (a height 0.5-10 m, a weight 0.5-100 t ...). A value only where the sign carries
one. The node also checks that the shape lies on its road data (D3). Not done: "this sign on this road class" - road classes of OSM
are too coarse to say a 276 is wrong on a residential street.

### D9. Federation

A device-signed vote is a new envelope payload `kind: "contextSignVote"`:

```
{ kind, vote: "support" | "deny", entryKey, entry?: descriptor, devicePublicKey, timestamp }
```

A `support` carries the **whole descriptor** (how an entry is proposed, and how a node that has never seen it learns what it is); its hash
must equal `entryKey`. A `deny` may name just the key. Vote id = `sha256(canonical({payload, signature}))` as for reports.

* **Push:** `POST /v1/federation/events` gains an optional `contextSignVotes` array. **Pull:** `GET /v1/federation/context-sign-votes
  ?after=&limit=`, a cursor per peer (`network_peers.last_pulled_context_votes_sequence`), durable like the corrections' votes (no
  maximum age). A peer answering 404 (older, or feature off) is skipped silently.
* **Ingest:** verify the signature, reject timestamps more than 5 minutes in the future, validate the descriptor against the
  catalogue and the plausibility limits, **take it as signed** (no re-resolution against this node's road network, no "is it on a road
  I know": the origin node did that), `ON CONFLICT DO NOTHING`, recompute.
* **Conflict resolution:** none needed. The state of an entry is a **pure function of the set of non-banned votes** (D4), so two nodes
  holding the same votes agree, in any order. A `deny` that arrives before the `support` is kept in the log and counts as soon as the
  entry exists.
* Operator removals and bans are **local policy** and are not replicated.

### D10. Expiry (question 4)

| Entry | Expires |
|---|---|
| nobody confirmed it | `CONTEXT_SIGNS_UNCONFIRMED_DAYS` (14) after its last vote |
| confirmed, with a period that has an end | two days after the end date (the library reads the exact time; the node only stops delivering) |
| confirmed, "until revoked" (`period.to: null`) | `CONTEXT_SIGNS_OPEN_ENDED_DAYS` (365) after its last supporting vote: it needs a confirmation now and then |
| confirmed, permanent (no period) | never by itself; disputed instead (D4) |

An expired entry is not delivered (the answer filters on the time itself, so a late worker changes nothing), and a worker marks it
`expired` every ten minutes, which moves the version. A new supporting vote revives an unconfirmed one.

### D11. Delivery and offline data (question 7)

* **Not** in the static-data packages: they would change the package fingerprint and force every node to rebuild its (large) packages.
  Entries are few (about 300 bytes each; 10 000 entries are about 3 MB) and change with every vote, so they have a small interface of their own.
* `GET /v1/context-signs?bbox=` and `?lat=&lng=&radiusM=` for the page and for a client that is online.
* `GET /v1/context-signs/tiles?tiles=<H3 cells>&since=<version>`: the tiles are the H3 cells of `staticDataPartitionH3Resolution`, an
  entry belongs to every tile that holds one of its vertices (the packages' rule). `since` is the version the client holds: while the
  `version` (also in `/v1/config` -> `contextSigns.version`) is unchanged the answer is `{unchanged: true}`, a few bytes.
* The version moves when the **delivered set** changes: an entry appears, disappears, or becomes confirmed. A further vote that changes
  only a counter does not move it (the counts in a download are "as of the last change"; `GET /v1/context-signs/:id` is live).
* Size to expect per region: a county-sized tile with 100 entries is about 30 KB (gzip about 8 KB).

### D12. What the client library does

`getContextSigns({ lat, lng, headingDeg?, aheadM = 1500, at?, includeUnconfirmed = false, includeInactive = false })`:

1. The entries of the tiles around the position come from the local store (offline, like `getSpeedLimitAt`).
2. **Space:** the position is projected onto each stretch (nearest segment). It is *on* the stretch within 30 m. The stretch is read in the
   direction of travel (for `both`, the end the heading reaches first). Where the position is on it: `startsInM <= 0` (minus the
   metres driven along it) and `endsInM` the metres left. Ahead: `startsInM` is the distance to its first vertex, only for a vertex that
   lies within 60 degrees of the heading and within `aheadM`.
3. **Direction:** D3.
4. **Time:** at the instant `at` (default now) in the entry's `tz`: the period, then the windows (D7). `activeNow`; `validUntil` = the end of
   the current window/period (null = no end); an inactive entry (with `includeInactive`) has `nextActiveAt` (within 8 days).
5. Entries that expired (`expiresAt`) or are not confirmed (unless asked) are left out. Order: by `startsInM`, then `id`.

The test vectors (`client-lib/fixtures/context-sign-vectors.json`) pin this, including the midnight window, the clock change, the
opposite direction, a stretch that ends exactly at the position, expired, disputed and empty.

`reportContextSign` resolves (online), signs and sends a proposal; offline it is held in the write buffer like other writes (the
resolution needs the node, so the buffered item is the *resolve request*, resolved and signed on delivery). `confirmContextSign` /
`denyContextSign` vote on an entry id.

### D13. Switching it off

`CONTEXT_SIGNS_ENABLED=false`: the endpoints are not registered, `/v1/config` says `contextSigns.enabled=false`, federation acknowledges
pushed votes as `ignored` and the pull endpoint does not exist (peers read the 404 as "not offered"). Stored entries and votes stay.

## Tests

* Unit: catalogue (58, classes), descriptor (normal form, key, every refusal), tally (order independence, web visitors, thresholds,
  dispute, removal, every expiry), time zones, overlap.
* Integration (a real PostGIS): empty start; resolving (two points, orientation, one point with heading, every refusal); propose and
  confirm with signed votes; thresholds per class; disputes; web visitors; off-road/no-road-data/too-long/foreign key; similar entries;
  windows and values; budgets and the cap per area; operator remove/restore/ban; expiry and the version; federation ingest and the pull
  stream; switched off.
* E2E: the page (layer, entering, voting, accessibility light/dark, phone).
* Library: the vectors in every binding (conformance).

## Non-goals

No import of any source; no holidays; no replacement logic; no sides; no editing of an entry (a wrong entry is objected to and a right one
proposed); no change to speed limits; no cross-country catalogue beyond `DE` yet.
