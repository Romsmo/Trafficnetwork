# Server API (Phase 1)

Base path: `/v1`. All responses are JSON. All routes require authentication
(`Authorization: Bearer <token>`) except `GET /v1/health`, `POST /v1/auth/token`,
`POST /v1/auth/device-token`, `GET /v1/network/node-info`, the `/v1/federation/*`
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
the multi-server directory (`GET /v1/network/nodes`, planned for F-S4).

```json
{ "nodeId": "<16 hex chars>", "publicKey": "<base64url Ed25519>", "federationEnabled": false }
```

`nodeId`/`publicKey` are generated once on first boot and persisted (see
`server/docs/schema.md`'s `node_identity` table) — stable for the life of
this server's database.

## Federation (F-S3)

Only registered when `FEDERATION_ENABLED=true` — with the default `false`,
none of these routes exist at all (404), exactly like today. All five
authenticate themselves rather than via `Authorization: Bearer` (see the base
path note above); see `server/docs/threat-model.md`'s "F-S3 implementation
notes" for what's built so far versus deliberately deferred (confirm/deny
replication isn't wired up yet).

### `POST /v1/federation/join`

A server introduces itself to another. Self-signed with the joining server's
own node key — per `docs/federation.md`, the network doesn't vouch for a
server's identity at join time, only (later, F-S4) for its behavior via
reputation.

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
NetworkPeer: { "nodeId", "publicKey", "address", "discoveredVia": "seed"|"gossip"|"join", "joinedAt", "lastSeenAt" }
```

### `GET /v1/federation/peers`

Returns this server's current peer directory (same `NetworkPeer` shape as
above). Not the reputation-scored, network-wide directory planned for F-S4 —
just "who this one server currently knows how to reach."

### `POST /v1/federation/heartbeat`

Signed with the sender's node key, verified against the **stored** public
key for that `nodeId` (unlike join, a heartbeat doesn't get to assert its own
identity) — the sender must already be a known peer.

```
Request:  SignedEnvelope<{ nodeId, address, version, capacityHint?, timestamp }>
Response: { "acknowledged": true }
```

404 if `nodeId` isn't a known peer (join first). 400 if the signature doesn't
verify against the stored key, or `timestamp` is more than 5 minutes stale.
Updates the peer's `address` (a peer may move) and `lastSeenAt`.

### `POST /v1/federation/events`

Push: a peer forwards device-signed report-creation events. The **coarse**
admission check (sender must be a known, non-excluded peer) is anti-spam,
not what makes an event trustworthy — each event's own device signature is
(`docs/threat-model.md`'s "Trust signatures, not servers").

```
Request:  { "senderNodeId": "...", "events": [SignedEnvelope<DeviceCreateEvent>, ...] }   (max 100 events)
Response: { "results": [ { "federationEventId": "<sha256 hex>", "status": "created"|"merged"|"duplicate"|"rejected", "reason"?: "..." } ] }

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

## Reads

All reads require a valid token; none require a specific scope beyond having
one.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/speed-limit?lat&lng` | Nearest segment within `SPEED_LIMIT_LOOKUP_MAX_DISTANCE_METERS`; 404 if none |
| GET | `/v1/speed-limit-segments/nearby?lat&lng&radiusM` | |
| GET | `/v1/static-signs/nearby?lat&lng&radiusM` | |
| GET | `/v1/hazard-reports/nearby?lat&lng&radiusM&types` | Never returns camera-adjacent types (see below) |
| GET | `/v1/hazard-reports/by-tile?tile&k&types` | `k` = ring radius (0–5) around `tile`, an H3 resolution-7 cell id |
| GET | `/v1/speed-cameras/nearby?lat&lng&radiusM&types` | Empty unless `SPEED_CAMERA_NAMESPACE_ENABLED` |
| GET | `/v1/speed-cameras/by-tile?tile&k&types` | Dynamic camera types only (fixed cameras are globally synced, not tiled) |
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
from reads. Works regardless of the namespace flag.

## Sync (snapshot / delta)

Local-first devices bootstrap from a snapshot, then poll delta using the
snapshot's `snapshotSequence` as a starting point.

### `GET /v1/snapshot?tiles=<comma-separated H3 ids>&types=<comma-separated>`

```json
{
  "snapshotSequence": 1234,
  "speedLimitSegments": [...],
  "staticSigns": [...],
  "hazardReports": [...],
  "fixedSpeedCameras": [...]
}
```

- `speedLimitSegments` / `staticSigns` are always returned **in full** — they
  sync globally regardless of `tiles` (docs/concept.md section 3.3).
- `fixedSpeedCameras` likewise, but only populated when
  `SPEED_CAMERA_NAMESPACE_ENABLED` — empty array otherwise.
- `hazardReports` is only populated when `tiles` is given (omitting `tiles`
  means "static data only"), filtered by exact tile membership — the client
  is expected to have already expanded its own k-ring via the same H3
  resolution used server-side (7).
- Generated inside a single `REPEATABLE READ` transaction, so
  `snapshotSequence` and the returned rows are always mutually consistent —
  no event landing between the two reads can be silently missing from both.
- `staticData=false` omits `speedLimitSegments`/`staticSigns`/
  `fixedSpeedCameras` entirely (client-lib P2.0) — for a client that already
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

## Static data packages (client-lib P2.0)

Partitioned, versioned alternative to fetching all static data through
`/v1/snapshot` in one response — for large datasets, lets a client download
only the partitions covering the regions it cares about, and re-download only
what actually changed.

### `GET /v1/static-data/manifest`

```json
{
  "staticDataVersion": 7,
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "partitions": [ { "tile": "<h3 id>", "hash": "<sha256 hex>", "sizeBytes": 1234 } ]
}
```

Partitions are keyed by a coarse H3 cell (`STATIC_DATA_PARTITION_H3_RESOLUTION`,
default 2 — much coarser than the resolution-7 tiles used for dynamic data),
computed from each entity's geometry, not stored. Only partitions that
actually contain data are listed; a `LineString` segment that straddles a
partition boundary is listed (and returned) under every partition one of its
vertices falls into. `staticDataVersion` bumps on every `StaticDataUpdated`/
`StaticDataRemoved` event (fixed-camera create/removal) and on every
successful bulk import — compare it against what a client last saw before
even fetching the manifest.

### `GET /v1/static-data/partitions/:tile`

```json
{ "tile": "<h3 id>", "speedLimitSegments": [...], "staticSigns": [...], "fixedSpeedCameras": [...] }
```

404 if `tile` isn't in the current manifest (no data for it). Compare a
partition's `hash` from the manifest against what's already stored locally to
decide whether it's worth re-fetching at all.

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
| POST | `/v1/bulk-import/speed-cameras` (fixed cameras only) |

```json
{ "rows": [ { "...": "entity-specific fields, see below" } ] }
```

Response: `{ "inserted": <count> }`. Capped at 5000 rows per call.

**Bulk-imported rows do not append event-log entries** (deliberate — a
single call inserting thousands of rows would otherwise dominate the log's
size and drown out everything else during that retention window). Clients
only see bulk-imported static data via their **next snapshot**, not via
delta. This is fine for static data, and consistent with bulk-import being
an infrequent, largely one-time operation rather than a steady stream.

Row shapes:

```jsonc
// speed-limit-segments
{ "lineString": [[lng, lat], [lng, lat], ...], "speedLimit": 50, "speedLimitUnit": "kmh",
  "source": "osm", "sourceLicense": "ODbL", "importedAt": "2026-01-01T00:00:00Z" /* optional, defaults to now */ }

// static-signs
{ "lat": 52.5, "lng": 13.4, "signType": "DE:274", "source": "osm", "sourceLicense": "ODbL" }

// speed-cameras
{ "lat": 52.5, "lng": 13.4, "source": "seed", "sourceLicense": "unclear" }
```

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

This is single-instance in Phase 1 — the subscription registry lives in
process memory. Horizontal scaling would need it backed by something shared
across instances (e.g. Postgres `LISTEN`/`NOTIFY`); explicitly out of scope
here.

## Environment / configuration

See [`../.env.example`](../.env.example) for the full list with defaults —
every tunable (rate limits, merge radius, expiry durations, retention
windows, JWT TTL, camera removal threshold) is an environment variable, never
a hardcoded constant in the route/service code.
