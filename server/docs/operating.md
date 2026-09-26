# Operating a Federated Server

For first-time setup, see [`installation.md`](installation.md). This covers
running a server day-to-day once it's part of (or about to join) the
federation — see [`federation-protocol.md`](federation-protocol.md) for how
the pieces work, and [`threat-model.md`](threat-model.md) for why.

## Joining the network

1. You need a public, reachable `https://` address before you turn
   federation on — peers dial `FEDERATION_PUBLIC_ADDRESS` back for
   heartbeats and gossip fan-out, so it must resolve to *this* server, not a
   NAT gateway with nothing forwarded. If you're behind a reverse proxy (see
   `installation.md`), that's the address to use.
2. Set in `.env`:
   ```bash
   FEDERATION_ENABLED=true
   FEDERATION_PUBLIC_ADDRESS=https://your-server.example
   FEDERATION_SEEDS=https://seed1.example,https://seed2.example
   ```
   `FEDERATION_SEEDS` is optional — omit it if you're standing up the first
   server of a new network, or if you'd rather be joined *to* than initiate
   joins yourself (another server can still reach you and join, regardless).
3. Restart the server. It joins every configured seed once, best-effort — a
   seed being briefly unreachable doesn't block startup or retry loop
   forever; check the logs (`federation: joined seed` / `federation: failed
   to join seed`) to confirm.
4. Confirm you're visible: `curl https://your-server.example/v1/network/directory`
   should list itself under `self`, and (once at least one seed accepted the
   join) other peers should list you back within one
   `FEDERATION_HEARTBEAT_INTERVAL_SECONDS` interval.

You start on `probation` tier everywhere you're known — this is normal and
expected (see "Reputation" below), not something to fix.

## Monitoring

- **`GET /v1/network/directory`** (no auth) — your own self-description plus
  every peer you know, each with its computed reputation tier. The
  operator-facing view of "is my node healthy and known."
- **`GET /v1/federation/peers`** (no auth, only when `FEDERATION_ENABLED`) —
  the same peer list with the raw counters
  (`successfulHealthChecks`/`consecutiveHealthCheckFailures`/`invalidSignatureCount`)
  the tier is computed from, useful when a tier alone doesn't explain what's
  going on.
- **Logs**: every federation background-job outcome is logged at `info`
  (successful joins, anti-entropy pulls that ingested something) or `warn`
  (a failed heartbeat/pull/push to a specific peer — routine in an open
  network, not necessarily actionable on its own, but a sustained run of
  warnings about the same peer is worth a look).
- **`GET /v1/health`** — unchanged, still just DB reachability; doesn't
  reflect federation state at all.

There's no built-in metrics/alerting integration — federation state is
observable entirely through the endpoints above plus ordinary log
aggregation, consistent with how the rest of this server has no metrics
dependency either.

## If a peer looks wrong

**A peer shows `probation` despite being known a long time**: check
`GET /v1/federation/peers` for that node — `invalidSignatureCount > 0` means
it pushed you at least one event whose signature didn't verify at some
point in the past (cumulative, never resets on its own — see
`federation-protocol.md` §4.3). A high `consecutiveHealthCheckFailures`
means your own heartbeat/pull attempts to it have been failing recently
(check that peer's own reachability, not necessarily a fault of theirs —
transient network issues look the same as a real problem from your side).
Neither of these is anything you need to act on: it's purely informational,
affects nothing about how you serve your own clients, and heals itself once
the peer's behavior/reachability improves (except `invalidSignatureCount`,
which stays on the record).

**You believe a peer is genuinely malicious** (not just unreliable): local
demotion already happened automatically and needs no action from you. Actual
network-wide exclusion is root-key-gated by design (`federation-protocol.md`
§4.4) — you can't exclude a peer yourself, and no local reputation signal
does it automatically either. Report it to whoever holds the network root
key for that network; they decide whether to add it to the signed
`excludedNodeIds` list and redistribute the config.

**You've been excluded, or suspect you have been**: fetch the current
network config your operator distributed (or ask them for it) and check
`excludedNodeIds` for your own `nodeId` (`GET /v1/network/node-info`). If
you believe this is a mistake, that's a conversation with the root key
holder — nothing on your own server can override a signed exclusion, by
design. You can always keep running with `FEDERATION_ENABLED=false` (or
simply without a `NETWORK_CONFIG_PATH`) as a fully functional, isolated
single server in the meantime.

