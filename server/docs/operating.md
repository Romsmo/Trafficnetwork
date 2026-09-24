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

## Restarting, upgrading, backing up

**Upgrading to the release with community corrections (migration 0007)** adds a
stored generated column (`speed_limit_segments.geometry_key`) and therefore
**rewrites the segment table once, under an exclusive lock**: roughly 20 seconds
per million segments (measured, see `schema.md`). Run `npm run db:migrate` (or the
container's migrate step) *before* starting the new server and expect the
segment table to be unavailable for that time on a large database. (In the Docker
setup the migration runs when the container starts, before the server begins
listening — the server is simply not up for that long after `docker compose up -d --build`,
and on a very large table the container can show as `unhealthy` until the migration
finishes; that is expected, nothing restarts it.)
The migration also bumps the static-data version once, so clients re-download their packages
(every segment now carries `segmentKey`). Take a database backup first, as for any migration.
A restore from `pg_dump` works without extra steps (the key function pins its own
`search_path`).

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
| Migration 0007 seems stuck | It is rewriting the segment table (about 20 s per million rows); check `pg_stat_activity` before interrupting |
| `FEDERATION_PUBLIC_ADDRESS is required whenever FEDERATION_ENABLED=true` at startup | Set both together — see "Joining the network" step 2 |
| Join to a seed fails at startup, logged as a warning | Seed unreachable, wrong URL, or its `excludedNodeIds` includes you — check the seed's own logs/directory if you can reach an operator |
| A peer never shows up in `GET /v1/federation/peers` even though you're sure they joined | Discovery is one-hop, join-time only (`federation-protocol.md` §7) — if you learned about them only via a third party's gossip and never joined them directly, and that third party never re-gossips, you may simply never have a direct relationship; join them directly if you need one |
| Reports created elsewhere never show up locally | Confirm the *originating* client actually attached `deviceAssertion` (only device-signed creates federate — see `docs/api.md`'s `POST /v1/hazard-reports`); a symmetric-secret-only client's reports never leave their own server |
| `503 OVERLOADED` from a peer you're pushing to | Their concurrency cap, not yours — back off and retry; anti-entropy will also catch you up on anything they miss in the meantime |
