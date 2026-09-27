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

## Restarting, upgrading, backing up

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
| `FEDERATION_PUBLIC_ADDRESS is required whenever FEDERATION_ENABLED=true` at startup | Set both together — see "Joining the network" step 2 |
| Join to a seed fails at startup, logged as a warning | Seed unreachable, wrong URL, or its `excludedNodeIds` includes you — check the seed's own logs/directory if you can reach an operator |
| A peer never shows up in `GET /v1/federation/peers` even though you're sure they joined | Discovery is one-hop, join-time only (`federation-protocol.md` §7) — if you learned about them only via a third party's gossip and never joined them directly, and that third party never re-gossips, you may simply never have a direct relationship; join them directly if you need one |
| Reports created elsewhere never show up locally | Confirm the *originating* client actually attached `deviceAssertion` (only device-signed creates federate — see `docs/api.md`'s `POST /v1/hazard-reports`); a symmetric-secret-only client's reports never leave their own server |
| `503 OVERLOADED` from a peer you're pushing to | Their concurrency cap, not yours — back off and retry; anti-entropy will also catch you up on anything they miss in the meantime |