## Running a node with Europe-sized data (E-B)

Design, decisions and the reasoning behind the numbers: [`europe-scale.md`](europe-scale.md).
Numbers below are **measured** unless marked otherwise — on the real Europe import (a copy of the `tn-europe`
node, 12.08 M segments + 1.55 M signs) where it says so, otherwise on the real Bayern import replicated across Europe;
how they were obtained is in `europe-scale.md`.

**What a row costs** (PostGIS 16, indexes included):

| | per row | real Europe import (13.63 M rows) |
|---|---|---|
| speed-limit segment | **≈ 434 B** in the database (table 301 B + `geometry_key` index 59 B + GiST 42 B + primary key 32 B), unchanged from 0.44 M to 12 M rows | database **5.3 GB** after migration 0007 (4.1 GB before) |
| sign | ≈ 180 B | 278 MB |
| package JSON (uncompressed) | ≈ 443 B | **6.0 GB** of JSON in 5,825 tiles |
| package, gzip 9 / brotli 9 | ≈ 110 B / ≈ 106 B (4.0× / 4.2×) | **1.49 GB / 1.44 GB**; both copies on disk **2.9 GB** |

**Sizing** (measured for the real import; a different dataset scales linearly): **≈ 5.3 GB of database** for
13.6 M rows (allow 6–7 GB for growth), **≈ 3 GB in `STATIC_PACKAGES_DIR`** (gzip + brotli copies, plus room for files a rebuild
replaces), and **≈ 1.44 GB (brotli) to 1.49 GB (gzip) per device** for a complete bootstrap; the largest tile is 9.4 MB on the wire, the median
0.1 MB, the manifest 361 KB gzip. Disk: allow ≥ 3× the database size for WAL, autovacuum and the initial import. RAM: the
API process needs little — **a complete package build peaked at 315 MB** under a 512 MB heap cap, a snapshot over the limit is refused —
but **the first full build is database-bound: 7 h 4 min** with 2.5 GB for Postgres (the working set is 3.5 GB heap + 1.5 GB indexes). Give the
database RAM for its working set (untested here: it should shorten this a lot) or accept a one-time overnight build; it resumes after an
interruption, and later rebuilds touch only changed tiles (3 s for one). 2 vCPUs.

**Building the packages.** `STATIC_PACKAGES_DIR` (in Docker a volume). After an import the worker
notices the marked tiles and rebuilds them (debounced, see below); to do it explicitly, and to see progress:

```bash
npm run static-packages -- status                  # ready? tiles, dirty, disk, lease
npm run static-packages -- build                   # dirty tiles (all of them for a first build)
npm run static-packages -- build --full            # rebuild everything (after hand-edited SQL, or to be sure)
npm run static-packages -- verify [--deep]         # files exist (and re-hash them)
```

Run it with the same `DATABASE_URL`/`.env` and directory as the server; it takes the builder lease, so a
running server's worker and the CLI never build at once (a crashed builder blocks for at most two minutes).
Interrupt it any time — finished tiles are recorded, the next run continues. Until the first complete
build the manifest answers `503 PACKAGES_BUILDING` (datasets up to 200 k rows are built by the first
request instead). **Do not edit static tables by hand and expect packages to follow** — SQL marks
nothing; run `build --full` afterwards.

**Resolution — the default is 4, and all nodes must agree.** `STATIC_DATA_PARTITION_H3_RESOLUTION`
defaults to **4** (≈ 1,770 km², packages of a few MB at Europe density; the former default 2 made
tiles of hundreds of MB — measured). Every node of one network **must** use the same value: tile ids
and packages of different resolutions are incompatible, and a client would download everything
twice. Do not change it on a node that has users — every device would have to re-download all static
data; a change makes the next start rebuild every package (the log says so in a warning). Clients see
the value in every manifest (`partitionResolution`) and in `GET /v1/config`, and discard packages
they hold at another resolution rather than mix them. The operator fixed it at 4 on 2026-09-25,
while there are no real users, precisely because later it would be a forced full bootstrap.

**Import.** `POST /v1/bulk-import/*` is one batched statement per call now; the tool's batch size can go up to
`BULK_IMPORT_MAX_ROWS` (default 5000, at most 50,000). No event-log rows are written however much is imported;
the version rises once per call and the touched tiles are marked in the same transaction. Package builds wait for
a quiet period (`STATIC_PACKAGES_DEBOUNCE_SECONDS`), so an import of hours triggers no rebuild until it ends.

