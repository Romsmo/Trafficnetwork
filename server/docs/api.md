# Server API (Phase 1)

Base path: `/v1`. All responses are JSON. All routes require authentication
(`Authorization: Bearer <token>`) except `GET /v1/health` and `POST /v1/auth/token`.

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

Scopes: `client` (normal read/write access) and `bulk-import` (grants the
`/v1/bulk-import/*` endpoints). A client credential maps 1:1 to a reporter
identity — every write endpoint derives `reporterId` from the token's
subject, never from the request body.

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
| GET | `/v1/snapshot?tiles&types` | See "Sync" below |
| GET | `/v1/delta?since&tiles&types&limit` | See "Sync" below |

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
Request:  { "type": "<hazard type>", "lat": number, "lng": number, "speedKmh"?: number }
Response: { "report": {...}, "merged": boolean }   — 201 if new, 200 if merged
```

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
