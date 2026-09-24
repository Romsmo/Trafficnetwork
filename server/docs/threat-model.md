# Threat Model: Self-Hosting & Federation

Scope: the server rework in `docs/prompt-rework-server-federation.md` — open
membership, signature-based trust, self-hosting. This is the full version of
the summary presented for approval before F-S1 began; see that plan/report
for the research citations behind the design choices referenced here. Not
in scope: `client-lib/`'s own threat surface (covered by the companion
client-lib federation rework), physical security of an operator's hardware.

## Core principle

**Trust signatures, not servers** (`docs/federation.md` §2). Open membership
means any server can be malicious. No client or server may treat a fact as
true because of *who sent it* — only because it carries a valid signature
from the party that's supposed to vouch for that fact.

## Actors

| Actor | Motivation / capability |
|---|---|
| Malicious or compromised server operator | Wants to inject false data, censor/withhold real data, harvest client metadata (IP + subscribed tiles), or exhaust other servers' resources |
| Malicious or compromised device | Wants to spam reports, forge another device's identity, bypass rate limits by spreading submissions across servers |
| Network attacker (MITM) | Wants to intercept or tamper with traffic between client↔server or server↔server |
| Sybil attacker | Registers many fake servers to gain disproportionate influence over reputation, directory listing weight, or client traffic share |
| Compromised directory service | Wants to steer clients toward malicious servers or hide legitimate ones |
| Root key holder (the project owner) | Trusted by construction — but key loss or compromise is catastrophic; see below |
| Holder of an existing P1/P2 device credential | Not an attacker — a compatibility constraint: must keep working through the migration |

## Assets

- **Device signing keys** — generated on-device, must never leave it. Compromise = that one device's identity is fully impersonable.
- **Network root key** — held offline by the project owner. Compromise or loss is the single most catastrophic event in the whole design; see mitigation below.
- **Delegation keys** (directory key, import key) — narrower blast radius than the root key by construction (each is revocable independently via the signed network config).
- **Reporter pseudonymity** — position tiles + IP address, visible to whichever server a client happens to talk to. Explicitly flagged as a residual risk in `docs/federation.md` §5, not something this rework claims to fully solve.
- **Event data integrity** across relays — an event must remain verifiable after passing through zero or more untrusted intermediary servers.
- **Server node keys** — identify a server to its peers; used for heartbeats and gossip. Compromise lets an attacker impersonate that one server's *behavior history*, not forge data.

## Threats, and what actually mitigates each one