**Serving.** Put a reverse proxy in front and let it cache `/v1/static-data/packages/<tile>/<hash>` (immutable);
for a CDN set `STATIC_PACKAGES_PUBLIC=true` so that one route needs no credential. `GET /v1/snapshot` (with static
data) is refused above `SNAPSHOT_STATIC_MAX_ROWS` rows — clients use the manifest.

**Maintenance** (untuned defaults suit a small node, a Europe-sized table wants a look):
* `VACUUM (ANALYZE)` after the import — the row estimate `GET /v1/snapshot`'s guard reads comes from it, and so do
  the planner's choices (autovacuum will do it, later).
* A bulk import is insert-only: no bloat to reclaim. `REINDEX` is only needed after a crash or an index-corruption
  warning; the three segment indexes together are ≈ 37 % of the segment table's size.
* `CLUSTER speed_limit_segments USING speed_limit_segments_geometry_gist` would store rows in spatial order, making a
  package build read sequentially — the likely cure for the 7-hour first build (see above). Not measured here (it needs room
  for a second copy of the table, and an exclusive lock).
* Back up the database, **not** `STATIC_PACKAGES_DIR` (derived data): after a restore run `static-packages build --full`.

## Community speed-limit corrections (K-A)

Users can propose a corrected speed limit; once `COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED`
distinct devices agree (default 3) it overlays the imported value. The imported
row is never modified — everything below is about what *this server counts and
serves*, and none of it replicates: another operator may judge the same votes
differently. Design and reasons: [`speed-limit-corrections.md`](speed-limit-corrections.md).

Run the tool from a checkout of the repository with `DATABASE_URL` pointing at
the server's database (the same way as `npm run create-client`); it needs no
running server, but it cannot push WebSocket messages, so clients pick a change
up on their next delta/manifest poll.

```bash
npm run corrections -- list [--status applied,proposed] [--needs-review] [--limit 100]
npm run corrections -- show <segment-id | segment-key>     # rows, corrections and every vote of one segment
npm run corrections -- reset <correction-id> [--reason "..."]
npm run corrections -- reset --all [--reason "..."]        # roll back every correction in effect
npm run corrections -- restore <correction-id>
npm run corrections -- ban <reporter-id> [--reason "..."]  # reporter ids are shown by `show`
npm run corrections -- unban <reporter-id>
npm run corrections -- bans
npm run corrections -- orphans
```

**A wrong correction is in effect.** `show <segment-id>` (a segment id from the
client, or the `segmentKey`) lists the corrections and who voted. Then
`reset <correction-id>`: the candidate can never win again until you `restore`
it, the imported value is served at once (and announced as a static-data change
so package and delta clients converge), and further votes cannot quietly bring it
back. Votes are kept. If another value was waiting just below the threshold it
takes over — the tool prints that change; `reset` it too if it is wrong as well.

**Roll everything back.** `reset --all` resets every applied correction
(repeating until nothing is applied, because resetting a winner can promote a
runner-up). For switching the *feature* off, see the next point; a reset
correction stays reset even if the feature is switched on again.

**Switch the whole feature off.** `COMMUNITY_CORRECTIONS_ENABLED=false` and
restart: reads return the imported values again, `POST/GET /v1/speed-limit-corrections*`
and `/v1/federation/speed-limit-votes` disappear (404), `GET /v1/config` says
`communityCorrections.enabled: false` (clients hide the feature), pushed votes
are `ignored`. Votes and corrections stay in the database. On the boot that
sees the flip the server bumps the static-data version and announces every
segment that had an applied correction, so clients drop (or, when you switch it
back on, regain) the overlay without waiting for anything else.

**Ban a reporter.** `ban <reporter-id>` excludes that reporter's votes from
every tally — retroactively, which can turn an applied correction back into the
imported value — and refuses their new submissions. `unban` restores them.
Reporter ids are pseudonyms (`device:<key id>` for a device key,
`local:<client id>` for an unsigned caller); a `device:` id is what appears in
`show`. A ban is per server; it does not stop the same device on another server.

**Needs review.** `list --needs-review` shows applied corrections where a later
import changed the imported value to something else than what the correction
replaced or now says. They keep being served (an import never silently
overwrites a community-confirmed value — nor silently brings back one the
community removed). Decide with `show`, and `reset` if the new import is right.

