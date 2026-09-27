# Server API (Phase 1)

Base path: `/v1`. All responses are JSON. All routes require authentication
(`Authorization: Bearer <token>`) except `GET /v1/health`, `POST /v1/auth/token`,
`POST /v1/auth/device-token`, `POST /v1/web/session` (only with the built-in web UI,
see "Web sessions"), `GET /v1/network/node-info`,
`GET /v1/network/directory`, `GET /v1/stats/online`, the `/v1/federation/*`
endpoints (F-S3, only registered when `FEDERATION_ENABLED=true` — see
"Federation" below; each authenticates itself via a signed envelope, not a
client Bearer token), and the `/v1/ws` WebSocket upgrade (which authenticates
via its own first-message handshake instead — see "Real-time push" below).

## Error format

```json
{ "error": { "code": "STRING_CODE", "message": "human-readable", "details": {} } }
```

| HTTP | Meaning |
|---|---|
| 400 | `BAD_REQUEST` / `VALIDATION_ERROR` — malformed input |
| 401 | `UNAUTHORIZED` — missing/invalid/expired token, or bad client credentials |
| 403 | `FORBIDDEN` — valid token, missing required scope |
| 404 | `NOT_FOUND` |
| 409 | `SNAPSHOT_REQUIRED` (delta only) or `REPORT_NOT_ACTIVE` |
| 429 | Moderation-gate rate limit, or `@fastify/rate-limit`'s standard 429 body on `/v1/auth/token` |
| 500 | `INTERNAL_ERROR` |

## Auth

### `POST /v1/auth/token`

Client-credentials exchange. Not full OAuth2 — deliberately minimal for a
single-operator MVP. IP-rate-limited (10/minute via `@fastify/rate-limit`) to
blunt credential brute-forcing — this is on top of, not instead of, the DB
lookup and secret verification.

```
Request:  { "clientId": "...", "clientSecret": "..." }
Response: { "accessToken": "<jwt>", "tokenType": "Bearer", "expiresIn": 3600, "scopes": ["client"] }
```

Credentials are provisioned out-of-band via `npm run create-client` (see
`server/README.md`) — there is no self-service signup endpoint in Phase 1.

Scopes: `client` (normal read/write access), `bulk-import` (grants the
`/v1/bulk-import/*` endpoints), and `device-registration` (grants
`POST /v1/devices/register` — see "Device registration" below). A client
credential maps 1:1 to a reporter identity — every write endpoint derives
`reporterId` from the token's subject, never from the request body.

### `POST /v1/devices/register`

Anonymous device registration for client-lib integrators (requires the
`device-registration` scope, i.e. an "app key" provisioned via
`create-client --scope device-registration`). Mints a fresh, ordinary
`client`-scoped credential — the device then calls `POST /v1/auth/token` with
it exactly like any other client, getting its own reporter identity.

```
Response: { "clientId": "client_...", "clientSecret": "..." }
```

IP-rate-limited (10/minute, like `/v1/auth/token`) plus a per-app-key daily
cap (`DEVICE_REGISTRATION_RATE_LIMIT_MAX_PER_DAY`, default 50) — both return
429. The minted credential's `registeredByClientId` (internal, not returned
in the response) traces it back to the app key that requested it, so an
app's devices can be looked up or bulk-revoked if the app key itself is
revoked.

### `POST /v1/devices/bind-key` (F-S2)

Binds a device-generated Ed25519 public key to the **caller's own** existing
client identity (any scope, not just device-registration credentials) —
authenticated normally via `Authorization: Bearer`. Purely additive: this is
the "upgrade a P1/P2 symmetric-secret client to also support signed auth"
step in the federation migration path (`server/docs/threat-model.md`),
preserving the client's `clientId`/history rather than starting over.

```
Request:  { "assertion": { "payload": { "publicKey": "<base64url Ed25519>", "timestamp": "<ISO 8601>" },
                            "keyId": "...", "signature": "<base64url>" } }
Response: { "bound": true, "publicKey": "<base64url Ed25519>" }
```

