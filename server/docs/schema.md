# Database Schema (Phase 1)

Postgres + PostGIS (SRID 4326 everywhere). Schema source of truth is
`src/db/schema/*.ts`; migrations are in `src/db/migrations/`. This document
is a narrative overview, not a column-by-column reference — read the schema
files for exact types/constraints.

## Geometry columns: a gotcha worth knowing

Every `geometry` column in this schema uses a custom Drizzle column type
(`src/db/schema/geometry.ts`), **not** Drizzle's built-in `geometry()`
helper. The version of `drizzle-orm` pinned in `package.json` has a bug: its
built-in helper's `getSQLType()` silently ignores the configured SRID and
always emits unqualified `geometry(point)`. That would leave every geometry
column with an unspecified SRID, making `ST_DWithin`/`ST_MakePoint(...,4326)`
comparisons fail as a mixed-SRID operation. The custom type always emits an
explicit `geometry(<subtype>,4326)`.

Consequence: reads and writes through these columns always go through raw
`sql` templates with `ST_AsGeoJSON`/`ST_MakePoint`/`ST_GeomFromText`, never
Drizzle's typed insert/select helpers (see `src/db/queries/*.ts`).

## Two lifecycles (docs/concept.md section 3)

**Static/semi-static** — synced globally, in full, to every client:
`speed_limit_segments`, `static_signs`, `fixed_speed_cameras`.

**Dynamic** — synced regionally, filtered by `region_tile` (an H3
resolution-7 cell id, computed in application code via `h3-js`, not a
Postgres extension): `hazard_reports`.

## Tables

### `speed_limit_segments`
`geometry(LineString,4326)`, `speed_limit`, `speed_limit_unit` (`kmh`|`mph`),
provenance (`source`, `source_license`, `imported_at`, `last_confirmed_at`).
GIST index on `geometry`.

### `static_signs`
`position` (Point), `sign_type` — a country-prefixed catalog reference (e.g.
`"DE:274"`, analogous to OSM's `traffic_sign=DE:*`), never hardcoded to one
country's catalog. GIST index on `position`.

### `fixed_speed_cameras` + `camera_removal_reports`
Modeled like `static_signs` (no automatic expiry) rather than like
`hazard_reports`: `status` (`active`|`removed`), `removed_at`,
`last_confirmed_at`. `camera_removal_reports` holds one row per
(camera, reporter) — a UNIQUE constraint enforces one "this is gone" vote per
reporter; the count drives the `active → removed` transition
(`CAMERA_REMOVAL_THRESHOLD`). No `region_tile` column — this table is global
like the other static entities.

The other four camera-adjacent types (`mobileSpeedCamera`, `trailerCamera`,
`redLightCamera`, `distanceControl`) do **not** get their own tables — they
behave exactly like ordinary hazard types (10–15 min expiry, extended on
confirmation) and live in `hazard_reports` via the `type` discriminator. Only
`fixedSpeedCamera` — the one camera type with no automatic expiry — gets
separate storage.

### `hazard_reports` + `hazard_confirmations`
`type` (11-value enum, `fixedSpeedCamera` included for completeness but never
actually stored here — see below), `position` (Point), `region_tile`,
`reporter_id`, `speed_kmh` (nullable — only meaningful for
`mobileSpeedCamera`/`trailerCamera`), `expires_at`, `status`
(`active`|`expired`|`removed`; `removed` is defined but nothing in Phase 1
ever sets it — reports only leave `active` via expiry), `source`
(`community`|`seed`), denormalized `confirm_count`/`deny_count` (maintained
transactionally alongside `hazard_confirmations` inserts, not computed via
`COUNT(*)` on read). `hazard_confirmations` has a UNIQUE constraint on
`(hazard_report_id, reporter_id)` — one vote per reporter per report,
`stillThere` or `gone`, not both.

`type = 'fixedSpeedCamera'` is intercepted at the API boundary
(`modules/hazard-reports/routes.ts`) before any insert — it's routed into
`fixed_speed_cameras` instead. It remains a valid enum label (so
`event_log.payload->>'type'` can carry it for camera-namespace events, see
below) but is structurally impossible to find in this table's `type` column.

Indexes: GIST on `position`; btree on `(region_tile, status)`,
`(status, expires_at)`, `type`.

### `event_log`
Append-only. `sequence` (a plain integer PK, not bigint — at any scale this
project will plausibly reach, it stays a safe JS integer, which keeps it
usable directly in delta query params and JSON responses without bigint
serialization workarounds), `occurred_at`, `type` (`ReportCreated` |
`ReportConfirmed` | `ReportDenied` | `ReportExpired` | `StaticDataUpdated` |
`StaticDataRemoved`), `entity_type`, `entity_id`, `payload` (jsonb — the full
current representation of the entity, not a diff), `region_tile` (nullable —
null means "global", e.g. every static-entity event), `moderation_status`
(currently only ever `"accepted"` — every event that reaches the log has
already passed the synchronous moderation gate; kept as an enum rather than
dropped so a future async/appeal moderation flow could add more states
without a column-type change), `source`.

Every write goes through `db/append-event.ts`'s `appendEvent()`, always
inside the same transaction as the corresponding materialized-table write —
the event and the materialized state can never diverge. WebSocket publish
happens only after that transaction has committed (see
`modules/realtime/publisher.ts`).

**Bulk-import is the one exception**: rows inserted via `/v1/bulk-import/*`
do not get event-log entries (see `docs/api.md`'s "Bulk import" section for
why) — a fresh snapshot, not delta, is how clients pick those up.

Retention: `EVENT_LOG_RETENTION_DAYS_DYNAMIC` (default 3) for the four
report-lifecycle event types, `_STATIC` (default 30) for the two
static-data event types. Enforced by `modules/expiry/retention.ts`'s hourly
cleanup job, which also hard-deletes `expired`/`removed` hazard_reports rows
once they're older than the dynamic window (kept briefly after that point for
moderation/duplicate-detection context, not forever). `getDeltaPage`'s
`SNAPSHOT_REQUIRED` check is correct independently of this job's schedule —
it looks at what the log actually still contains, not at the configured
window directly.