**Orphans.** `orphans` lists corrections whose segment does not exist on this
server: votes replicated from a peer with other regional data, or segments whose
geometry changed in a re-import (their `segmentKey` changed). They cost only a
few rows and take effect if the geometry ever appears; nothing to do.

Tuning (all in `.env.example`): the threshold, the plausible range per unit
(`..._KMH_MIN/MAX`, `..._MPH_MIN/MAX`), the value step, and the per-client rate
limit. Keep the range/step/threshold the same as the servers you federate with —
votes are checked against *your* limits on arrival, so different limits make servers
disagree about which votes count.

## Migrations that take a heavy lock

**Migration 0007 (community corrections) needs a maintenance window on a node that already holds
a lot of data.** It is the only such migration so far; 0008 (static packages) only creates new,
empty tables and is instant. Everything else in this section is why, what to expect and how to
avoid it.

**What happens.** 0007 adds a *stored generated column* (`speed_limit_segments.geometry_key`) and an
index over it. Adding a stored generated column rewrites the whole table, and drizzle's migrator applies
all pending migrations in **one transaction**, so the table is held under `ACCESS EXCLUSIVE` — neither
readable nor writable — until that transaction commits. **20–30 s per million segments**: 21 s on the K-A
branch (synthetic rows, `schema.md`), and **373.6 s for the real 12.08 M-row Europe database** (31 s per million;
a copy of the `tn-europe` volume in a container with 2.5 GB of memory). Plan **≈ 6 minutes at 12 M rows, ≈ 8 at 15 M**.
The static-data version is bumped once, so clients re-download their packages (every segment now carries `segmentKey`).

**What you see.** The migrate step prints a `WARNING: pending migrations take a heavy lock` block with the
table and its row estimate *before* it starts. In Docker the migration runs when the container starts,
before the server listens: after `docker compose up -d --build` the server is simply not up for that long,
and on a very large table the container may show as `unhealthy`; nothing restarts it. **Do not interrupt it**:
an aborted migration rolls back completely and the next start begins again from zero. `pg_stat_activity`
shows the `ALTER TABLE` while it runs.

**When you need a window, and when you do not.**

