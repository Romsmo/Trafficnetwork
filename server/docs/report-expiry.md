# Report expiry and requested duration

Scope: how long a hazard report lives, what a reporter may ask for, how a signed report gets the **same end on every
node**, and how "gone" votes end a temporary camera early. Introduced with server 1.1.0. Endpoint shapes are in
[`api.md`](api.md), the signed field in [`federation-protocol.md`](federation-protocol.md), the operator's view in
[`operating.md`](operating.md) ("Report expiry").

## Rules in force

| Type | Default | Shortest | Longest | Was |
|---|---|---|---|---|
| `mobileSpeedCamera` | **3 h** | 10 min | 12 h | 12 min |
| `trailerCamera` | **14 d** | 1 h | 30 d | 12 min (shared the short band with mobile checks) |
| `redLightCamera`, `distanceControl` (reports) | 12 min | 5 min | 6 h | unchanged |
| `traffic` | 25 min | 5 min | 6 h | unchanged |
| `accident`, `breakdown`, `obstacle` | 25 min | 10 min | 6 h | unchanged |
| `ice` | 25 min | 10 min | 12 h | unchanged |
| `construction` (user reports) | 7 d | 1 h | 90 d | unchanged |
| `fixedSpeedCamera` | never expires | — | — | unchanged; `expiresInSeconds` is refused |

* **Default** is what a report gets without a request and what every "still there" renews to (counted from the moment of
  the confirmation).
* **Shortest/longest** bound `expiresInSeconds`. A value outside is **refused**, not clamped (see below).
* The longest also bounds renewal: a confirmation sets `expiresAt` to `max(what it had, now + default)`. It never
  shortens a report that was made to live longer, and never pushes it further than `now + default`.
* Seed reports (`source: "seed"`, roadworks imported with an end date) are not governed by these bounds: they end at the
  source's end date (see "Roadworks" in [`../../ingestion/docs/roadworks.md`](../../ingestion/docs/roadworks.md)); without an end
  date they live `ttlHours` or `HAZARD_EXPIRY_CONSTRUCTION_DAYS`. They do not follow a signed `reportExpiry.construction` yet —
  Block 3 of the October work order (roadworks delivery) decides how.

## One source of truth

Every node must derive the same `expiresAt` for the same signed report, so there is exactly one effective value per type
and field. Strongest first:

1. **The signed network configuration**, field `reportExpiry` — signed offline with the network root key. A field named
   there replaces the node's own setting on every node that follows the configuration.
2. `REPORT_EXPIRY_OVERRIDES` — an isolated node's own override (JSON, same shape).
3. The per-type and band variables: `HAZARD_EXPIRY_MOBILE_SPEED_CAMERA_MINUTES`, `HAZARD_EXPIRY_TRAILER_CAMERA_DAYS`,
   `HAZARD_EXPIRY_SHORT_MINUTES` (red-light and distance only), `HAZARD_EXPIRY_MEDIUM_MINUTES`,
   `HAZARD_EXPIRY_CONSTRUCTION_DAYS`.
4. The table above, which ships with the server version.

