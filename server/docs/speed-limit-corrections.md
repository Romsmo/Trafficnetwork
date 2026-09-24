# Community speed-limit corrections (add-on K-A, server part)

Scope: `docs/prompt-addon-speed-limit-corrections.md`, part A. Users can report
a wrong speed limit and propose the right value; once enough independent
devices agree, the proposal overrides the imported value **as an overlay** —
the imported row is never touched. This document is the design plan the prompt
asks for: every decision the prompt left to the server side is listed here with
the reason for it. Endpoint shapes are in `api.md`, tables in `schema.md`,
the operator runbook in `operating.md`, wire format in `federation-protocol.md`,
attacks in `threat-model.md`.

## Hard rules (from the prompt) and how they are met

| Rule | How |
|---|---|
| The imported value is never deleted or overwritten | Corrections live in their own tables. `speed_limit_segments` is not written by this feature at all. The effective value is computed at read time (`coalesce(applied correction, imported)`), so a re-import, a wipe-and-reimport or switching the feature off can only ever fall back to the import. |
| A single report changes nothing | An overlay applies only when its **net confirmations** (distinct supporting devices minus distinct denying devices) reach `COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED` (default **3**, operator decision, no constant in code). Below that it is served as `proposed` ("reported, unconfirmed"). |
| Plausibility limits | Range per unit (`COMMUNITY_CORRECTIONS_KMH_MIN/MAX`, `..._MPH_MIN/MAX`), value step (`..._VALUE_STEP`, default 5), unit must equal the segment's own unit, must reference a concrete existing segment, value must differ from the imported one. |
| Reversible | (a) `npm run corrections -- reset <correctionId>` / `reset --all`; (b) `COMMUNITY_CORRECTIONS_ENABLED=false` switches overlay, endpoints and federation of votes off; the package version is bumped on the flip so clients drop the overlay. |
| Device-signed and limited | Optional `deviceAssertion` exactly like hazard reports; the key must be the one bound to the calling client. Own, stricter per-device rate limit (`COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX` per `..._WINDOW_MINUTES`, default 5 per 60 min vs. 10 per 10 min for reports). |
| Honest display | Every segment whose effective value is a correction carries `correctedBy: "community"`, `importedSpeedLimit`, and a `correction` object (confirmations, time, id, `needsReview`). Unconfirmed proposals are available through `GET /v1/speed-limit-corrections`. |

## Decisions

### D1. Stable segment identity across servers: `segmentKey`

`speed_limit_segments.id` is a random UUID per row per server, so it cannot
appear in a device-signed, federated vote. A correction therefore references a
**content-derived key** of the segment geometry:

```
segmentKey = first 32 hex chars of sha256( canonical )
canonical  = min( fwd, rev )      -- C collation, plain ASCII compare
fwd        = join(";", for each vertex in order:  round(lng * 1e7) "," round(lat * 1e7))
rev        = same with the vertex order reversed
```

* Integer micro-degrees (≈1 cm) instead of decimal text: no float-formatting
  differences between implementations, and 7 decimals is what OSM stores anyway.
* `min(fwd, rev)`: the same road digitised in the opposite direction gets the
  same key (the data model has no direction).
* Implemented **once**, as the SQL function `speed_limit_geometry_key(geometry)`,
  and exposed as a **stored generated column** `speed_limit_segments.geometry_key`.
  No backfill job, no null keys, cannot drift, nothing for the import code to
  remember. Cost, measured on 1M synthetic segments in a throwaway
  `postgis/postgis:16-3.4`: the migration rewrites the table once (≈18 s + 3 s
  for the index per million rows, under an exclusive lock — `operating.md`), and
  every later insert pays ≈12 µs for the function call (a 3× faster PL/pgSQL
  variant was tried and rejected: it is quadratic in the vertex count and the
  absolute saving is seconds per million rows).
* Two rows with the same geometry (a re-import creates them) share one key; a
  correction applies to both — desired.
* `segmentKey` is part of every segment in every read (snapshot, nearby,
  lookup, partitions) so a client can sign a vote without a second request.
  Cost: ≈ 45 bytes per segment in the packages; accepted, and the migration
  bumps the static-data version once so clients refresh.

Known limit: if a later import changes a segment's *geometry* (way split /
merged), its key changes and its corrections no longer match — they show up
as **orphans** in the operator tool. Geometry corrections are a non-goal.

### D2. Votes are the source of truth; corrections are a materialised view

Federation must converge: two servers that hold the same set of signed votes
must compute the same effective value, in any arrival order. So:

* `speed_limit_correction_votes` is an append-only log (one row per signed or
  local vote). **Effective state is a pure function of the set of non-banned
  votes** — no path dependence, no "first come" rule.
* `speed_limit_corrections` is derived from it on every vote (one row per
  `(segmentKey, unit, value)`), holding counters and the lifecycle status.
  `applied_at` / `reverted_at` are node-local bookkeeping and are *not* part
  of the convergence claim; the applied *value* is.

### D3. What a vote is; merging; denial