| Situation | Impact |
|---|---|
| New database (fresh install, tests, the integration suite) | none — the tables are empty |
| Node without users, or before the big import | none that matters; 6 min of nobody waiting |
| Node upgrading from a release *before* K-A **with** users and Europe-sized data | a maintenance window of 20–30 s per million segments — announce it, take a `pg_dump` first, run `npm run db:migrate` (or the container's migrate step) *before* starting the new server |

The way to avoid the window altogether is to take it early: **migrate a big node while it has no users** (the
Europe node `tn-europe` is upgraded before the network opens), and every later database either starts
fresh or is already migrated. A `pg_dump` restore works without extra steps (the key function pins its own
`search_path`).

**Could it be online? Checked — not with reasonable effort.** The obvious online recipe is: constant-default
columns (no rewrite since PostgreSQL 11), `CREATE INDEX CONCURRENTLY`, a backfill in batches, and
`NOT NULL` through a `CHECK … NOT VALID` + `VALIDATE CONSTRAINT` (since PostgreSQL 12 a validated CHECK lets
`SET NOT NULL` skip the scan). The parts that do apply are used and enforced (policy below); for
`geometry_key` itself:

1. **A stored generated column has no online form** on PostgreSQL 16 (the supported image; PostgreSQL 18 adds
   *virtual* generated columns, which need no rewrite but are not what the images ship).
2. **Plain column + trigger + batched backfill + concurrent index** is online, but heavier — measured with
   `npm run measure-scale -- --phase keycolumn` on 1,000,000 rows of the real table: the backfill updates every
   row once (after a bulk import the pages are full, so hardly any update is HOT), so against the rewrite it took
   **+28 % time (42.1 s vs 32.9 s), +57 % WAL (610 vs 389 MB), and left the table about twice as large (393 vs 267 MB)
   and the indexes +53 % (193 vs 126 MB)** until a `VACUUM FULL`; the keys came out identical.
   `CREATE INDEX CONCURRENTLY` cannot run inside the migrator's transaction, so the migrate step would
   need a second, non-transactional phase; until the backfill has finished the overlay would not match some
   segments, so a "keys ready" state like the package `ready` flag would be needed to avoid serving wrong
   answers; and a trigger would sit on the import path forever instead of a column the database maintains.
3. **An expression index instead of a column** needs no rewrite but recomputes the key (≈ 20 µs) for every
   overlay join and package build, permanently.
4. **A side table of keys** filled in batches is online, but every overlay read and package build then joins it.

So the one-off rewrite stays and is documented; if a node ever has to upgrade without a window, variant 2
is the design to build (batch size, readiness flag and the second phase are the work).

**Policy for new migrations** (enforced by `tests/unit/migration-locks.test.ts`, the migration files from 0007
on): on a table that already exists, add columns nullable or with a constant default; add `CHECK`/foreign-key
constraints `NOT VALID` and validate them in a later statement; avoid `ALTER COLUMN … TYPE`, `SET NOT NULL`
without a validated CHECK, volatile defaults and unbounded `UPDATE`/`DELETE`; build indexes on the big static
tables `CONCURRENTLY` as a separate operator step, not inside the migrator. Where no online form exists the
statement carries a comment — `-- lock-ok(<table>): <why, how long>` (the migrate step then prints it as a
warning with the table's row estimate) or `-- lock-trivial: <why it is cheap>` — and this section names the
window. Migrations 0001–0006 predate the policy; they ran on small or empty tables.

## Persistent enforcement devices (add-on D): upgrading and rolling back 0009

`fixed_speed_cameras` now holds every permanently installed enforcement device — speed cameras, red-light and
distance devices (`camera_type`); design in [`persistent-enforcement-devices.md`](persistent-enforcement-devices.md),
wire contract in `api.md` ("Persistent enforcement devices"). Migration **0009 needs no maintenance window**: it
adds one column with a constant default, which is a catalogue change and touches no row (5 ms at 1,000,000 rows).
Every existing row becomes a speed camera. It also makes a node rebuild its static packages once (the fingerprint
changed) and bumps the static-data version so clients refresh.

**Before the upgrade** take a backup — at least the tables the migration touches:

```bash
pg_dump -Fc -f before-0009.dump "$DATABASE_URL"
# or, smaller: pg_dump -Fc -t fixed_speed_cameras -t camera_removal_reports -t event_log -f before-0009-cameras.dump "$DATABASE_URL"
```

and, if you like a count to compare: `select count(*) from fixed_speed_cameras;` before and after must match
(`tests/integration/persistent-devices-migration.test.ts` runs exactly this check on a database filled in today's format).

**Rolling back.** Stop the server, then run the script once (it is one transaction; a second run changes nothing):

```bash
psql -v ON_ERROR_STOP=1 -f src/db/rollback/0009_persistent_enforcement_devices.down.sql "$DATABASE_URL"
```

It drops `camera_type`, drops the `camera_type` type, removes the migration's row from `drizzle.__drizzle_migrations`
(without which the next start of the new code would believe 0009 is applied) and bumps the static-data version. **It
refuses — and changes nothing — while red-light or distance devices exist**: dropping the column would turn them into
speed cameras, and the script never reclassifies data silently. Export or delete those rows on purpose, then run it again:

```sql
\copy (select * from fixed_speed_cameras where camera_type <> 'fixedSpeedCamera') to 'devices.csv' csv header
delete from fixed_speed_cameras where camera_type <> 'fixedSpeedCamera';
```

What stays after a rollback: the label `enforcementDevice` in the `entity_type` enum (PostgreSQL cannot drop an enum
label; nothing writes it any more). Then start the previous release; it rebuilds its packages once. Importing
red-light or distance devices is only for servers that have this feature — an older server would store them as speed
cameras (it ignores the unknown `cameraType`), so take them out of the import until every server you feed has been upgraded.

## Restarting, upgrading, backing up

An upgrade that includes a migration with a heavy lock (0007, above) needs a maintenance window on a big node;
take a database backup first, as for any migration.

Your **node identity** (the Ed25519 keypair other servers know you by) lives
in your database (`node_identity` table), not on disk or in an env var — it
survives a container recreation, a redeploy, or a host migration exactly as
long as your database does. Restarting the process (or the whole container)
never changes your identity or requires re-joining. Losing your database
without a backup means losing your node identity along with everything
else — the same backup discipline that already protects your report/static
data protects this too; there's nothing federation-specific to back up
separately.

Upgrading (`docker compose up -d --build` after pulling new code, or the
equivalent for a non-Docker install) is safe to do without coordinating with
peers — every federation endpoint is additive-only so far (no breaking wire
changes are planned without a protocol version bump, `FEDERATION_PROTOCOL_VERSION`
in `modules/federation/protocol.ts`), and a brief outage during restart is
exactly what the reachability signals (`federation-protocol.md` §4.3) are
already designed to tolerate.

## Leaving the network

Set `FEDERATION_ENABLED=false` and restart. All `/v1/federation/*` endpoints
stop existing (404) — peers still trying to reach you will just see
connection/heartbeat failures and, after enough of them, stop counting on
you (nothing punitive happens; you simply fade out of their peer view over
time as reachability checks fail). Your local data and existing
symmetric-secret clients are entirely unaffected. There's no "unjoin"
handshake to perform — federation membership isn't a state a server commits
to, it's just "am I currently reachable and answering."

## Tuning

Everything is an env var (see `.env.example` and `docs/api.md`'s
"Environment / configuration" for the full list) — nothing federation-related
is a hardcoded constant. Notable ones you might reasonably want to adjust
away from their defaults:

- **`FEDERATION_HEARTBEAT_INTERVAL_SECONDS`/`FEDERATION_ANTI_ENTROPY_INTERVAL_SECONDS`**
  (default 60s/300s) — how chatty your background jobs are. Lower values
  detect a partition/recovery faster but mean more background HTTP traffic
  to every known peer; on a network with many peers this scales linearly
  with peer count per server, so don't set these too aggressively low on a
  well-connected node.
- **`REPUTATION_*`** thresholds — how quickly a peer earns `active`/`trusted`
  and how tolerant you are of transient failures before demoting to
  `probation`. Purely local to your own view; changing these never affects
  how other servers see you.
- **`ONLINE_*`** — the "currently online" figure (`GET /v1/stats/online`, see
  `api.md`). It is numbers only and kept in memory, so there is nothing to
  back up or purge; a restart just starts counting again. Set
  `ONLINE_COUNTER_ENABLED=false` to switch it off entirely (the endpoint then
  answers `{ "enabled": false }` and your node stops sending its figure to
  peers). `ONLINE_MIN_DISPLAY_THRESHOLD` (default 5) is the privacy floor —
  below it the endpoint says "fewer than N"; lower it only if you are sure the
  exact small number can't identify anyone on your node. In the network total
  your node only counts peers it has itself seen as `active`/`trusted`, so a
  brand-new peer's figure shows up once it has earned that standing, not
  immediately.
- **`FEDERATION_OVERLOAD_MAX_CONCURRENT_PUSHES`** — raise it if your server
  has real headroom and you're seeing unnecessary 503s under legitimate
  replication load; lower it if a burst of pushes is visibly affecting your
  own request latency.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| A speed-limit correction I expected isn't showing | Below threshold (`list --status proposed`, needs `COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED` *net* confirmations — denials count against it), a tie between two values (imported value stays), reset by an operator (`show <segment>`), or the votes came from a banned reporter |
| Corrections proposed on another server never arrive | That server's votes were unsigned (node-local by design), it has corrections off, or your vote pull can't reach it — look for `federation: speed-limit vote pull from peer failed` in the logs |
| Users get `422 CORRECTION_VALUE_NOT_ON_STEP` / `..._OUT_OF_RANGE` | The configured step/range (`GET /v1/config` → `communityCorrections`); relax `COMMUNITY_CORRECTIONS_VALUE_STEP` or the bounds if real limits are being refused |
| Migration 0007 seems stuck | It is rewriting the segment table (20–30 s per million rows, 6 min at 12 M); check `pg_stat_activity` before interrupting |
| `FEDERATION_PUBLIC_ADDRESS is required whenever FEDERATION_ENABLED=true` at startup | Set both together — see "Joining the network" step 2 |
| Join to a seed fails at startup, logged as a warning | Seed unreachable, wrong URL, or its `excludedNodeIds` includes you — check the seed's own logs/directory if you can reach an operator |
| A peer never shows up in `GET /v1/federation/peers` even though you're sure they joined | Discovery is one-hop, join-time only (`federation-protocol.md` §7) — if you learned about them only via a third party's gossip and never joined them directly, and that third party never re-gossips, you may simply never have a direct relationship; join them directly if you need one |
| Reports created elsewhere never show up locally | Confirm the *originating* client actually attached `deviceAssertion` (only device-signed creates federate — see `docs/api.md`'s `POST /v1/hazard-reports`); a symmetric-secret-only client's reports never leave their own server |
| `503 OVERLOADED` from a peer you're pushing to | Their concurrency cap, not yours — back off and retry; anti-entropy will also catch you up on anything they miss in the meantime |