`assertion` is a [`SignedEnvelope`](#signedenvelope) — signed by the **new**
device key itself, over a payload that names that same key
(`payload.publicKey`), which is what proves possession of the private half
(not the Bearer token, which only proves *which* client is asking).
`timestamp` must be within 60 seconds of server time (replay protection —
see [`isFreshTimestamp`](#signedenvelope)). One-shot: 409 `KEY_ALREADY_BOUND`
if the client already has a key bound (key rotation isn't built yet).

### `POST /v1/auth/device-token` (F-S2)

Additive alternative to `POST /v1/auth/token` for a client that has bound a
device key — same response shape, same downstream scope/auth handling, just
proved by a signature instead of a shared secret. This is the actual point of
asymmetric device identity (`docs/federation.md` section 2): any server that
has this client's *public* key — not just the one that originally issued its
credential — can verify it, with no secret ever transmitted between servers.

```
Request:  { "clientId": "...", "assertion": { "payload": { "clientId": "...", "timestamp": "<ISO 8601>" },
                                                "keyId": "...", "signature": "<base64url>" } }
Response: { "accessToken": "<jwt>", "tokenType": "Bearer", "expiresIn": 3600, "scopes": [...] }
```

Verified against the public key stored on that `clientId`'s row (never a key
supplied in the request) — 401 if the client doesn't exist, is revoked, has
no bound key, the assertion's `clientId` doesn't match the request's, the
timestamp is stale, or the signature doesn't verify. All of these return the
same generic error, deliberately, so the endpoint can't be used to enumerate
valid client ids (same pattern `/v1/auth/token` already uses).

### `SignedEnvelope`

The one signed-payload shape everything in the federation protocol uses
(device assertions above; heartbeats, join requests and package manifests in
F-S3+): `{ "payload": <canonical JSON>, "keyId": "<16 hex chars>", "signature": "<base64url>" }`.
`payload` is signed as its [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.xml)
canonical form (deterministic regardless of key order/whitespace) using
Ed25519 (Node's native `crypto`, no third-party crypto primitive — see
`server/docs/threat-model.md`). `keyId` is a short fingerprint of the
*claimed* signing key, used only as a lookup hint — verification always
checks the signature against a key the verifier already has an independent
reason to trust (a client's stored `devicePublicKey`, the configured
`NETWORK_ROOT_PUBLIC_KEY`, ...), never against `keyId` itself.

## Network

### `GET /v1/network/node-info`

Public (no auth — has to be fetchable before any credential exchange can
happen, and carries nothing confidential). This server's own identity, not
the multi-server directory (`GET /v1/network/directory`, below).

```json
{ "nodeId": "<16 hex chars>", "publicKey": "<base64url Ed25519>", "federationEnabled": false }
```

`nodeId`/`publicKey` are generated once on first boot and persisted (see
`server/docs/schema.md`'s `node_identity` table) — stable for the life of
this server's database.

### `GET /v1/network/directory` (F-S4)

Public, always registered (unlike `/v1/federation/*` below — a non-federating
server just returns an empty `peers` array, since nothing can ever join it).
The reputation-scored, network-wide directory: this server's own peer
directory, each entry tagged with a computed reputation tier. Also
exportable as a static file for mirroring — see "Network directory export"
in `server/README.md`.

```json
{
  "self": { "nodeId", "publicKey", "address": "https://..." | null, "federationEnabled": true },
  "peers": [ { "nodeId", "publicKey", "address", "tier": "probation"|"active"|"trusted",
               "discoveredVia", "joinedAt", "lastSeenAt", "lastKnownVersion" } ],
  "generatedAt": "<ISO 8601>"
}
```

`tier` is computed on every request from signals *this server itself
measured* about each peer (successful/failed active health checks, invalid
signatures observed in its pushes) — never anything a peer claims about
itself; see `server/docs/threat-model.md` and
`modules/federation/reputation.ts`. Probation-tier entries are capped at
`REPUTATION_DIRECTORY_PROBATION_MAX_SHARE` (default 50%) of the returned
list — a new server stays discoverable without being able to flood the
directory with unproven identities.

## Stats

### `GET /v1/stats/online` (add-on O-A)

How many clients are online at this node right now, plus an *estimated* total
for the whole federation. Public (no auth), always registered, like
`GET /v1/network/node-info`. **Numbers only**: nothing about a person is
stored, logged or returned — see "What counts as online" and "Privacy" below.

```json
{
  "enabled": true,
  "node":    { "online": 12, "windowSeconds": 300 },
  "network": { "online": 87, "nodes": 4, "estimated": true, "asOf": "2026-09-24T12:00:00.000Z" },
  "minDisplayThreshold": 5
}
```

- **`enabled`** — always present. `{ "enabled": false }` (HTTP 200, nothing
  else) means `ONLINE_COUNTER_ENABLED=false`: the feature is off and nothing is
  tracked. A node that predates this endpoint answers 404 instead — a client
  should treat both the same way ("no figure available").
- **`node.online`** — distinct clients online at *this* node. `windowSeconds`
  is the activity window (`ONLINE_WINDOW_SECONDS`).
- **`network`** — only present when the node federates
  (`FEDERATION_ENABLED=true`); absent otherwise (there is no network to
  estimate). `estimated` is always `true`: the figure is this node's own count
  plus what other nodes *claimed* about themselves. `nodes` is how many nodes
  the total is made of (this one included), `asOf` when it was computed.
- **Below the threshold** the exact number is withheld. A figure under
  `minDisplayThreshold` (`ONLINE_MIN_DISPLAY_THRESHOLD`, default 5) is printed as
  `{ "online": null, "below": 5 }` — read as "fewer than 5". Exactly one of a
  number or `below` is ever present, never both. This applies to `node` and to
  `network` independently (`"nodes"`, `"windowSeconds"` and `"asOf"` are
  unaffected). A threshold of 0 disables the masking.
- Cached for `ONLINE_CACHE_SECONDS` (default 10) and sent with
  `Cache-Control: public, max-age=<that>`; concurrent requests share one
  computation. No per-route rate limit, like the other public read endpoints —
  the cache is what keeps it cheap.

**What counts as online.** A client counts once, however many connections or
requests it makes, if either

1. it has an authenticated WebSocket (`GET /v1/ws`) open right now, or
2. it made a *successful sync or write request* within the last
   `windowSeconds`: `GET /v1/snapshot`, `GET /v1/delta`,
   `GET /v1/static-data/manifest`, `GET /v1/static-data/partitions/:tile`,
   `POST /v1/hazard-reports`, `POST /v1/hazard-reports/:id/confirmations`,
   `POST /v1/speed-cameras/:id/removal-reports`. This is what makes a client
   that only polls visible. Plain lookups (`…/nearby`, `…/by-tile`,
   `/v1/config`), failed requests and token exchanges do not count.

Only tokens with the `client` scope count; a `bulk-import` or
`device-registration` credential is a service, not a user. "Same client" means
the same token subject (one client credential per device).

**How the network figure is built.** Every node puts its own count into the
signed heartbeats it already sends (`onlineCount`, see
`server/docs/federation-protocol.md` §4.2). A node adds up the last figure of
each peer that (a) is `active` or `trusted` in *its own* reputation view —
never `probation`, (b) is not in the signed network config's `excludedNodeIds`,
and (c) sent a heartbeat within `ONLINE_PEER_STALE_SECONDS` (default 300). Peer
figures are claims this node cannot check, which is why the result is labelled
an estimate and why per-peer figures are never published — only the sum.

**Privacy.** The count is kept in process memory only: a salted hash of each
online client's token subject (the salt is random per process and never leaves
it) so a device is not counted twice, and the last figure per peer. No IP
address, position, user agent or timestamp of anything but "last seen" is
kept, nothing is written to the database, and nothing is logged for this
feature. Up to `ONLINE_MAX_TRACKED` (default 100 000) distinct clients are
remembered for the window; beyond that new ones are not added (a bounded
undercount rather than unbounded memory). Restarting the node resets the count
to what is connected again.

## Federation (F-S3, reputation signals added in F-S4)

Only registered when `FEDERATION_ENABLED=true` — with the default `false`,
none of these routes exist at all (404), exactly like today. All five
authenticate themselves rather than via `Authorization: Bearer` (see the base
path note above); see `server/docs/threat-model.md`'s "F-S3/F-S4
implementation notes" for what's built so far versus deliberately deferred
(confirm/deny replication isn't wired up yet).

### `POST /v1/federation/join`

A server introduces itself to another. Self-signed with the joining server's
own node key — per `docs/federation.md`, the network doesn't vouch for a
server's identity at join time, only for its behavior via reputation
afterward (F-S4, `GET /v1/network/directory` below). IP-rate-limited
(30/minute) — a fresh keypair is free to generate, so nothing else here is
expensive to spam.

```
Request:  SignedEnvelope<{ nodeId, publicKey, address: "https://...", requestedAt: "<ISO 8601>" }>
Response: { "self": { "nodeId", "publicKey", "federationEnabled" }, "peers": [NetworkPeer, ...] }
```

Rejected (400) if `nodeId !== keyId(publicKey)`, the signature doesn't verify
against `publicKey`, `requestedAt` is more than 5 minutes old, `address`
isn't an `https://` URL, or the caller is joining to itself. 403 if the
joining `nodeId` is in the signed network config's `excludedNodeIds`. On
success, the peer is upserted into this server's peer directory and the
current full peer list is returned — this is the entire gossip mechanism
(no separate gossip protocol): a peer list rides along with every join
response.

```
NetworkPeer: { "nodeId", "publicKey", "address", "discoveredVia": "seed"|"gossip"|"join", "joinedAt", "lastSeenAt",
                "successfulHealthChecks", "consecutiveHealthCheckFailures", "invalidSignatureCount", "lastKnownVersion" }
```

### `GET /v1/federation/peers`

Returns this server's current peer directory (same `NetworkPeer` shape as
above, plus the raw reputation counters — `successfulHealthChecks`,
`consecutiveHealthCheckFailures`, `invalidSignatureCount`,
`lastKnownVersion`). Not the reputation-*scored* view — for the computed
tier, use `GET /v1/network/directory` above; this is the raw "who this one
server currently knows how to reach" list its own workers operate on.

### `POST /v1/federation/heartbeat`

Signed with the sender's node key, verified against the **stored** public
key for that `nodeId` (unlike join, a heartbeat doesn't get to assert its own
identity) — the sender must already be a known peer.

```
Request:  SignedEnvelope<{ nodeId, address, version, capacityHint?, onlineCount?, timestamp }>
Response: { "acknowledged": true }
```

404 if `nodeId` isn't a known peer (join first). 400 if the signature doesn't
verify against the stored key, or `timestamp` is more than 5 minutes stale.
Updates the peer's `address` (a peer may move) and `lastSeenAt`.

`onlineCount` (add-on O-A, optional) is the sender's own head count of online
clients — see `GET /v1/stats/online`. A value that isn't a plausible head count
(negative, fractional, not a number, above 1 000 000) is ignored; it never
gets the heartbeat itself rejected.

### `POST /v1/federation/events`

Push: a peer forwards device-signed report-creation events. The **coarse**
admission check (sender must be a known, non-excluded peer) is anti-spam,
not what makes an event trustworthy — each event's own device signature is
(`docs/threat-model.md`'s "Trust signatures, not servers").

```
Request:  { "senderNodeId": "...", "events": [SignedEnvelope<DeviceCreateEvent>, ...],   (max 100 events)
            "speedLimitVotes"?: [SignedEnvelope<SpeedLimitVote>, ...] }                    (K-A, max 100; see below)
Response: { "results": [ { "federationEventId": "<sha256 hex>", "status": "created"|"merged"|"duplicate"|"rejected"|"recorded"|"ignored",
                            "reason"?: "...", "code"?: "invalid_signature"|"stale_timestamp"|"camera_out_of_scope"|"implausible"|"future_timestamp" } ] }

DeviceCreateEvent: { "kind": "create", "type": "<hazard type, not fixedSpeedCamera>",
                     "lat", "lng", "speedKmh"?, "devicePublicKey", "timestamp" }
```

403 if `senderNodeId` isn't a known, non-excluded peer — otherwise every
event in the batch is processed independently (one bad/forged event doesn't
fail the others). Per event: signature must verify against its own claimed
`devicePublicKey` (self-certifying — the receiving server never needs to
have known this device beforehand), `timestamp` must be within
`FEDERATION_EVENT_MAX_AGE_HOURS` (default 72h — deliberately much wider than
the 60s window used for auth assertions, since anti-entropy is explicitly
meant to catch a server up after being offline), and the report content
still passes ordinary plausibility checks. `federationEventId` = sha256 of
the envelope's own `(payload, signature)` — a cross-server-stable id
independent of any one server's local storage. Newly created/merged events
are published to this server's own WebSocket subscribers and best-effort
re-forwarded (gossiped) to its other known peers.

A rejection with `code: "invalid_signature"` is recorded against the
*sending* peer's reputation (F-S4) — the plan's "jede ungültige Signatur von
S ist ein starkes Negativsignal" — and demotes it to `probation` in
`GET /v1/network/directory` immediately, regardless of prior standing. The
other rejection codes are ordinary bad input, not evidence the peer is
misbehaving.

**Overload signal (F-S4):** once `FEDERATION_OVERLOAD_MAX_CONCURRENT_PUSHES`
pushes are being processed concurrently by this process, further calls get
`503` with a `Retry-After` header and `{ "error": { "code": "OVERLOADED", ... } }`
instead of being queued — a concurrency cap, not a per-sender rate limit (see
the separate 60/minute IP-based rate limit on this same route). This
server's own outbound heartbeats also carry a self-reported `capacityHint`
(0–1) reflecting the same gauge, so a well-behaved peer can back off before
it starts actually seeing 503s — but see `server/docs/threat-model.md` for
why that field is never trusted for reputation scoring on its own.

### `GET /v1/federation/events?after=<sequence>&limit=<n>`

Pull: anti-entropy catch-up. `after` is always a cursor *this specific
server* previously returned — never comparable across different peers (each
server's `sequence` is its own local, per-process counter).

```
Response: { "events": [ { "sequence", "federationEventId", "envelope": SignedEnvelope<DeviceCreateEvent>, "occurredAt" } ], "nextAfter": number|null }
```

`limit` defaults to 200, capped at 500. Open to any caller (like `GET
/v1/network/node-info`) — the data returned is exactly what's meant to be
broadcast across the whole network anyway, so there's nothing to gate on a
read.

### Speed-limit votes over federation (K-A)

Device-signed speed-limit votes (see "Speed-limit corrections") travel in two
ways, both kept apart from the report events so an older peer is never handed a
body it would reject:

* **Push:** the optional `speedLimitVotes` array of `POST /v1/federation/events`
  above. Per vote the result is `recorded`, `duplicate`, `rejected`
  (`invalid_signature` — recorded against the sender's reputation like a bad
  report signature — `future_timestamp` (more than 5 minutes ahead), or
  `implausible` (value outside this server's configured range/step)) or
  `ignored` (this server has `COMMUNITY_CORRECTIONS_ENABLED=false`; nothing
  stored). There is **no maximum age** for a vote: votes are durable state, so a
  late-joining server must be able to take all of them.
* **Pull:** `GET /v1/federation/speed-limit-votes?after=<seq>&limit=<n>` →
  `{ "votes": [ { "sequence", "voteId", "envelope": SignedEnvelope<SpeedLimitVote>, "receivedAt" } ], "nextAfter": number|null }`,
  the signed votes this server holds in its own insertion order (cursor per
  peer, never comparable across servers; `limit` default 200, max 500). Open
  like `/events`. **404** when this server has corrections switched off or
  predates the feature — the pulling peer skips that stream quietly and does
  *not* count it as a failed health check.

`voteId` = sha256 over the envelope's own `(payload, signature)`, the same
scheme as `federationEventId`. Unsigned (node-local) votes are never part of
either stream.

## Reads

All reads require a valid token; none require a specific scope beyond having
one.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/speed-limit?lat&lng` | Nearest segment within `SPEED_LIMIT_LOOKUP_MAX_DISTANCE_METERS`; 404 if none. Effective value, plus `correctedBy`/`importedSpeedLimit`/`correction` when it is a community correction — see "Speed-limit corrections" |
| GET | `/v1/speed-limit-segments/nearby?lat&lng&radiusM` | Same additive correction fields per segment |
| GET | `/v1/speed-limit-corrections?tiles\|segmentId&status&limit` | Open proposals and applied corrections — see "Speed-limit corrections" (absent when the feature is off) |
| GET | `/v1/static-signs/nearby?lat&lng&radiusM` | |
| GET | `/v1/hazard-reports/nearby?lat&lng&radiusM&types` | Never returns camera-adjacent types (see below) |
| GET | `/v1/hazard-reports/by-tile?tile&k&types` | `k` = ring radius (0–5) around `tile`, an H3 resolution-7 cell id |
| GET | `/v1/speed-cameras/nearby?lat&lng&radiusM&types` | Empty unless `SPEED_CAMERA_NAMESPACE_ENABLED`. Persistent devices of every kind plus the expiring camera reports — see "Persistent enforcement devices" |
| GET | `/v1/speed-cameras/by-tile?tile&k&types` | Expiring camera reports, plus persistent red-light and distance devices; never speed cameras (globally synced, not tiled) |
| GET | `/v1/snapshot?tiles&types&staticData` | See "Sync" below |
| GET | `/v1/delta?since&tiles&types&limit` | See "Sync" below |
| GET | `/v1/config` | See "Client config" below |
| GET | `/v1/static-data/manifest` | See "Static data packages" below |
| GET | `/v1/static-data/partitions/:tile` | See "Static data packages" below |

`radiusM` is capped at 50,000 (50 km). `types` is a comma-separated list of
hazard types; unsupported/disallowed values are dropped rather than rejected.

### Hazard types

```
traffic, ice, accident, construction, breakdown, obstacle,
fixedSpeedCamera, mobileSpeedCamera, trailerCamera, redLightCamera, distanceControl
```

The last five are the speed-camera namespace. `/v1/hazard-reports/*` always
excludes all five, regardless of the namespace flag — they only ever surface
through `/v1/speed-cameras/*`. `fixedSpeedCamera` never appears in a
hazard-report response at all; it lives in its own table (see `schema.md`).

## Writes

### `POST /v1/hazard-reports`

```
Request:  { "type": "<hazard type>", "lat": number, "lng": number, "speedKmh"?: number,
             "deviceAssertion"?: SignedEnvelope<DeviceCreateEvent> }
Response: { "report": {...}, "merged": boolean }   — 201 if new, 200 if merged
```

`deviceAssertion` is optional (F-S3) — see "Federation" above for the
`DeviceCreateEvent` shape. When a client's device has bound a key (`POST
/v1/devices/bind-key`), including it lets the device sign the report content
itself, not just prove which client is authenticated — this is what makes
the resulting event eligible for federation replication to other servers
(`docs/threat-model.md`: "Trust signatures, not servers"). Its `type`/`lat`/
`lng`/`speedKmh` must exactly match the request body (400 otherwise — a
device can't sign one thing and submit another), the signature must verify
against its own claimed `devicePublicKey`, and `timestamp` must be within 60
seconds. Resubmitting the identical signed assertion returns 409
`DUPLICATE_FEDERATION_EVENT` rather than creating a second report. Reports
submitted **without** it are stored and served exactly as before this
milestone — just never propagated to other servers. Not available for
`type: "fixedSpeedCamera"` (routed to the camera flow before this is even
checked — see `server/docs/threat-model.md`'s F-S3 notes for why camera
federation is out of scope this milestone).

Runs the moderation gate (docs/concept.md section 5.4):

1. **Plausibility** — rejects `(0,0)`, rejects `speedKmh` on a type that
   doesn't take one (only `mobileSpeedCamera`/`trailerCamera` do), enforces
   `SPEED_KMH_MIN`/`MAX`.
2. **Rate limit** — `REPORT_RATE_LIMIT_MAX` submissions (creates +
   confirmations combined) per `REPORT_RATE_LIMIT_WINDOW_MINUTES`, per
   reporter.
3. **Duplicate-merge** — if an active report of the same type already exists
   within `DUPLICATE_MERGE_RADIUS_METERS`, this call becomes a confirmation
   of it instead of a new report (`merged: true`), extending its `expiresAt`.

`type: "fixedSpeedCamera"` is intercepted before any of this and routed to
the fixed-camera flow instead — response is `{ "camera": {...}, "merged": boolean }`.
Writes to the camera namespace are **never** gated by
`SPEED_CAMERA_NAMESPACE_ENABLED` — only reads are.

### `POST /v1/hazard-reports/:id/confirmations`

```
Request:  { "kind": "stillThere" | "gone" }
Response: { "report": {...}, "recorded": boolean }
```

One vote per reporter per report — a second call with the same or a
different `kind` is a no-op (`recorded: false`) rather than an error.
`stillThere` extends `expiresAt`; `gone` does not. There is no automatic
`active → removed` transition from accumulated `gone` votes on ordinary
hazard reports (unlike fixed cameras, below) — they only ever leave `active`
via expiry.

### `POST /v1/speed-cameras/:id/removal-reports`

```
Response: { "camera": {...}, "recorded": boolean, "removed": boolean }
```

One "this camera is gone" vote per reporter. Once distinct votes reach
`CAMERA_REMOVAL_THRESHOLD`, the camera is marked `removed` and disappears
from reads. Works regardless of the namespace flag, and for every kind of
persistent device (the id is what counts — see the next section).

## Persistent enforcement devices (add-on D)

`fixed_speed_cameras` holds every **permanently installed** enforcement device, not only
speed cameras: `cameraType` is one of `fixedSpeedCamera`, `redLightCamera`, `distanceControl`
(the list a server knows is `persistentCameraTypes` in `GET /v1/config`; a server that predates
the feature has no such key). Such a device never expires and leaves only through removal
reports (above). Mobile and trailer cameras, and — by default — user reports of red-light and
distance controls, stay what they were: **expiring** hazard reports. Design and reasons:
[`persistent-enforcement-devices.md`](persistent-enforcement-devices.md). Everything here is
gated by `SPEED_CAMERA_NAMESPACE_ENABLED` exactly like the speed cameras: flag off → no device
of any kind in any read, snapshot, delta or package; writes and imports still work.

**Device item** (in `nearby`, `by-tile`, the snapshot, the packages and event payloads):

```
{ "id", "type", "cameraType", "position", "status": "active"|"removed", "removedAt", "source",
  "sourceLicense", "importedAt", "lastConfirmedAt", "removalReportCount" }
```

`type` equals `cameraType` and is always one of the hazard types above, so a client that decodes
`type` into the hazard enum handles every device. The item has no `expiresAt` — that is how a
persistent device is told apart from an expiring report of the same `type` in one list.
**New field:** `cameraType`; every other field is unchanged, and every row that existed before
the feature is `fixedSpeedCamera`.

**`GET /v1/speed-cameras/nearby`** — without `types`: every persistent device within the radius
plus the expiring camera reports. `types` filters as before and now also selects persistent devices:
`types=fixedSpeedCamera` returns speed cameras only; `types=redLightCamera` returns the persistent
red-light devices **and** the expiring red-light reports (each item says which it is, see above);
`types=mobileSpeedCamera` never returns a persistent device.

**`GET /v1/speed-cameras/by-tile`** — as before for the expiring camera reports; additionally the
persistent devices of the kinds `redLightCamera` and `distanceControl` whose position lies in the
requested tiles (persistent devices have no region tile of their own; they are found through the
tiles' bounding boxes and an exact H3 check). Speed cameras are still not returned here — they are
globally synced, never tiled.

**Snapshot** — `fixedSpeedCameras` keeps its meaning (speed cameras only). New `enforcementDevices`:
**every** persistent device, speed cameras included, each with `cameraType`. Same gating and the same
`?staticData=false` rule as `fixedSpeedCameras`.

**Events** — a change to a persistent device is `StaticDataUpdated` / `StaticDataRemoved` with
`entityType: "fixedSpeedCamera"` for a speed camera (exactly as before) and
**`entityType: "enforcementDevice"`** for the other kinds (new value; a client that does not know an
entity type must skip the event — the client library does). The payload is the device item. In
`/v1/delta` the `types` filter matches the payload's `type` for both entity types.

**Bulk import** — `POST /v1/bulk-import/speed-cameras` rows take an optional `cameraType`
(`fixedSpeedCamera` by default; an unknown value is a 400). A call without the field behaves exactly
as before. Import red-light and distance devices only against a server that has this feature: an older
server ignores the unknown field and stores them as speed cameras.

**Community reports** — `POST /v1/hazard-reports` with `type: "fixedSpeedCamera"` still creates or
confirms a speed camera; it merges only into another *speed camera* within
`DUPLICATE_MERGE_RADIUS_METERS`, never into a red-light or distance device at the same junction.

**Packages** — see "Static data packages": `enforcementDevices` appears in a tile's package only when
the tile has a persistent device.

**Federation** — persistent devices are node-local static data, like speed cameras (never replicated;
`federation-protocol.md` §7). A device-signed `redLightCamera` report federates as an ordinary expiring report.

## Speed-limit corrections (add-on K-A)

Users can report a wrong speed limit and propose the right value. A proposal
is an **overlay**: the imported row is never changed. It becomes effective only
when enough *distinct devices* agree (`COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED`,
default **3**; a denial counts against it), and it is served with its origin.
The reasoning behind every rule is in
[`speed-limit-corrections.md`](speed-limit-corrections.md); this section is the
wire contract. With `COMMUNITY_CORRECTIONS_ENABLED=false` **none of these
endpoints exist** (404) and every read returns the imported value — clients
learn that from `GET /v1/config` → `communityCorrections.enabled`.

### How a correction shows up in the existing reads

Every place that returns a speed-limit segment (`/v1/speed-limit-segments/nearby`,
`/v1/snapshot`, the static-data partitions, the `StaticDataUpdated` delta
events) — and the lookup `GET /v1/speed-limit` — is **additive**: all existing
fields keep their meaning, and `speedLimit` is the *effective* value, so a
client that changes nothing already shows corrected limits.

```
{ "id", "geometry", "speedLimit": 50, "speedLimitUnit": "kmh", "source", "sourceLicense", "importedAt", "lastConfirmedAt",
  "segmentKey": "<32 hex>",                       // always: cross-server-stable identity, what a signed vote references
  // only when speedLimit is a community correction (absent otherwise):
  "correctedBy": "community",
  "importedSpeedLimit": 30,                       // the value from the import source
  "correction": { "id": "<uuid>", "confirmations": 3, "denials": 0,
                  "appliedAt": "2026-09-24T12:00:00.000Z", "needsReview": false } }
```

`needsReview: true` means the import changed to a third value after the
correction was proposed — the correction is still served (an import never
silently overwrites it), but the operator or the community should re-check
([`speed-limit-corrections.md`](speed-limit-corrections.md) D7). Counts inside a
static package are "as of the last change of the effective value"; the live
numbers come from the endpoints below. `GET /v1/speed-limit` returns the same
additive fields next to `segmentId` and `segmentKey`.

### `POST /v1/speed-limit-segments/:id/corrections`

Propose a value (or confirm someone else's identical one — same value merges).
`:id` is the segment's `id` (UUID).

```
Request:  { "value": 50, "unit": "kmh", "reason"?: "wrong_value"|"limit_lifted"|"sign_missing_or_new"|"other",
            "deviceAssertion"?: SignedEnvelope<SpeedLimitVote> }
Response: { "correction": Correction, "recorded": boolean, "merged": boolean, "segment": <segment as above, without geometry> }
          201 = a new correction record, 200 = merged into an existing one / no-op
```

* `unit` must equal the segment's own unit (a correction never converts) and
  `value` must be a whole number in the configured range for that unit and a
  multiple of the step (defaults: 5–150 km/h, 5–85 mph, step 5) and differ from
  the imported value. Otherwise **422** with a machine-readable `error.code`:
  `CORRECTION_VALUE_OUT_OF_RANGE`, `CORRECTION_VALUE_NOT_ON_STEP`
  (both with `details: { unit, min, max, step }`), `CORRECTION_UNIT_MISMATCH`
  (`details: { segmentUnit }`), `CORRECTION_NO_CHANGE`.
* A caller supports **one value per segment**: proposing another value withdraws
  the earlier one. Repeating the same proposal is a no-op (`recorded: false`,
  not counted against the rate limit).
* `recorded: false` means nothing was stored (already holds that stance).
* `429` when the calling client exceeded `COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX`
  proposals/confirmations/denials in `COMMUNITY_CORRECTIONS_RATE_LIMIT_WINDOW_MINUTES`
  (default 5 per 60 min — stricter than reports).
* `403` `FORBIDDEN` if the reporter was barred by the operator.
* `404` unknown segment, `400` malformed id/body.

**Device signature** (optional, exactly like a hazard report's): a client that
has bound a device key (`POST /v1/devices/bind-key`) sends the same vote as a
signed envelope. The server checks that the payload matches the request, that
the signature verifies, that the timestamp is within 60 s — and that the key is
**the one bound to the calling client** (`403 DEVICE_KEY_NOT_BOUND` otherwise;
otherwise one client could mint unlimited "distinct devices"). A signed vote
is replicated to peers; an unsigned one counts on this server only.

```
SpeedLimitVote (the envelope payload):
  { "kind": "speedLimitVote", "vote": "support"|"deny", "segmentKey": "<32 hex, from the segment>",
    "value": 50, "unit": "kmh"|"mph", "reason"?: "...", "devicePublicKey": "<raw base64url>", "timestamp": "<ISO>" }
```

### `POST /v1/speed-limit-corrections/:id/confirmations`

Confirm ("stimmt") or object ("stimmt nicht") to an existing correction; `:id`
is the correction's `id` (deterministic: the same on every server).

```
Request:  { "kind": "confirm" | "deny", "deviceAssertion"?: SignedEnvelope<SpeedLimitVote> }   (vote = "support" | "deny")
Response: same as above
```

A denial counts against the value; **an applied correction whose net
confirmations (supporters − deniers) fall below the threshold stops being
applied** and the imported value is served again — announced through the
event log like any other change. A device can change its mind by voting again.
`404` if the correction is unknown or this server has no segment for it (it was
proposed on a server with other data).

### `GET /v1/speed-limit-corrections?tiles=<H3 cells>|segmentId=<uuid>&status=<list>&limit=<n>`

Discovery of open proposals (so a client can ask a driver "still true?") and
applied corrections. One of `tiles` (comma-separated H3 cell ids, any
resolution, max 100 — the spatial filter is the union of those cells) or
`segmentId` is required. `status` is a comma-separated subset of
`proposed, applied, superseded, reverted` (default `proposed,applied`);
`limit` defaults to 200, max 1000.

```
Response: { "corrections": [ Correction ] }

Correction: { "id", "segmentKey", "segmentId": "<first local row>"|null, "value", "unit",
              "status": "proposed"|"applied"|"superseded"|"reverted", "reason": "..."|null,
              "confirmations", "denials", "firstProposedAt", "lastVoteAt", "appliedAt"|null,
              "importedSpeedLimit": <the local segment's imported value>|null, "needsReview": boolean,
              "source": "community", "geometry"?: <GeoJSON, only with ?tiles> }
```

`GET /v1/speed-limit-segments/:id/corrections[?status=]` returns
`{ "segment": <summary>, "corrections": [Correction] }` for one segment.

Corrections carry a pseudonymous reporter internally (`device:<key id>`), which
is **never** part of any response.

## Sync (snapshot / delta)

Local-first devices bootstrap from a snapshot, then poll delta using the
snapshot's `snapshotSequence` as a starting point.

### `GET /v1/snapshot?tiles=<comma-separated H3 ids>&types=<comma-separated>`

**Size guard (add-on E-B):** a snapshot with static data reads every static row
into memory (about 2.5 KB of process memory per row, measured). When the server
holds more than `SNAPSHOT_STATIC_MAX_ROWS` (default 1,000,000; `0` disables) it
answers `413 STATIC_DATA_TOO_LARGE_FOR_SNAPSHOT` instead, pointing at
`/v1/snapshot?staticData=false` and the manifest/packages. The check uses the
planner's row estimate, so it costs nothing.

```json
{
  "snapshotSequence": 1234,
  "speedLimitSegments": [...],
  "staticSigns": [...],
  "hazardReports": [...],
  "fixedSpeedCameras": [...],
  "enforcementDevices": [...]
}
```

- `speedLimitSegments` / `staticSigns` are always returned **in full** — they
  sync globally regardless of `tiles` (docs/concept.md section 3.3).
- `fixedSpeedCameras` likewise, but only populated when
  `SPEED_CAMERA_NAMESPACE_ENABLED` — empty array otherwise. Speed cameras only,
  as it has always meant.
- `enforcementDevices` (add-on D): every persistent device, speed cameras included,
  each with `cameraType` — see "Persistent enforcement devices". Same gating.
- `hazardReports` is only populated when `tiles` is given (omitting `tiles`
  means "static data only"), filtered by exact tile membership — the client
  is expected to have already expanded its own k-ring via the same H3
  resolution used server-side (7).
- Generated inside a single `REPEATABLE READ` transaction, so
  `snapshotSequence` and the returned rows are always mutually consistent —
  no event landing between the two reads can be silently missing from both.
- `staticData=false` omits `speedLimitSegments`/`staticSigns`/
  `fixedSpeedCameras`/`enforcementDevices` entirely (client-lib P2.0) — for a client that already
  has the static dataset via the partition/manifest endpoints below and only
  wants `snapshotSequence` plus tile-filtered hazard reports.

### `GET /v1/delta?since=<sequence>&tiles&types&limit`

```json
{ "events": [...], "nextSince": 1240, "hasMore": false }
```

- `since=0` means "everything currently retained."
- Paginate by calling again with `since=<nextSince>` while `hasMore` is true.
- `limit` defaults to 500, capped at 5000.
- Returns **409 `SNAPSHOT_REQUIRED`** if `since` predates what the retention
  window (`EVENT_LOG_RETENTION_DAYS_DYNAMIC`/`_STATIC`) still has on record —
  the client must fall back to a fresh `/v1/snapshot` instead of trying to
  replay a gap that no longer exists in the log.
- Static-entity events (`speedLimitSegment`/`staticSign` updates) always pass
  through regardless of `types` — that filter only ever restricts
  hazard/camera-type events, matched against each event's payload.

## Static data packages (client-lib P2.0, pre-built and cacheable since add-on E-B)

Partitioned, versioned alternative to fetching all static data through
`/v1/snapshot` in one response — for large datasets, lets a client download
only the partitions covering the regions it cares about, and re-download only
what actually changed. The packages are **pre-built files on disk**
(`STATIC_PACKAGES_DIR`), rebuilt in the background after static data changes, so
a request never computes anything and a reverse proxy or CDN can serve them.
Design, measurements and sizing: [`europe-scale.md`](europe-scale.md).

### `GET /v1/static-data/manifest[?since=<version>]`

```json
{
  "staticDataVersion": 7,
  "partitionResolution": 4,
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "partitions": [
    { "tile": "<h3 id>", "hash": "<sha256 hex of the uncompressed JSON>", "sizeBytes": 1234,
      "gzipBytes": 300, "brotliBytes": 290, "path": "/v1/static-data/packages/<tile>/<hash>" }
  ]
}
```

`tile`, `hash`, `sizeBytes` are what this endpoint has always returned;
`gzipBytes`, `brotliBytes` (what a compressed download costs) and `path` (the
immutable location of exactly this content) are additive.

Partitions are keyed by an H3 cell at `partitionResolution` — **4 by default**
(`STATIC_DATA_PARTITION_H3_RESOLUTION`; ≈ 1,770 km² per tile, packages of a few MB at
Europe density; it was 2 before the Europe add-on, whose tiles were hundreds of MB), computed
from each entity's geometry, not stored. **Every node of a network must use the same
resolution** — tile ids and packages of different resolutions are incompatible and a client would
download everything twice. The value is in every manifest (`partitionResolution`) and in
`GET /v1/config` (`staticDataPartitionH3Resolution`): **a client compares it with the resolution of
the packages it holds and, if it differs, discards them and downloads again instead of merging** (a
tile id at resolution 2 never equals one at resolution 4). Changing the resolution of a running node
therefore forces a full re-bootstrap on every device — decide it once. It was fixed at 4 on
2026-09-25, while there are no real users. Only partitions that actually contain data are listed; a `LineString`
segment that straddles a partition boundary is listed (and returned) under every
partition one of its vertices falls into. The `hash` is stable: rebuilding
unchanged data yields the same hash (rows are ordered by id), so comparing hashes
tells a client exactly what to re-download.

`staticDataVersion` is the static-data version the listed packages correspond
to; it bumps on every `StaticDataUpdated`/`StaticDataRemoved` event and on
every successful bulk import.

* **`?since=<version>`** — only the partitions built after that version, plus
  `"removed": ["<tile>", …]` for tiles that no longer have data (drop them) and
  `"since"`. A client that already holds version *V* asks for `?since=V`
  instead of downloading a manifest that lists every tile of Europe.
* **Caching:** `ETag` (revalidate with `If-None-Match` → `304`), gzip when the
  client accepts it, `Cache-Control: private, no-cache`.
* **503 `PACKAGES_BUILDING`** (+ `Retry-After: 30`): the packages of a large
  dataset have not been built yet (first start after an import, or after
  changing a setting that shapes them). Datasets up to
  `STATIC_PACKAGES_INLINE_BUILD_MAX_ROWS` (200,000) are built by the first
  request instead, as before. Once a complete set exists it keeps being served
  while newer writes wait for the next background build.

### `GET /v1/static-data/partitions/:tile`

```json
{ "tile": "<h3 id>", "speedLimitSegments": [...], "staticSigns": [...], "fixedSpeedCameras": [...],
  "enforcementDevices": [...] }
```

`fixedSpeedCameras` holds the speed cameras of the tile, as it always has. **`enforcementDevices`**
(add-on D) holds every persistent device of the tile — speed cameras included — each with `cameraType`; the
key is **omitted when the tile has none**, so a tile without devices keeps exactly the bytes, and therefore
the hash, it had before the key existed (no re-download). Both arrays are empty/absent while the camera
namespace flag is off. A client ignoring unknown keys needs no change; a client that wants the new kinds reads
`enforcementDevices` (absent = none).

404 if `tile` has no data. Streamed from the pre-built file; the content and
`hash` are what they have always been. `Accept-Encoding: br` / `gzip` gets the
stored compressed file (the `Content-Encoding` says which; a client that accepts
neither gets the JSON decompressed on the fly). Each representation has its own
strong `ETag` (`"<hash>-br"`, `"<hash>-gzip"`, `"<hash>"`), `If-None-Match`
answers `304`, and `Vary: Accept-Encoding` is set. **`Range: bytes=…`** (single
range, also `a-` and `-n`, with `If-Range`) resumes an interrupted download of a
compressed representation → `206` + `Content-Range`, `416` when unsatisfiable;
the plain-JSON response is produced on the fly and ignores `Range`. `503
PACKAGE_MISSING` (+ `Retry-After`) if the file is gone from disk — the tile is
queued for rebuild.

### `GET /v1/static-data/packages/:tile/:hash`

The same bytes, at a **content-addressed** URL (the `path` from the manifest):
`Cache-Control: private, max-age=31536000, immutable` — a hash names exactly one
content, so it never has to be revalidated. Same encodings, `ETag`s and `Range`
handling as above. `404` if that content is no longer stored (a replaced file is
kept for `STATIC_PACKAGES_KEEP_MINUTES`, default two hours, for downloads that
are already running) — fetch the manifest again. With `STATIC_PACKAGES_PUBLIC=true`
(off by default) **this route alone needs no `Authorization` header** and is
`public`, so a reverse proxy or CDN can cache and serve it; everything else,
including the manifest, still requires a credential.

## Client config

### `GET /v1/config`

Curated subset of server tunables a client-lib instance mirrors locally
(expiry rules, tiling resolution, camera-namespace flag, moderation limits) so
client and server never diverge — normal auth like any other read, no
dedicated scope. See `modules/config/routes.ts` for the exact field list;
every value here also exists as an env var documented in `.env.example`.

**F-S2 additions:** `federationEnabled` mirrors `FEDERATION_ENABLED`.
`networkConfig` is the full [`SignedEnvelope`](#signedenvelope)`<NetworkConfigPayload>`
(not just its values) when `NETWORK_CONFIG_PATH` is configured, `null`
otherwise — so a client can independently re-verify it against the network
root public key it already trusts, rather than taking this server's word for
`speedCameraNamespaceEnabled` above (which already reflects the network
config's value if one is loaded — see "Signed network configuration" below).

**D addition:** `persistentCameraTypes` — the kinds of permanent enforcement device this server
knows (`["fixedSpeedCamera","redLightCamera","distanceControl"]`); see "Persistent enforcement
devices". An older server lacks the key — that is the version hint: treat "absent" as "speed cameras only".

**K-A addition:** `communityCorrections` — `{ enabled, confirmationsRequired,
valueRange: { kmh: {min,max}, mph: {min,max} }, valueStep, rateLimit: { max,
windowMinutes } }`. A client hides the whole correction feature when `enabled`
is false (the endpoints don't exist then) and mirrors the range/step so it can
reject implausible input before sending; an older server simply lacks the key
(treat "absent" as "not offered").

### Signed network configuration (F-S2)

Set `NETWORK_CONFIG_PATH` to a file produced by `npm run network:sign-config`
(see `server/README.md`'s "Network keys & signed config" section) and
`NETWORK_ROOT_PUBLIC_KEY` to the matching root public key, and this server
verifies and applies it at startup — **refusing to start** if the file is
missing, unreadable, or doesn't verify (fail loudly rather than silently run
on an unauthenticated config; `server/docs/threat-model.md`). With neither
set (the default), a server just uses its own local env config exactly as
before this milestone.

The **camera-namespace flag is AND-gated, never OR-gated**: a signed config's
`blitzerEnabled: false` can turn off a server's own locally-enabled flag, but
`blitzerEnabled: true` can never turn on a server's own locally-disabled one.
The network can restrict, never grant — per
`docs/prompt-rework-server-federation.md`'s binding decision "ein lokales
Env-Flag darf die Netzwerkvorgabe nicht aufheben."

## Bulk import

Requires the `bulk-import` scope. A normal, publicly documented API surface
with an elevated permission level — not a special access path reserved for
one particular ingestion program (docs/concept.md section 7). Any client
holding this scope may call these.

| Method | Path |
|---|---|
| POST | `/v1/bulk-import/speed-limit-segments` |
| POST | `/v1/bulk-import/static-signs` |
| POST | `/v1/bulk-import/speed-cameras` (persistent devices; `cameraType` optional, default speed camera) |

```json
{ "rows": [ { "...": "entity-specific fields, see below" } ] }
```

Response: `{ "inserted": <count> }`. Capped at `BULK_IMPORT_MAX_ROWS` rows per call
(default 5000). One batched statement per call, and the partition tiles the rows
touch are marked for a package rebuild in the same transaction (which also bumps
`staticDataVersion`).

**Bulk-imported rows do not append event-log entries** (deliberate — a
single call inserting thousands of rows would otherwise dominate the log's
size and drown out everything else during that retention window). Clients
only see bulk-imported static data via their **next snapshot** (small servers) or
the **package manifest** (`/v1/static-data/manifest`, the way at Europe scale), not via
delta. This is fine for static data, and consistent with bulk-import being
an infrequent, largely one-time operation rather than a steady stream.

Row shapes:

```jsonc
// speed-limit-segments
{ "lineString": [[lng, lat], [lng, lat], ...], "speedLimit": 50, "speedLimitUnit": "kmh",
  "source": "osm", "sourceLicense": "ODbL", "importedAt": "2026-01-01T00:00:00Z" /* optional, defaults to now */ }

// static-signs
{ "lat": 52.5, "lng": 13.4, "signType": "DE:274", "source": "osm", "sourceLicense": "ODbL" }

// speed-cameras (persistent devices; cameraType optional: fixedSpeedCamera | redLightCamera | distanceControl, default fixedSpeedCamera)
{ "lat": 52.5, "lng": 13.4, "cameraType": "redLightCamera", "source": "osm", "sourceLicense": "ODbL" }
```

### Seed reports (roadworks): `POST /v1/bulk-import/seed-reports` and `.../retire`

For authoritative, **time-limited** reports that a periodic import keeps in step with its source — today roadworks
from national access points. They are ordinary `hazard_reports` rows (`type: "construction"`, `source: "seed"`), so
clients read them through the normal hazard endpoints, snapshot and delta. Unlike the three static-entity endpoints above,
seed reports **do** append event-log entries (they are dynamic data), but only for real changes.

```jsonc
// POST /v1/bulk-import/seed-reports  — upsert one batch (1..5000 reports) of a feed
{
  "feedId": "de-autobahn",            // lowercase [a-z0-9._-], ≤64: which import feed
  "runId": "8f0c3a…",                 // any id, new per import run (see retire)
  "sourceLicense": "Licence Ouverte 2.0", // mandatory provenance, ≤200
  "reports": [
    { "externalId": "2023-001923--vi-bs.…", // the feed's own id, ≤200 — with feedId the row's identity
      "type": "construction",               // only value for now
      "lat": 48.8718, "lng": 11.4677,
      "endsAt": "2026-12-31T06:00:00+01:00", // optional, offset required. The report expires then.
      "ttlHours": 168 }                       // optional (1..2160): lifetime when there is no endsAt; default = HAZARD_EXPIRY_CONSTRUCTION_DAYS
  ]
}
// → 200 { "created": n, "reactivated": n, "updated": n, "refreshed": n, "skippedEnded": n, "duplicatesInRequest": n }
```

* **Idempotent.** Re-sending a batch changes nothing. A report is identified by `(feedId, externalId)`; the last occurrence within one request wins.
* **Events only for real changes:** new or re-activated → `ReportCreated`; moved by more than 100 m or a changed source end date (> 1 min) → `ReportConfirmed` carrying the new full state; a plain re-sighting is silent, so an hourly import of thousands of unchanged roadworks does not flood the log or the WebSocket subscribers. Events have `source: "seed"`.
* **Expiry:** the source's `endsAt` when given (a report whose end is already past is not created — `skippedEnded`). Without it the report lives `ttlHours` and is **renewed on every sighting** — if the importer stops for good, the rows age out by themselves.
* **Not a community submission:** no moderation gate, no per-device rate limit, no confirm/deny bookkeeping. A community report near a seeded one still merges into it as a confirmation (`DUPLICATE_MERGE_RADIUS_METERS`). Seed events are **not federated** (no device signature); like static data, each node imports its own.

```jsonc
// POST /v1/bulk-import/seed-reports/retire — after a run that fetched the COMPLETE feed
{ "feedId": "de-autobahn", "runId": "8f0c3a…" }
// → 200 { "retired": n }   — active reports of that feed that this run did not re-send are over:
//   status "expired" + a ReportExpired event (exactly what the expiry worker does)
// → 409 SEED_RUN_EMPTY     — the run wrote no report of this feed: an empty or failed fetch must not wipe a feed
```

Provenance columns on the row: `source_feed`, `external_id`, `last_seen_run` (see schema.md).

## Real-time push (WebSocket)

`GET /v1/ws` (upgrade). Auth is a message, not a query-string token (query
strings end up in access logs/proxies).

```
→ { "type": "auth", "token": "<jwt>" }              (must be the first message)
← { "type": "auth_ok" }                              or { "type": "error", "message": "Invalid token" } + close(4001)

→ { "type": "subscribe",   "tile": "<h3 id>", "k"?: 0-5 }
→ { "type": "unsubscribe", "tile": "<h3 id>", "k"?: 0-5 }

← { "type": "event", "event": { "sequence": ..., "type": "ReportCreated", "entityType": "hazardReport",
                                 "entityId": "...", "payload": {...}, "regionTile": "...", "source": "..." } }
```

A connection that sends no valid `auth` message within 10 seconds is closed.
Subscribing to a tile with `k > 0` registers the connection under every tile
in that H3 k-ring — the same `gridDisk` expansion used by the REST `by-tile`
endpoints — so REST and WebSocket share identical "nearby tiles" semantics.
Events with no `regionTile` (static-data updates) are pushed to every
authenticated connection, not just subscribed ones.

An authenticated connection also counts its client as online in
`GET /v1/stats/online` for as long as it stays open — clients need to send
nothing extra for that.

This is single-instance in Phase 1 — the subscription registry lives in
process memory. Horizontal scaling would need it backed by something shared
across instances (e.g. Postgres `LISTEN`/`NOTIFY`); explicitly out of scope
here.

Events of the speed-camera namespace (fixed/mobile/trailer/red-light/distance
cameras) are pushed only while the node's effective camera flag is on — the
same rule the REST reads apply. Connections of web sessions (below) receive
events without `reporterId`, and may hold at most
`WEB_WS_MAX_TILES_PER_CONNECTION` tile subscriptions.

## Web sessions (built-in web UI)

Only registered when `WEB_UI_ENABLED=true`; see [`web-ui.md`](web-ui.md).

### `POST /v1/web/session`

Public. Returns an anonymous, short-lived token for the node's own web page — no
credential, no database row, nothing linking two sessions.

```
Response: { "accessToken": "<jwt>", "tokenType": "Bearer", "expiresIn": 900, "scopes": ["client"] }
```

The JWT's `sub` is `web:<random>` (real client ids are `client_<hex>`). Requests
that a browser labels as coming from another site (`Sec-Fetch-Site` other than
`same-origin`/`none`) are refused with 403; the endpoint is IP-rate-limited
(`WEB_SESSION_MINT_LIMIT_PER_MINUTE`). Clients that send no such header (curl,
scripts) can call it too and are held to the same guard and limits below.

### What a web session may call

A token with a `web:` subject is checked against a **default-deny allowlist** before
the route runs; everything not listed answers `403 WEB_SESSION_FORBIDDEN`:

| Endpoint | Conditions |
|---|---|
| `GET /v1/config`, `/v1/speed-limit`, `/v1/hazard-reports/by-tile`, `/v1/speed-cameras/nearby`, `/v1/speed-cameras/by-tile` | read limit per IP |
| `GET /v1/hazard-reports/nearby` | `radiusM` ≤ `WEB_MAX_HAZARD_RADIUS_M` (else `400 WEB_RADIUS_TOO_LARGE`) |
| `GET /v1/speed-limit-segments/nearby` | `radiusM` ≤ `WEB_MAX_SEGMENT_RADIUS_M`; additionally limited by `WEB_HEAVY_READ_LIMIT_PER_IP_PER_MINUTE` |
| `POST /v1/hazard-reports` | no `deviceAssertion` (`403 WEB_NO_DEVICE_SIGNATURE`; web reports never federate); camera categories only when the node enables them (`403 WEB_TYPE_NOT_ALLOWED`) |
| `POST /v1/hazard-reports/:id/confirmations` | — |
| `GET /v1/speed-limit-corrections`, `GET /v1/speed-limit-segments/:id/corrections` | read limit per IP. Only meaningful on a node with the community-corrections add-on (K-A); elsewhere the route answers 404 |
| `POST /v1/speed-limit-segments/:id/corrections`, `POST /v1/speed-limit-corrections/:id/confirmations` | no `deviceAssertion` (`403 WEB_NO_DEVICE_SIGNATURE`): a web vote is unsigned and counts **on this node only**; counted like other web writes (see below) |

Writes count against the session (`WEB_REPORT_LIMIT_PER_SESSION`), the client IP
(`WEB_REPORT_LIMIT_PER_IP_PER_HOUR`) and the node (`WEB_REPORT_LIMIT_NODE_PER_HOUR`), on
top of the ordinary moderation gate. A refused request answers `429 WEB_RATE_LIMITED`
with `Retry-After` and `details: { scope: "session" | "network" | "node" | …, retryAfterSeconds }`.
Responses to web sessions never contain `reporterId`.

## Environment / configuration

See [`../.env.example`](../.env.example) for the full list with defaults —
every tunable (rate limits, merge radius, expiry durations, retention
windows, JWT TTL, camera removal threshold) is an environment variable, never
a hardcoded constant in the route/service code.
