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
GIST index on `geometry`. **This table is the *imported* truth and is never
written by the community-corrections feature** — see below.

**`geometry_key` (K-A, migration 0007):** a *stored generated column* (`text`,
32 lowercase hex chars, btree-indexed) computed by the SQL function
`speed_limit_geometry_key(geometry)`. It is the cross-server-stable identity of
a segment's geometry — what community corrections and device-signed votes
reference, because `id` is a random per-server, per-row UUID. It can't be
written or drift; nothing in the import code has to know about it. The formula
(also implemented independently in `tests/integration/speed-limit-geometry-key.test.ts`
so other implementations can check themselves):

```
pts(g)  = for each vertex in order:  round(X * 1e7) "," round(Y * 1e7)       -- integer micro-degrees, X = lng, Y = lat
fwd     = join(";", pts(g))            rev = join(";", reverse(pts(g)))
key     = first 32 hex chars of sha256( min(fwd, rev) )                       -- UTF-8, plain ASCII (C collation) comparison
```

Rounding to 1e-7° (≈1 cm) makes the key independent of float formatting and
of sub-centimetre noise; `min(fwd, rev)` gives a road digitised in the opposite
direction the same key. Rows with identical geometry (a re-import creates
them) share a key, so a correction applies to all of them. If a later import
changes a segment's *geometry*, its key changes and the corrections of the old
key become orphans (`npm run corrections -- orphans`).
The function binds PostGIS via its own `search_path`, so it keeps working under
`pg_restore` (which empties `search_path`) and on hosts that install PostGIS
outside `public`.

### `speed_limit_correction_votes`
Append-only log of every vote — the **source of truth** of community
corrections (`docs/speed-limit-corrections.md` D2). `seq` (bigserial PK — this
server's insertion order and the federation pull cursor, never comparable across
servers), `id` (unique; sha256 over the signed envelope for a signed vote,
`local:<uuid>` for an unsigned one), `segment_key`, `reporter_id`
(`device:<key id>` or `local:<client id>` — pseudonymous, never returned by any
endpoint), `submitted_by` (the calling client's JWT subject, null for a replicated
vote — what the per-client rate limit counts), `kind` (`support`|`deny`),
`value`, `unit`, `reason`, `vote_timestamp` (the signed timestamp, or receive
time for an unsigned vote — the ordering key), `received_at`, `envelope` (the
verbatim `SignedEnvelope`, null for an unsigned/node-local vote), `origin_node_id`.
No foreign key to `speed_limit_segments`: a vote may arrive before its segment is
imported, and must survive a wipe-and-reimport.

### `speed_limit_corrections`
Materialised view of the votes: one row per `(segment_key, unit, value)` that a
vote names. `id` is deterministic — first 128 bits of
`sha256("speedLimitCorrection|<key>|<unit>|<value>")` as a UUID — so it addresses
the same record on every server. `status` (`proposed`|`applied`|`superseded`|
`reverted`), `support_count`, `deny_count`, `reason` (of the earliest supporting
vote), `first_proposed_at`, `last_vote_at`. Node-local bookkeeping (not part of
what federation converges on): `applied_at`, `reverted_at`, `base_value` (the
imported value it was proposed against — the reference for `needsReview`),
`blocked_at`/`blocked_reason` (operator reset: the candidate can never win until
restored). Re-derived from the votes on every vote (`recomputeSegment`); the
*effective* value is joined in at read time (an `applied` row on the same key and
unit whose value differs from the imported one), never written into
`speed_limit_segments`.

### `speed_limit_correction_bans`
`reporter_id` (PK), `reason`, `banned_at`. Operator-maintained; votes by a banned
reporter are excluded from every tally (retroactively; unbanning restores them)
and a banned reporter's local submissions are refused. Local policy — never
replicated.

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

**`camera_type` (add-on D, migration 0009)** — `camera_type` enum
(`fixedSpeedCamera` | `redLightCamera` | `distanceControl`), `NOT NULL DEFAULT
'fixedSpeedCamera'`. The table holds every *permanently installed* enforcement
device, not only speed cameras; the name stays (a rename would need a view under
the old name and is a separate, later step). Adding the column is metadata-only
(a constant default is stored in the catalogue, no row is rewritten — measured
5 ms at 1,000,000 rows), and every row that existed before is a speed camera
without being touched. The enum is append-only, like `hazard_type`: a new value is
one `ALTER TYPE … ADD VALUE`. Every value is also a `hazard_type` label, so a client
that decodes an item's `type` into the hazard enum handles it. No index: three
values, always combined with the GiST index on `position`. Design, rollback and the
reasons for each choice: [`persistent-enforcement-devices.md`](persistent-enforcement-devices.md).