### `clients`
`client_id` (public, e.g. `client_a1b2c3d4...`), `client_secret_hash`
(salted scrypt, format `"<saltHex>:<hashHex>"` — see
`modules/auth/credentials.ts`; the plaintext secret is never stored),
`scopes` (`client_scope[]` — `client`, `bulk-import`, and/or
`device-registration`), `name`, `revoked_at`. Provisioned via
`npm run create-client`, or, for `device-registration`-scoped "app key"
clients, self-service by any device via `POST /v1/devices/register` (see
`docs/api.md`) — the one case where a `clients` row is created via an HTTP
endpoint rather than the operator CLI.

`registered_by_client_id` (nullable, self-referencing FK to `clients.id`):
set only on rows created via `POST /v1/devices/register`, pointing at the
app-key client that requested them — lets an app's devices be looked up or
rate-limited (`DEVICE_REGISTRATION_RATE_LIMIT_MAX_PER_DAY`) by app key. Null
for every client provisioned via `create-client`.

`device_public_key` (nullable, F-S2): an Ed25519 public key (raw base64url),
set once via `POST /v1/devices/bind-key` — see `docs/api.md`. When set, this
client can additionally authenticate via `POST /v1/auth/device-token` (a
signed assertion) alongside the always-available symmetric `clientSecret`
flow. One-shot — `bindDevicePublicKey()` in `db/queries/clients.ts` only ever
sets this from `NULL`, never overwrites an existing key (rotation isn't
built yet).

### `node_identity`
Single-row table (`id` is always `"self"`) holding this server's own Ed25519
node identity (`public_key`, `private_key`, both raw base64url) — generated
once on first boot (`modules/network/node-identity.ts`), unlike
`static_data_state`'s migration-seeded row, since every server instance
needs its own unique keypair. Stored in the database rather than a
file+volume — one less persistence mechanism to operate, and it survives
container recreation exactly as long as the database does. This is the
server's *own* identity (exposed publicly at `GET /v1/network/node-info`),
not a device signing key — the "never leaves the device" rule in
`docs/threat-model.md` is about device keys, not this one. Not yet used for
anything beyond self-description (F-S3 signs heartbeats/join-requests with
it).

### `static_data_state`
Single-row table (`id` is always `1`) holding `version`, a monotonically
increasing counter bumped transactionally by `appendEvent()` (for
`StaticDataUpdated`/`StaticDataRemoved`) and by every bulk-import insert
(client-lib P2.0's `/v1/static-data/manifest` calls this `staticDataVersion`
— see `docs/api.md`). A row `UPDATE`, not a `SEQUENCE`, so the bump rolls
back with the rest of its transaction if that transaction fails.

## Migrations

`0000_enable_postgis.sql` (hand-written, must run first — `CREATE EXTENSION
IF NOT EXISTS postgis`) then `0001_...sql` (drizzle-kit generated from the
schema). Regenerate with `npm run db:generate` after changing
`src/db/schema/*.ts`; apply with `npm run db:migrate`.
