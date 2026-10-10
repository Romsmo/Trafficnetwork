# Federation Protocol Specification

Status: implemented as of F-S5, on branch `rework/server-federation`. This is
the consolidated protocol reference the F-S0 plan deferred to this milestone
("Vollständige Spezifikation entsteht als `server/docs/federation-protocol.md`
in F-S5, sobald die Bausteine... implementiert und im Mehrknoten-Testnetz
erprobt sind"). It describes what a real, running network of these servers
does — for exact request/response JSON, see [`docs/api.md`](api.md); for the
security reasoning behind each design choice, see
[`docs/threat-model.md`](threat-model.md); for the original concept and
non-binding design space, see [`../../docs/federation.md`](../../docs/federation.md).

## 1. Core principle

**Trust signatures, not servers.** Every fact that crosses a server boundary
carries its own signature from whoever is supposed to vouch for it — a
device for its own reports, a server for its own identity/behavior claims, the
network root key for network-wide policy. No server or client ever treats a
fact as true because of *which server* relayed it.

## 2. The `SignedEnvelope`

Every signed message in this protocol has the same shape:

```
SignedEnvelope<T> = { payload: T, keyId: string, signature: string }
```

`signature` is Ed25519 (Node's native `crypto`) over the RFC 8785 canonical
JSON serialization of `payload`. `keyId` (16 hex chars, `sha256(publicKey)`
truncated) is a lookup hint only — verification always checks the signature
against a public key the verifier already has an independent reason to
trust, never against `keyId` itself. Implementation:
`src/modules/crypto/{canonical,keys,envelope}.ts`.

## 3. Identities

| Identity | Held by | Generated | Scope |
|---|---|---|---|
| **Node key** | Every server, automatically | On first boot, persisted in its own `node_identity` table row | Signs this server's join requests, heartbeats, and (implicitly, by relaying) its gossip |
| **Device key** | Any device that opts in | Client-side (client-lib's responsibility) | Signs that device's own report-creation content (`POST /v1/hazard-reports`' `deviceAssertion`) |
| **Network root key** | The project owner, offline only | Once, via `scripts/network-generate-root-key.mts` | Signs the network config; never touches a running server |

A server's node key and a device's key are unrelated identity spaces — a
node key never signs report content, and a device key never signs
server-to-server protocol messages.

## 4. Peer lifecycle

### 4.1 Join

`POST /v1/federation/join` — self-signed with the joining server's own node
key (`nodeId = keyId(publicKey)`, checked). The network doesn't vouch for a
server's identity at join time — anyone can generate a keypair and join;
what happens *after* joining (reputation, §5) is what actually matters. The
response carries the receiving server's current peer list, which the joiner
merges into its own — **this is the entire gossip mechanism**. There is no
separate gossip protocol or periodic peer-list broadcast; discovery is
one-hop and join-time only; see §7 (limitations) for what that implies.

A server with `FEDERATION_SEEDS` configured joins each seed once at startup
(best-effort — an unreachable seed never blocks startup). A server can also
be join-only (no seeds of its own, e.g. a network's first server) and simply
accept incoming joins.

### 4.2 Heartbeat

`POST /v1/federation/heartbeat` — periodic, node-key-signed
(`FEDERATION_HEARTBEAT_INTERVAL_SECONDS`, default 60s), sent to every
currently-known peer. Unlike join, a heartbeat is verified against the
**stored** key for that `nodeId` — it can update a peer's advertised
address, but it can't re-assert a new identity. Carries a self-reported
`capacityHint` (§6), `version`, and — since add-on O-A — an optional
`onlineCount`.

**`onlineCount`** (optional integer ≥ 0): how many clients are online at the
sending node right now. A plain head count — no identifiers, positions or
timestamps — produced by the same in-memory counter that backs
`GET /v1/stats/online` (`server/docs/api.md`). It is:

- **omitted**, not sent as `null`/`0`, when the sender has
  `ONLINE_COUNTER_ENABLED=false` or predates the field. The signature covers
  the exact JSON, so the field is either there or not there; a receiver that
  doesn't know the field ignores it (the payload schema is `passthrough`, and
  the signature still verifies over it), and a receiver that gets no field
  treats the sender's figure as unknown.
- **exact**, not thresholded. The "fewer than N" masking is applied where a
  figure is *published* (`GET /v1/stats/online`), never here: this is
  operator-to-operator traffic between joined peers, per-peer figures are never
  republished, and masking here would make the network total meaningless for a
  network of many small nodes.
- **a claim.** Like `capacityHint`, a receiver can't check it. It feeds only
  the *estimated* network total — never reputation. A receiver drops a value
  that isn't a plausible head count (negative, fractional, non-numeric, above
  1 000 000) without rejecting the heartbeat, keeps the last figure per peer
  **in memory only**, and counts it only while that peer is `active` or
  `trusted` in the receiver's own reputation view (never `probation`), not in
  `excludedNodeIds`, and its last heartbeat is younger than
  `ONLINE_PEER_STALE_SECONDS` (default 300). Restarting a node forgets the
  figures until the next round of heartbeats (≤ one interval).

A peer that lies within the plausible range can still skew the estimate; that
is exactly why the total is labelled `estimated` and why only nodes the
receiver has itself measured as reliable count.

### 4.3 Reputation

Computed fresh on every read (`modules/federation/reputation.ts`), never
stored as its own value — always derived from raw counters so it can't drift
out of sync with what they represent:

| Signal | Measured by | Effect |
|---|---|---|
| `successfulHealthChecks` | The heartbeat-send and anti-entropy-pull *senders*, about their own peers | Contributes toward promotion |
| `consecutiveHealthCheckFailures` | Same as above | `>= REPUTATION_DEMOTE_AFTER_CONSECUTIVE_FAILURES` forces `probation` |
| `invalidSignatureCount` | The receiver of a push, about the pushing peer | Any nonzero value forces `probation` immediately — no threshold |

Tiers: `probation → active → trusted`, gated by peer age
(`REPUTATION_PROBATION_MIN_HOURS` / `REPUTATION_TRUSTED_MIN_HOURS`) and
`successfulHealthChecks` thresholds. **Reputation is entirely local and
non-binding on other servers** — each server computes its own view of every
peer, and a `probation` verdict here never propagates anywhere. Demotion is
always reversible by the peer's own subsequent good behavior (except
`invalidSignatureCount`, which is cumulative and never decreases — a proven
bad signature stays on the record). No local computation can ever exclude a
peer from the network entirely — see §4.4.

### 4.4 Exclusion (network-wide, root-key-gated)

A signed network config's `excludedNodeIds` (produced by
`scripts/network-sign-config.mts`, loaded via `NETWORK_CONFIG_PATH`) is
checked at join, heartbeat, and push. This is the *only* way a node is
network-wide excluded — no automatic process, however severe the local
reputation signals, can produce this on its own. This is a deliberate,
binding design choice, not an oversight: unilateral algorithmic exclusion of
an operator is exactly the failure mode open federation is trying to avoid.

### 4.4a The signed network config carries the camera policy (`cameraPolicyByCountry`)

The root-signed network config (`NetworkConfigPayload`, the same document as `excludedNodeIds`) has one more optional field:

```
cameraPolicyByCountry?: { [ISO 3166-1 alpha-2, upper case]: "off" | "zones" | "full" }
```

It lists the **exceptions** to "cameras are delivered in full": per country what camera data a node may **deliver to its own clients**
(individual cameras, coarse zones, nothing). A country that is not listed - and an absent field - is `full`; `blitzerEnabled: false` remains
the network-wide emergency brake that turns every country off. A node reads the file itself (`NETWORK_CONFIG_PATH`, re-read while running) and may only be
**stricter** than it (`CAMERA_POLICY_LOCAL_CAPS`, `SPEED_CAMERA_NAMESPACE_ENABLED`); the policy is *not* distributed by
federation messages - exactly like `excludedNodeIds` it is a file the operator signs and hands to every node. The field is
optional and additive: a node that predates it ignores it (and has no country policy at all), a node that knows it treats a
file without it as "no exceptions". Validation is all-or-nothing: a key that is not `^[A-Z]{2}$`, a value that is not one of
the three levels or more than 300 entries make the **whole file invalid** (refused at start-up, fail-closed while running),
because a policy that cannot be understood completely must not be applied partly. Reload rule: `version` must not go down, and the
same `version` with different content is refused. See [`camera-country-policy.md`](camera-country-policy.md).

### 4.4b The signed network config can carry the report expiry rules (`reportExpiry`)

One more optional, additive field of the root-signed network config (server 1.1.0):

```
reportExpiry?: { [hazard type]: { defaultSeconds?: int, minSeconds?: int, maxSeconds?: int } }
```

It states, per hazard type, how long a report lives by default and the bounds of the duration a reporter may sign into a
report (§5, `expiresInSeconds`). Every field it names replaces the node's own setting; fields and types it does not name keep
the node's own value, and a node without the field uses the defaults that ship with its version. It exists so that all
nodes of a network derive the same `expiresAt` for the same signed report. Validation is all-or-nothing, like §4.4a: an unknown
type (or `fixedSpeedCamera`), an unknown field, a value that is not a whole number of seconds in 1…31 536 000, or
`minSeconds <= defaultSeconds <= maxSeconds` violated makes the whole file invalid. A node that predates it ignores the field.
See [`report-expiry.md`](report-expiry.md).

### 4.5 Directory

`GET /v1/network/directory` — always registered (unlike every other
`/v1/federation/*` endpoint), public, reputation-annotated. Probation-tier
entries are capped at `REPUTATION_DIRECTORY_PROBATION_MAX_SHARE` (default
50%) of the returned list. Exportable as a static file
(`scripts/network-export-directory.mts`) for mirroring, per the original
concept's "kein Domain-Ausfall legt das Netzwerk lahm" goal — a directory
mirror needs no server behind it at all.

## 5. Data replication

**Only device-signed report *creation* is federated.** A report is
federation-eligible only if the submitting client attached a
`deviceAssertion` (a `SignedEnvelope<DeviceCreateEvent>`, `kind: "create"`,
signed by the device's own key) to `POST /v1/hazard-reports`. A report
submitted without one is stored and served locally exactly as before this
rework — it just never leaves this server. See §7 for why confirm/deny
isn't federated yet.

```
DeviceCreateEvent = {
  kind: "create", type: <HazardType, not fixedSpeedCamera>,
  lat, lng, speedKmh?, expiresInSeconds?, devicePublicKey, timestamp
}
federationEventId = sha256(canonical({ payload, signature }))   // hex, cross-server-stable
```

`expiresInSeconds` (optional, additive, server 1.1.0) is the duration the device wants the report to live. It is part of the
signed payload, so a relay cannot change it. The end of the report is **`timestamp + (expiresInSeconds ?? default of the type)`**
— derived from what the device signed, not from the receiving node's clock, so every node reaches the same `expiresAt`
however late the event arrives. A node older than 1.1.0 ignores the field and ends the report at its own default counted from
arrival (update all nodes before relying on durations).

`federationEventId` is derived *after* signing (hash of the whole envelope,
not a field inside the signed payload) — a stable, forgery-resistant,
cross-server identity for the same logical event, independent of any one
server's own `sequence` counter (which is a local, per-process bigserial,
never comparable across servers).

### 5.1 Push

`POST /v1/federation/events` — a joined peer forwards a batch (≤100) of
device-signed events. Admission (sender must be a known, non-excluded peer)
is coarse anti-spam, **not** what makes an event trustworthy — that's
entirely the event's own signature. Every event in a batch is verified and
processed independently (`modules/federation/ingest.ts`):

1. Signature verifies against its own claimed `devicePublicKey`.
2. Timestamp within `FEDERATION_EVENT_MAX_AGE_HOURS` (default 72h — wide,
   since anti-entropy is explicitly meant to catch a server up after being
   offline for a while).
3. Not `fixedSpeedCamera` (out of scope, see §7).
4. Ordinary plausibility checks (same ones a local submission gets), including `expiresInSeconds` inside the bounds of the
   type (`implausible` otherwise) and the report's own lifetime (`timestamp` + duration) not already over
   (`stale_timestamp` otherwise — it would be stored active and swept a minute later; the sender is not penalised).
5. Not already known (`federationEventId` dedup — idempotent; a concurrent
   double-delivery loses a database-level race gracefully, treated as
   "already known" rather than an error).
6. Merge-or-create: the same `createOrMergeReport` logic a local submission
   uses, so **every server applying the same set of device events converges
   to the same materialized state regardless of arrival order** — this is
   the deterministic-merge property the F-S0 plan's replication decision
   was built around. Two devices reporting the same real-world hazard
   within `DUPLICATE_MERGE_RADIUS_METERS` merge into one report on every
   server that's seen both, whichever order they arrive in.

A newly created/merged event is published to this server's own WebSocket
subscribers and re-forwarded (gossiped) to this server's *other* known peers
(excluding whoever just sent it) — best-effort, fire-and-forget. Dedup at
each hop (step 5) is what actually bounds re-flooding across a mesh, not
anything about the fan-out itself; a fully-connected 3-node mesh delivers
every event at least twice (direct + one relay) by design, and that's fine.

### 5.2 Pull (anti-entropy)

`GET /v1/federation/events?after=<cursor>&limit=<n>` — open to any caller
(the data is meant to be network-wide anyway). `after` is a cursor the
*asking* server tracks per peer (`network_peers.last_pulled_sequence`,
local-only bookkeeping, never sent to or compared against any other server).
A background worker (`FEDERATION_ANTI_ENTROPY_INTERVAL_SECONDS`, default
300s) pulls from every known peer, closing any gap left by a missed or
failed push — a server that was briefly offline, or a peer relationship
established after an event was already pushed elsewhere, both heal this way.

### 5.2a Camera reports leave a node only where the camera may be delivered individually

A device-signed camera report (`fixedSpeedCamera` is not federated at all; `mobileSpeedCamera`, `trailerCamera`,
`redLightCamera`, `distanceControl` are) carries its exact coordinates in the envelope. A node therefore **forwards** such an event
- in `GET /v1/federation/events` (pull) and in the gossip fan-out after a push or a local report - **only if its own effective
level for the camera's country is `full`**: not at `zones` (a zone must not become a precise position one hop away), not at `off`, and
not when the country is unknown (no boundary data, outside every boundary). Every other event type is unaffected. Details:

- The country set of a camera is computed by the node that stores it (`camera_countries()` against its own boundary table, with
  the border strip - the stricter country wins) and stored on the event row. A node that **receives** the event stores it the same
  way (writing is never blocked) and decides for its own clients and its own onward forwarding by *its* policy.
  Two nodes with different boundary data or different local caps can therefore decide differently; that is intended.
- The pull cursor (`nextAfter`) advances over events that were withheld, so a peer never stalls on a page it may not read.
- Before this rule `GET /v1/federation/events` - which needs no credential - returned every device-signed camera report with its
  coordinates whatever the camera switch said. Closing that is part of the country policy; a peer cannot rely on getting camera
  reports from a node that does not deliver them, and a node that does not deliver them to its own clients does not hand them to others.
- `tests/integration/camera-policy-multi-node.test.ts` runs three real nodes (one follows the network, one caps Germany at
  `zones`, one refuses every camera) and checks both directions: what federates and what each node serves.

### 5.3 Speed-limit votes (add-on K-A)

Community speed-limit corrections (`docs/speed-limit-corrections.md`) are
federated the same way — device-signed, self-certifying, deterministically
merged — with two differences that follow from being *durable state* instead of a
72-hour hazard report.

```
SpeedLimitVote = {
  kind: "speedLimitVote", vote: "support" | "deny",
  segmentKey,                       // 32 hex, content-derived from the geometry (schema.md) — never a server-local id
  value, unit: "kmh" | "mph", reason?: "wrong_value" | "limit_lifted" | "sign_missing_or_new" | "other",
  devicePublicKey, timestamp
}
voteId   = sha256(canonical({ payload, signature }))       // same scheme as federationEventId
reporter = "device:" + keyId(devicePublicKey)               // identical on every server → identical tally
```

* **Own stream.** Push: the optional `speedLimitVotes` array next to `events` in
  `POST /v1/federation/events` (an older peer's schema drops the unknown key
  instead of rejecting the batch). Pull: `GET /v1/federation/speed-limit-votes?after=&limit=`
  with a separate per-peer cursor (`network_peers.last_pulled_votes_sequence`).
  Votes are **never purged** by event-log retention, so a server that joins
  later or heals a long partition catches up on all of them. A peer answering
  `404` (older server, or corrections off) is skipped without counting a failed
  health check.
* **Ingest** (`modules/speed-limit-corrections/ingest.ts`): signature verifies
  against the key the payload names; timestamp not more than 5 minutes in the
  future — **no maximum age**; value passes this server's own range/step;
  insert `ON CONFLICT (id) DO NOTHING` (idempotent under concurrent
  push+pull — no unique-violation race to catch); recompute the segment. A vote
  for a segment this server doesn't have is stored anyway (the segment may be
  imported later, and the pull cursor won't come back for it).
* **Deterministic merge.** The effective value of a segment is a pure function
  of the *set* of non-banned votes (per reporter, in `(timestamp, id)` order: one
  support per segment, denials per value; `net = supporters − deniers`; highest
  net at or above `COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED` wins; a tie for
  first place has no winner). No arrival-order dependence, no hysteresis — so
  two servers holding the same votes serve the same value, which the multi-node
  test (`tests/integration/federation-speed-limit-corrections.test.ts`) checks
  including a partition healed by pulls in a different order on each server.
* **What is *not* federated:** unsigned votes (a web session has no device key —
  they count on the server they were sent to only), operator resets, bans and
  the operator's threshold/range — all local policy. Keep the range/step/threshold
  equal across servers you federate with, or they will disagree about which
  votes count.
* **Trust.** A relay cannot alter a vote (signature) and a bad signature costs
  the sender its reputation like any bad event. What signatures cannot stop is
  a party that controls many *device keys* (a Sybil): a local vote is therefore
  only accepted with the key bound to the calling client (which bounds
  registrations by the per-app-key daily cap), but a malicious *server* can still
  mint keys — see `docs/threat-model.md`, "Community speed-limit corrections".

## 6. Overload signaling

`POST /v1/federation/events` returns `503` + `Retry-After` once
`FEDERATION_OVERLOAD_MAX_CONCURRENT_PUSHES` pushes are being processed
concurrently by this process (`modules/federation/load.ts`) — a concurrency
cap, not a per-sender rate limit (that's the separate 60/minute IP-based
limit on the same route). Outbound heartbeats carry the same gauge as a
self-reported `capacityHint`, so a well-behaved peer can back off before it
starts actually seeing 503s. Per §4.3, this value is never trusted for
reputation scoring on its own — it's a courtesy signal, not a measured one.

## 7. What this protocol deliberately does not do (yet)

Recorded here, and in `docs/threat-model.md`'s implementation-notes
sections, so it reads as a tracked gap rather than an unstated limitation:

- **Confirm/deny replication.** A confirm/deny needs to name *which* report
  it targets by a cross-server-stable id, but `federationEventId` isn't yet
  exposed back to clients through `/v1/snapshot`/`/v1/delta` — a device has
  no way to reference it. This needs a coordinated client-lib API change
  (F-C), not something to guess at from the server side.
- **Fixed-camera federation.** `fixedSpeedCamera` reports have no automatic
  expiry and their own removal-report lifecycle (`camera_removal_reports`)
  — federating them would need their own merge semantics this milestone
  didn't build. **The same holds for every persistent enforcement device**
  (add-on D: `redLightCamera`, `distanceControl` next to the speed cameras in
  `fixed_speed_cameras`): they are node-local static data, seeded by a node's own
  import or a database dump, never replicated. `cameraType` therefore never
  crosses the federation boundary, and there is no "peer with an unknown
  `cameraType`" to handle. What *does* federate is the device-signed **report** of a
  `redLightCamera` / `distanceControl`: an ordinary `hazard_reports` row that expires
  like any other (`tests/integration/federation-multi-node.test.ts` checks that the
  persistent device on one node does not appear on its peers while the report does).
  Making the camera table federate needs the merge semantics above plus a
  cross-node device identity and provenance for rows that carry no device signature —
  a project of its own (see `docs/persistent-enforcement-devices.md`, §5).
- **Distribution of the camera policy.** The signed `cameraPolicyByCountry` travels as a file, like `excludedNodeIds`; there is no
  federation message that carries it, and a node does not learn a newer one from a peer. Automatic distribution (and a network-wide
  rule for "which version is newest") is a separate piece of work.
- **Withholding detection.** The original concept's "event X is known
  elsewhere, absent here" anti-entropy hash comparison needs a
  peer-graph-wide comparable summary of what each server knows — materially
  more infrastructure than a per-peer pull cursor. A server that withholds
  data currently just looks like a normal, signature-clean peer.
- **Reputation-weighted overload admission.** The overload gate (§6) is one
  process-wide counter; a `trusted` and a `probation` peer competing for the
  last available slot are treated identically.
- **Periodic re-gossip.** Peer discovery is one-hop and join-time only (§4.1)
  — if server B joins A before C does, B never learns about C unless B
  itself later talks to someone who already knows C (e.g. by joining C
  directly, or re-joining A after C has joined). A real network with servers
  joining over time in varied order can end up with an incomplete mesh this
  way; F-S5's multi-node test (`tests/integration/federation-multi-node.test.ts`)
  works around this by having later joiners include every earlier node in
  their own seed list, not by the protocol repairing it automatically.
- **Network-wide per-device rate limiting.** The moderation gate's
  `REPORT_RATE_LIMIT_MAX` is per-server; a device rate-limited on one server
  can still reach the network through another. This is an accepted
  characteristic of per-server moderation, not something federation
  currently coordinates — deterministic merge (§5.1, step 6) still ensures
  the eventual materialized state is consistent even if a spamming device
  isn't caught as early as it would be on a single-server deployment.
- **ASN-level Sybil resistance.** Join- and push-rate-limiting are IP-based
  only (no GeoIP/ASN infrastructure in this project).

## 8. Backward compatibility

`FEDERATION_ENABLED=false` (the default) is exactly today's single-server
behavior — none of `/v1/federation/*` is even registered, and
`GET /v1/network/directory` returns an empty peer list. Every existing
symmetric-secret client keeps working unchanged whether or not an operator
federates; device-signed content is opt-in per report, not a replacement for
the existing write path.