The other camera-adjacent types (`mobileSpeedCamera`, `trailerCamera`) and — by
default — user reports of `redLightCamera` and `distanceControl` do **not** go
there — they behave exactly like ordinary hazard types (10–15 min expiry, extended on
confirmation) and live in `hazard_reports` via the `type` discriminator. A red-light or
distance device that is *permanently installed* (imported from a map source, for example)
is a row of `fixed_speed_cameras` with the matching `camera_type`.

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
`StaticDataRemoved`), `entity_type` (`hazardReport` | `fixedSpeedCamera` |
`speedLimitSegment` | `staticSign` | `enforcementDevice` — the last one, add-on D,
for the persistent red-light and distance devices; speed cameras keep
`fixedSpeedCamera`), `entity_id`, `payload` (jsonb — the full
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

**Federation columns (F-S3, all nullable):** `federation_event_id` (sha256
hex of a device-signed `SignedEnvelope`'s own `(payload, signature)` — a
cross-server-stable id, unlike `sequence`, which is a per-server bigserial;
`UNIQUE`, so re-ingesting the same event twice is a plain insert conflict,
not a silent duplicate), `federation_envelope` (the envelope itself, kept
verbatim so the event can be re-broadcast or independently re-verified by
anyone), `origin_node_id` (the peer this event was received from — `null`
for a locally originated event; used only to avoid immediately gossiping an
event back to whoever just sent it, never a trust signal). Set only for
report-creation events whose reporting device signed the content itself —
see `modules/federation/device-event.ts` and `docs/api.md`'s
`POST /v1/hazard-reports` `deviceAssertion` field. Everything before this
milestone, and every event from a device with no bound key, has all three
`null`.

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

### `network_peers`

Federation peer directory (F-S3, `modules/federation/*`): every other server
this node has joined with or learned about via gossip (a joined peer's own
peer list, returned alongside its join response). `node_id` (PK, =
`keyId(public_key)`), `public_key`, `address` (its `https://` base URL),
`discovered_via` (`seed`|`gossip`|`join`, set once at first insert),
`joined_at`, `last_seen_at` (bumped on every successful join/heartbeat/gossip
contact). `last_pulled_sequence` is local-only bookkeeping for the
anti-entropy pull worker — the highest `event_log.sequence` this server has
already pulled *from this specific peer*; never sent to or compared against
any other server, since sequence numbers aren't comparable across servers
(each is its own per-process bigserial). `last_pulled_votes_sequence` (K-A) is
the same bookkeeping for the separate speed-limit vote stream
(`speed_limit_correction_votes.seq`).

**Reputation columns (F-S4, `modules/federation/reputation.ts`):**
`successful_health_checks` / `consecutive_health_check_failures` — updated
only by *this* server's own active checks (a heartbeat send or anti-entropy
pull it initiated), never by anything the peer claims about itself.
`invalid_signature_count` — cumulative, bumped whenever a push from this
peer contained an event whose signature didn't verify; per the F-S0 plan,
any nonzero value alone is disqualifying (immediate demotion), not a
threshold to cross. `last_known_version` — self-reported by the peer in a
heartbeat *it* sends us, recorded as plain metadata, not a trust signal.
None of these four columns are queried directly by API responses — the
reputation *tier* (`probation`/`active`/`trusted`) shown in
`GET /v1/network/directory` is always derived from them fresh on read
(`computeReputationTier`), never stored, so it can't drift out of sync with
the signals it summarizes.

### `static_data_state`
Single-row table (`id` is always `1`) holding `version`, a monotonically
increasing counter bumped transactionally by `appendEvent()` (for
`StaticDataUpdated`/`StaticDataRemoved`) and by every bulk-import insert
(client-lib P2.0's `/v1/static-data/manifest` calls this `staticDataVersion`
— see `docs/api.md`). A row `UPDATE`, not a `SEQUENCE`, so the bump rolls
back with the rest of its transaction if that transaction fails. Also bumped
(K-A) whenever the *effective* speed limit of a segment changes through a
community correction, and once when a boot finds
`COMMUNITY_CORRECTIONS_ENABLED` flipped: `corrections_overlay_enabled` remembers
the switch value of the last boot so that flip can be detected and announced.
Migration 0007 bumps it once too, because every segment now carries `segmentKey`.

## Migrations

`0000_enable_postgis.sql` (hand-written, must run first — `CREATE EXTENSION
IF NOT EXISTS postgis`) then `0001_...sql` (drizzle-kit generated from the
schema). Regenerate with `npm run db:generate` after changing
`src/db/schema/*.ts`; apply with `npm run db:migrate`.

`0007_speed_limit_corrections.sql` (K-A) is generated plus two hand-written
parts: it first creates the SQL function `speed_limit_geometry_key()` (the
generated column needs it), and ends by bumping the static-data version. Adding
the stored generated column **rewrites `speed_limit_segments` once** and holds an
exclusive lock while it does — measured on a throwaway `postgis/postgis:16-3.4`
container with 1,000,000 synthetic 4-vertex segments: about **18 s for the
rewrite plus 3 s for the index**, i.e. roughly 20 s per million segments (a
Europe-wide import of tens of millions of rows would be several minutes). Run the
migration before starting the new server, not while it serves traffic
(`docs/operating.md`). Afterwards the key costs about 12 µs per inserted segment
(one SQL-function call per row, measured over 200,000 geometries), which
lengthens a bulk import by roughly 12 s per million rows.