`reportExpiry` shape (any subset; a type or field that is not named keeps the next source's value):

```json
"reportExpiry": {
  "mobileSpeedCamera": { "defaultSeconds": 10800, "minSeconds": 600, "maxSeconds": 43200 },
  "trailerCamera":     { "defaultSeconds": 1209600 }
}
```

A configuration that names an unknown type (or `fixedSpeedCamera`), an unknown field, a value that is not a whole number
of seconds between 1 and 31 536 000, or `minSeconds <= defaultSeconds <= maxSeconds` violated **stops the node** — a
signature proves who wrote the file, not that it is well-formed, and a half-applied rule would make nodes disagree. The
default always lies inside its own bounds: if a source moves the default outside them, the bound is widened to include it.

When the signed configuration replaces a value the node's own environment set to something else, the node logs one
warning per change naming both.

**To sign** (operator, offline): `npm run network:sign-config -- --root-key … --report-expiry '<json>'`. Signing again
without `--report-expiry` lifts the override (the file lists exactly what is given, like `--camera-policy`). **Nothing has
to be signed for this release**: the new defaults ship with the server version.

## Asking for a duration

`POST /v1/hazard-reports` takes an optional `expiresInSeconds` (whole seconds). Without it the type's default applies.
The bounds are published in `GET /v1/config` → `reportExpiry`.

* **Outside the bounds** → `400 EXPIRY_OUT_OF_RANGE`, `details` carries `type`, `requestedSeconds`, `defaultSeconds`,
  `minSeconds`, `maxSeconds`. Never clamped: the device signs the value it asked for, and a node that clamped it to its
  own bounds would store something the device never signed — and nodes with other bounds would disagree.
* **Signed.** The field is part of the signed device payload (`DeviceCreateEvent.expiresInSeconds`). The request field
  must equal the signed one (400 otherwise), like `type`, `lat`, `lng` and `speedKmh`.
* **No reporter gate.** Any device may ask for any duration inside the bounds. A reputation or probation gate would be
  decided per node (reputation is node-local) and make nodes disagree; the bounds, the per-device rate limit, the 500 m
  merge and the early end below limit what a spammer can pin to the map. Revisit with data.

## The end of a signed report

```
expiresAt = signed timestamp + (expiresInSeconds ?? default of the type)
```

* HTTP submit with `deviceAssertion`: the signed timestamp (already required to be within 60 s of the server clock).
* Federated event (`POST /v1/federation/events`, anti-entropy pull): the signed timestamp too. Before this version the
  node used its own clock at arrival, so an event that took 70 hours to arrive got a full new lifetime and nodes with other
  environments disagreed.
* **Already ended on arrival.** If `timestamp + duration` is not in the future, the event is rejected (`stale_timestamp`)
  instead of being stored active and expired a minute later. Not a reputation penalty for the sender.
* An unsigned report (no `deviceAssertion`) is local to its node and uses this server's clock.
* Merge: a nearby report of the same type is a confirmation of the existing one; `expiresAt` becomes the **later** of its
  current end and the new candidate. Taking the maximum of per-report candidates is order-independent, so nodes that see
  the same signed events in a different order agree.

**Rollout:** a node older than 1.1.0 ignores `expiresInSeconds` and applies its own default from arrival. Update every
node of a network before relying on durations; there is no `minVersion` bump in this release.

## "Gone" ends a temporary camera early

Before, a `gone` vote on a hazard report only counted; only fixed cameras left through votes
(`CAMERA_REMOVAL_THRESHOLD`, 3). With hours (mobile) or days (trailer) of lifetime a removed check would stay on the map
for its whole term. Now, for reports of type `mobileSpeedCamera`, `trailerCamera`, `redLightCamera`, `distanceControl`:

* the report ends when **`HAZARD_GONE_THRESHOLD_CAMERA`** (default 2) distinct devices say `gone` **and** the denials are
  at least the number of people who said it is there (the reporter counts as one: `denyCount >= confirmCount + 1`);
* it ends with the existing status `expired` and the existing event `ReportExpired` — clients need nothing new;
* a later report of the same camera at the same spot is simply a new report.

Other types are unchanged. **Votes are not federated** (needs `federationEventId` in snapshot/delta, see `docs/todo.md`):
a node keeps the report until its own end unless its own devices voted it out.

## Existing reports, retention

* **Reports that are active when a node is updated keep their `expiresAt`.** Nothing is rewritten; no migration. A later
  confirmation uses the new default.
* **Event-log retention** (`EVENT_LOG_RETENTION_DAYS_DYNAMIC`, default 3 days) is shorter than a trailer's 14 days. That
  is intended: the snapshot carries every active report with its full fields, and a client that was offline longer than
  the retention window re-bootstraps from the snapshot. Test: `tests/integration/report-expiry.test.ts`.

## Tests

`tests/unit/report-expiry.test.ts` (rules, precedence, validation), `tests/integration/report-expiry.test.ts` (defaults,
bounds, confirmations, merges, "gone", late-arriving signed events, signed network configuration).