A vote is `support(value)` ("the limit here is X") or `deny(value)` ("X is
wrong"), by one *reporter* (a device). Evaluated per reporter in order of
(signed timestamp, vote id):

* a reporter supports **at most one value per segment** — a later `support(Y)`
  withdraws their earlier `support(X)` (changing one's mind is allowed);
* `deny(X)` removes the reporter's own `support(X)` and stays until they
  `support(X)` again;
* the same reporter repeating the same stance is a no-op (not stored, not
  counted against the rate limit).

`net(X) = #supporters(X) − #deniers(X)`. Same-value proposals are simply the
same candidate — "merged into confirmations" falls out of the model
(response says `merged: true`). A **denial can tip an applied correction**:
with the default threshold 3, four supporters and two deniers → net 2 → the
overlay is dropped again and the status becomes `reverted`.

*Why net and not "denials ≥ supporters":* net makes support and objection
symmetric, needs no hysteresis (hysteresis is path-dependent and would break
convergence), and is explainable in one sentence. The price is that one denier
offsets one supporter — the same price every distinct-device threshold pays
against a Sybil attacker (see threat model).

### D4. Competing values

Per unit: among candidates with `net ≥ threshold`, the highest `net` wins.
**A tie for first place means no winner** — the imported value stays. Rationale:
a tie is genuine disagreement about a safety-relevant number; the conservative
answer is the source value until one side gets another confirmation. Losing
candidates with `net ≥ threshold` are `superseded`. An operator `reset` of the
winner therefore promotes a runner-up that is waiting at the threshold (the tool
prints that change; `reset --all` repeats until nothing is applied).

### D5. Lifecycle statuses

`proposed` (below threshold, never applied on this node) → `applied` (the
winner) → `superseded` (another value overtook it) or `reverted` (net fell
below threshold again, or the operator reset it). A reverted/superseded
candidate can become `applied` again if votes change. The prompt's
`proposed → applied → reverted/superseded` maps 1:1.

### D6. Units and ranges

The value must be in **the segment's own unit** (mph for UK/IE sources). A
correction never converts. The overlay is joined on `(segmentKey, unit)`, so a
correction can never be applied to a segment whose unit differs. Default
bounds: 5–150 km/h, 5–85 mph, step 5 (nearly every posted limit is a multiple
of 5; the step check catches fat-finger values like 55 for 5 or 13 for 130).
"Limit lifted" is an optional *reason*, not a special value — the value is the
limit that now applies (e.g. the general statutory limit).

### D7. Import changes later → "needs review" (prompt item 5)

`speed_limit_segments` is insert-only for the import; a re-import inserts new
rows. Each correction remembers `base_value`, the imported value it was
proposed against. At read time, for an **applied** correction and a segment
row whose imported value is:

| imported value now | effective value | `needsReview` |
|---|---|---|
| unchanged (`== base_value`) | correction | false |
| equals the correction | imported (overlay redundant; upstream agrees) | — |
| anything else | **correction stays** | **true** |

*Why keep the correction and flag instead of dropping it?* An import must not
silently overwrite a community-confirmed value (prompt) — and equally must not
silently *resurrect* a number the community had just removed as wrong. When
upstream changed to a third value nobody can tell automatically who is right,
so the server keeps the last human-confirmed state, makes the doubt visible
(`correction.needsReview`, operator list `needs-review`) and leaves the
decision to the operator (`reset`) or to the community (new votes). A manual
review UI is a non-goal.

### D8. Distribution

* **Event log / delta:** whenever the *effective* value of a segment changes
  (winner appears, disappears, or changes), one `StaticDataUpdated` event per
  affected segment row is appended (`entityType: speedLimitSegment`, payload =
  the full effective segment, `regionTile: null`, `source: "community"`), which
  also bumps `static_data_state.version`. No new event type.
* **Snapshot & packages:** read the same overlay query → corrected values,
  `correctedBy`, counts. The version bump invalidates the partition cache, so
  partition hashes change and clients re-download exactly the affected tiles.
* Counter-only changes (a 4th supporter of an already-applied value) do **not**
  bump the version: rebuilding the packages is the expensive operation, votes
  are rare, and the live numbers are available from `GET /v1/speed-limit-corrections`.
  The counts inside a package are therefore "as of the last transition".

### D9. Federation

A device-signed vote is a new envelope payload `kind: "speedLimitVote"` —
`{ kind, vote: "support"|"deny", segmentKey, value, unit, reason?, devicePublicKey, timestamp }`.
It carries the *segmentKey*, not a local id, so any server that has that
geometry resolves it. Vote id = `sha256(canonical({payload, signature}))` (same
scheme as report events).

* **Push:** `POST /v1/federation/events` gains an *optional* `speedLimitVotes`
  array next to `events`. Kept separate so an older peer that doesn't know the
  field simply ignores it (zod strips unknown keys) instead of rejecting the
  whole batch.
* **Pull:** `GET /v1/federation/speed-limit-votes?after=<seq>&limit=<n>`,
  cursor per peer in `network_peers.last_pulled_votes_sequence`. A separate
  stream because votes are durable state (never purged by the event-log
  retention), so a newly joined or long-partitioned server catches up on
  *all* of them — a report-style "72 h max age" would break convergence. A
  peer answering 404 (older server / feature off) is skipped silently and is
  *not* counted as a failed health check.
* **Ingest:** verify signature; reject timestamps more than 5 minutes in the
  future; **no maximum age** for replicated votes; plausibility check; insert
  `ON CONFLICT DO NOTHING` (idempotent, no unique-violation race); recompute.
  Votes for a segment this server doesn't have are stored anyway (the
  segment may be imported later; otherwise the vote would be lost for good
  since the pull cursor has moved on) and listed by `orphans`.
* Operator resets and bans are **local policy** and do not federate — another
  operator may legitimately disagree. Excluding a node stays in the signed
  network config, as before.
* Corrections stay **eventually consistent**: convergence is guaranteed for the
  set of signed votes; node-local, unsigned votes (see D10) only count on the
  node they were sent to.

### D10. Reporter identity and Sybil resistance

* Signed vote: reporter = `device:<keyId(devicePublicKey)>` on every node
  (deterministic, so all nodes agree). A locally submitted `deviceAssertion`
  must use the key **bound to the calling client** (`POST /v1/devices/bind-key`);
  otherwise a client could mint unlimited "distinct devices" by generating keys.
* Unsigned vote (e.g. the web UI, whose sessions have no device key):
  reporter = `device:<keyId(bound key)>` if the caller happens to have a
  bound key (so one physical device cannot count twice by mixing signed and
  unsigned), else `local:<client id>`. Never federated, counts only locally.
* The rate limit is per **calling client** (JWT subject), not per reporter, so
  alternating signed/unsigned cannot double the budget.
* Residual risk (documented, not solved — see threat model): an attacker who
  can create many device credentials (50/day per app key) or run a node and
  mint keys can still reach a threshold of 3. Mitigations: operator `ban`,
  node exclusion, per-device budget, the safety-motivated threshold being
  configurable per operator.

### D11. Switching the feature off / on

`COMMUNITY_CORRECTIONS_ENABLED=false`: endpoints not registered, reads skip the
overlay (imported values are served again), federation ignores votes (push:
`ignored`, pull worker skips the stream, the pull endpoint isn't registered),
`/v1/config` says `communityCorrections.enabled=false`. Votes and corrections
stay in the database, so switching it back on restores them. The boot sequence
persists the last-seen switch state in `static_data_state`; on a flip it bumps
the package version and appends `StaticDataUpdated` events for every segment
with an applied correction, so delta *and* package clients converge.

### D12. What a client must do

* Read `speedLimit` as before — it is already the effective value.
* Show `correctedBy` / `correction` for origin, counts, date, "needs review".
* To propose: `POST /v1/speed-limit-segments/:id/corrections`; to confirm or
  object: `POST /v1/speed-limit-corrections/:id/confirmations`. To discover
  open proposals: `GET /v1/speed-limit-corrections?tiles=…`.
* To sign: take `segmentKey` from the segment.

## Tests

| Rule | Where |
|---|---|
| Threshold (1–2 devices change nothing, 3 apply), same device ≠ 3 devices, threshold from config | `tests/unit/speed-limit-tally.test.ts`, `tests/integration/speed-limit-corrections.test.ts` |
| Competing values, tie has no winner, denial flips and re-confirmation restores, vote-order invariance (all 720 permutations) | same |
| Plausibility (range/step/unit/no-change/unknown segment/malformed) | `tests/unit/speed-limit-vote.test.ts`, integration |
| Device signature: mismatch, forged, stale, key not bound | integration |
| Rate limit per client, no-ops free, signed+unsigned share one budget | integration |
| Import never overwrites (changed value → kept + `needsReview`, unchanged → no flag, agreeing → redundant, wipe-and-reimport, votes before the segment) | integration |
| `segmentKey` formula vs. an independent implementation; migration 0007 on a populated database | `tests/integration/speed-limit-geometry-key.test.ts` |
| Distribution: lookup, nearby, snapshot, static packages, delta event, version bump | integration |
| Replication (3 servers, different row ids), denial flips everywhere, competing/tie, partition healing in different pull orders, tampered vote, implausible/future/ancient votes, unsigned stays local, feature-off peer, old push format | `tests/integration/federation-speed-limit-corrections.test.ts` |
| Feature switch: reads, endpoints, config, flip announced, threshold from env | integration |
| Operator: show, reset (+ runner-up), restore, reset --all, ban/unban | integration |

Mutation checks done by hand while writing them (each made a test fail, then
reverted): threshold off by one, key-binding check removed, unit dropped from
the overlay join, `fillMissingBaseValues` removed, vote pull disabled, vote push
disabled.

## Non-goals (as in the prompt)

No geometry / road-course corrections, no manual review UI, nothing is written
back to OSM. Also not built: expiry of *temporary* corrections (roadworks) —
a temporary limit stays until the community reverts it; worth a follow-up.