| Threat | Mitigation | Residual risk |
|---|---|---|
| Forged device report/confirmation | Every server and client verifies the device's Ed25519 signature over the canonical (RFC 8785) payload before accepting it | None — an invalid signature is unconditionally rejected |
| Server withholds or delays data | Anti-entropy hash comparison between peers surfaces "event X has been known elsewhere for N minutes, absent here" | Detection, not prevention — a server can still delay briefly before being caught; reputation drop is the consequence, not an undo |
| Server lies about its own capacity/health in heartbeats | A heartbeat's `capacityHint` is self-reported and never trusted directly; reputation (F-S4) is instead built from *this server's own* measured success/failure rate reaching that peer | Self-reported metrics are inherently gameable in any open system; academic consensus is that Sybil/self-report resistance is never fully solved in permissionless networks — accepted, not "fixed" |
| Sybil flood of fake servers | Join-rate-limiting per IP (F-S4, `POST /v1/federation/join`, 30/minute); reputation starts at `probation` and ramps slowly (F-S4, `modules/federation/reputation.ts`); directory listing weight is capped for probation-tier servers (F-S4, `REPUTATION_DIRECTORY_PROBATION_MAX_SHARE`) | Bounded, not eliminated — a sufficiently patient/distributed attacker can still slowly build reputation across many identities; the cap limits how much directory visibility any single low-reputation identity can capture in the meantime. IP-based only, not ASN-level (no GeoIP/ASN infrastructure in this project) |
| MITM / server impersonation | Mandatory valid TLS (no self-signed certs accepted); a server's node public key is bound to its advertised address at directory registration, and changing the address requires a freshly signed proof from the same key | An attacker who compromises a server's *actual* TLS cert/private key can still impersonate it — outside this project's control, standard TLS operational hygiene applies |
| Root key compromise or loss | Root key never touches a running server or the internet — used offline, only to sign delegation certs and network-config updates | Loss is unrecoverable by design (no backdoor); the documented outcome is a fork with a new root key, which is a deliberate, accepted trade-off (`docs/federation.md` §2), not a gap to close later |
| Legacy P1/P2 device credential (symmetric secret) | Purely additive migration — see `server/README.md`'s federation section; nothing breaks for a non-federating operator | None specific to this rework — the existing symmetric-secret model's own properties (already true today) carry over unchanged for single-server use |
| Import-key holder publishes bad static data | Import key is itself a delegated, revocable credential — the root key can revoke it via a network-config update | Bounded blast radius (one delegated key, not the whole network), but real until revoked and propagated |
| An algorithm unilaterally excludes a legitimate operator | Network-wide exclusion is only ever a signed network-config entry — no purely local/automatic process can produce it | A malicious *root key holder* could still exclude arbitrarily — out of scope; the root key holder is trusted by construction in this design |
| Privacy leak via IP+tile correlation on a federated server | Coarse tiles, multi-server spreading (client-lib's responsibility), operator privacy notice requirement | Explicitly accepted residual risk per `docs/federation.md` §5 — not something a server-side change alone can close |

## F-S3 implementation notes

F-S3 built the actual join/gossip/heartbeat/push/pull machinery this
document's mitigations assume (`modules/federation/*`). Two scoping
decisions worth recording here, since they narrow what's actually true today
versus the target design above:

- **Only report *creation* is federated with a device signature so far**,
  not confirm/deny. A confirm/deny needs to name *which* report it targets
  by a cross-server-stable id — but that id (`federationEventId`, a hash of
  the original create envelope) isn't yet exposed back to clients through
  sync/snapshot/delta, so a device has no way to reference it. Building that
  requires a coordinated client-lib API change (F-C), not something to guess
  at from the server side alone. Until then, confirm/deny keeps working
  exactly as before (locally, via the existing endpoint) but never
  replicates — a real, documented gap, not a silent one.
- **Peer admission to push/heartbeat is coarse (must have joined), not the
  trust source.** Per the "Trust signatures, not servers" principle, a
  pushed event's *validity* rests entirely on its own device signature —
  requiring the sender to be a known peer first is anti-spam/rate-limiting,
  not what makes the event trustworthy. An unknown, never-joined server
  relaying a genuinely device-signed event would in principle be just as
  trustworthy as a joined one; requiring a join anyway keeps the push/pull
  surface from being open to arbitrary internet hosts, matching the join-
  rate-limiting mitigation in the table above.
- **A joined peer flooding fabricated-but-validly-self-signed events is a
  real, distinct threat** from the ones in the table above (a self-signed
  Ed25519 keypair proves "whoever holds this private key signed this," not
  "this is a real device") — nothing about signature verification alone
  stops a peer from generating throwaway keys and signing arbitrary garbage.
  `POST /v1/federation/events` carries a coarse, IP-based request rate limit
  (60/minute, `modules/federation/routes.ts`) as a stopgap; per-peer
  reputation (below, F-S4) adds a second layer for the narrower case of
  *invalid* signatures specifically, but doesn't defend against a peer
  flooding *validly*-signed garbage from throwaway device keys — that's
  still an open, accepted gap (see "What this rework does not attempt").

## F-S4 implementation notes

Reputation tiers (`probation` → `active` → `trusted`,
`modules/federation/reputation.ts`), the directory endpoint
(`GET /v1/network/directory`), and the overload signal
(`POST /v1/federation/events` → 503 + `Retry-After`) are built. What this
narrows versus the full picture the threats table above describes:

- **Reputation is computed only from signals this server can cheaply and
  honestly measure itself**: active health-check success/failure (heartbeat
  send, anti-entropy pull) and invalid signatures observed in a peer's
  pushes. The table's "Server withholds or delays data" mitigation — anti-
  entropy *hash comparison* surfacing "event X is known elsewhere, absent
  here" — is **not** implemented; that needs comparing what multiple peers
  each know, which is a materially larger piece (some kind of shared or
  pairwise-comparable event-set summary across the whole peer graph) than
  what F-S4 scoped. A withholding server currently only shows up as
  "reachable and signature-clean," not as suspicious. Documented gap, not a
  silent one — a candidate for a later milestone.
- **Demotion only ever returns a peer to `probation` on *this* server's own
  view of it** — it never removes a peer from the list, never propagates to
  other servers, and is trivially reversible (a peer's own next successful
  health check starts rebuilding standing again, aside from
  `invalidSignatureCount`, which is cumulative and never decreases). This is
  deliberate: per the F-S0 plan's binding decision, actual network-wide
  exclusion stays root-key-gated (the table above, "An algorithm unilaterally
  excludes a legitimate operator") — local reputation can *demote*, never
  *exclude*.
- **The overload signal is a blunt concurrency cap** (a single
  process-wide counter, not per-peer, not weighted by a pushing peer's own
  reputation) — a `trusted` peer and a `probation` peer competing for the
  last available slot are treated identically. Reputation-weighted admission
  under load (e.g. always reserving headroom for `trusted` peers) is a
  natural follow-on, not built here.

## Online counter notes (add-on O-A)

`GET /v1/stats/online` publishes how many clients are online. What that adds,
and what keeps it from becoming a tracking feature:

- **Only numbers leave the counting code.** Distinct clients are told apart by a
  salted hash of the token subject held in process memory (random salt per
  process, never persisted or logged) — no IP address, position or per-client
  history is kept, nothing goes to the database, and the counter writes no log
  lines. A memory dump of a running node yields hashes that mean nothing
  without that process's salt, not client identifiers.
- **A small number is a statement about people.** In a network with a handful of
  users "1 online" says something about one person, so below
  `ONLINE_MIN_DISPLAY_THRESHOLD` (default 5) the endpoint says "fewer than N"
  for both the node and the network figure. Residual, accepted: someone who can
  read *both* the node figure and the network total (say 5 and 7) can subtract
  and learn the aggregate of the *other* nodes (2) — an aggregate of fewer than
  N people, not any one of them, and per-peer figures are never published.
- **Peer figures are claims.** A heartbeat's `onlineCount` can't be verified.
  Mitigations: only `active`/`trusted` peers (which this node has measured as
  reliable itself) count, excluded and stale peers don't, implausible values
  (negative, fractional, > 1 000 000) are dropped, and the total is labelled
  `estimated`. **Not** mitigated: a peer that has earned `active` and then
  reports a plausible-but-false figure inflates or deflates the estimate. That
  is the same residual as self-reported `capacityHint`, at the same low stakes —
  the number decides nothing but what a display says.
- **Inflating the count** needs authenticated clients: activity only counts
  requests that succeeded and carry a `client`-scope token, so unauthenticated
  or rejected traffic can't move it. Anyone who can mint client credentials
  (device registration is self-service, capped per app key per day) can still
  make the figure larger than the number of real people — again only a display
  number. Memory is bounded (`ONLINE_MAX_TRACKED`).
- **The endpoint is public and unauthenticated** by design (the web UI and any
  client read it before or without a token). It has no per-route rate limit,
  like the other public read endpoints; it is safe because the answer is cached
  (`ONLINE_CACHE_SECONDS`) and concurrent requests share one computation.
- **Off means off.** `ONLINE_COUNTER_ENABLED=false` stops all tracking and stops
  the node from sending or using `onlineCount`; the endpoint answers
  `{ "enabled": false }`.

## What this rework does *not* attempt

- Full Sybil resistance (see table above — not achievable in an open-membership system per current literature).
- Anonymity beyond pseudonymity (a server operator can always see the IP address and rough position of a client talking to it).
- Protecting against a compromised root key holder.
- Protecting a device whose own private key has already leaked (out of scope — device-local key security is `client-lib`'s concern).
