# Client API

The one surface every binding exposes (`core/src/api/`): `TrafficNetworkClient`,
reached either as native methods (Rust) or as `call(method, argsJson) ->
resultJson` (every other binding, via the C ABI — `bindings/c-abi/src/client.rs`).
This document describes the method-by-method behaviour once, in binding-neutral
terms; a binding's own README shows the same calls in that language's idiom.

Everything here is additive on top of the earlier milestones (F-C1–F-C3):
`getNetworkStatus()` is genuinely new, everything else is the public front door
onto the sync engine, storage and write buffer that already existed.

## Starting a client

A host app creates one client per storage directory:

```
init(options: ClientOptions, platform: Platform) -> Client | Error
```

**`platform`** — the four seams the core never reaches around (`api::Platform`
in Rust; every non-native binding gets these for free via `Platform::native`,
reached through the C ABI's `storagePath` option):

| Seam | Native default | Override for |
|---|---|---|
| `store` | `SqliteStore` at `<storagePath>/trafficnetwork.db` | a browser (planned: `sqlite-wasm-rs`) |
| `secureStore` | a JSON file at `<storagePath>/secure-store.json`, mode 0600 on Unix — **not hardware-backed** | a platform keystore (Keychain, Android Keystore, ...) — see "Secrets" below |
| `http` | `reqwest`, gzip/brotli accepted, connect timeout 15 s, read timeout 60 s | a custom proxy or TLS pinning |
| `clock` | the system clock | tests (inject a fixed clock) |

**`options`** (`ClientOptions`, all fields optional, `camelCase` JSON):

| Field | Default | Meaning |
|---|---|---|
| `nodes` | `[]` | Fixed server base URLs, used directly. The only servers ever used when `discovery` is `false`. |
| `discovery` | `true` | Look the network's servers up via `GET /v1/network/directory`, starting from `seeds`. |
| `seeds` | the two built-in placeholders | Seeds to start discovery from. |
| `networkRootKey` | none built in | The network's root public key (base64url) — needed to verify a signed network configuration; without it, one is simply ignored (see "Network configuration" below). |
| `credentials` | none | See "Authentication". |
| `cameraNamespaceEnabled` | `false` | The host app's opt-in for speed cameras (one of three yeses — see "The camera namespace"). |
| `syncIntervalSeconds` | `30` | How often `tick()` syncs, at the most. |

`discovery: false` with an empty `nodes` is refused at construction (there
would be no server to ever talk to) — every other combination, including an
**empty `nodes` and `discovery: true` with no reachable seed**, is a valid
start: reads answer from the (possibly empty) local store, and `sync()`
reports a `network` error instead of hanging or crashing.

### Authentication

```
credentials: { "type": "client", "clientId": "...", "clientSecret": "..." }
           | { "type": "app", "appClientId": "...", "appClientSecret": "..." }
```

* **`client`** — a ready credential of scope `client` (a test tool, a
  server-side integration): used to fetch tokens as is.
* **`app`** — the app's own registration key (scope `device-registration`,
  provisioned once per app, `server/docs/api.md` "Device registration"). The
  first token fetch registers this device (`POST /v1/devices/register`),
  stores the resulting device `clientId`/`clientSecret` in the secure store,
  and uses that credential from then on — a second client on the same
  storage directory sees it already there and does not register again.

Either way, once a token exists the client also generates a device signing
key (if the secure store has none yet) and binds it to the server
(`POST /v1/devices/bind-key`) — best effort: without a bound key, reports and
votes are still sent, just unsigned, and are not eligible for federation
replication between servers. A device that already has a key bound elsewhere
(a reinstall that lost its key store) simply stays unsigned; nothing breaks.

### Secrets

By default, three kinds of secret live in the plain (permission-restricted)
file next to the database: the device credential, and the device's private
signing key. A host app on a platform with a real keystore should not accept
that default — pass its own store instead:

* Rust: `Platform { secure_store: Arc<dyn SecureStore>, .. }`.
* C ABI / every other binding: `tn_client_new_with_secure_store(options,
  get, set, delete, userData)` — three callbacks, called from any thread.

## Reads — never touch the network

```
getSpeedLimitAt(lat, lng, heading?) -> SpeedLimitAnswer | null
getNearby(lat, lng, radiusMeters, categories?) -> NearbyItem[]
```

Both answer from the local store alone, in well under a millisecond even on
a large dataset (see `bootstrap-measurements.md`'s lookup latencies) —
neither call ever blocks on, or fails because of, the network.

**`getSpeedLimitAt`** — the nearest segment within
`speedLimitLookupMaxDistanceMeters` (from `GET /v1/config`, default 50 m
until that has been fetched once), or `null` if nothing is close enough.
`heading` is accepted for a future heading-aware match; today the nearest
segment decides regardless. The `unit` (`"kmh"`/`"mph"`) is never converted.
`origin` says where the value comes from:

```
{ kind: "imported" }
| { kind: "locallyProposed", confirmations }   // this device's own proposal
| { kind: "communityCorrected", confirmations, needsReview }
```

`importedValue` is the import's own value while another one is in effect
(so a reverted correction is never lost). See `report_wrong_speed_limit`
below for how a proposal gets there.

**`getNearby`** — reports, signs, and (only when the camera namespace is on
— see below) cameras within `radiusMeters` (1–50,000), nearest first.
`categories` (`"hazards" | "signs" | "cameras"`) narrows the set; omitted or
empty means all three (cameras still gated). Hazard items include this
device's own not-yet-delivered reports (`pending: true`) at their submitted
position, and de-duplicate across servers: two hazard reports of the same
type within the network's `duplicateMergeRadiusMeters` are the same event
seen from two servers (each server hands out its own row id) and only the
better one — delivered over still-pending, then more confirmations — is
kept.

## Writes — queue first, sent on the next sync

```
submitReport(type, lat, lng, speedKmh?) -> localId
confirmReport(reportId, stillThere) -> localId
reportCameraRemoved(cameraId) -> localId
```

Every write is stored locally before any network call and shows up in
`getNearby` (marked `pending`) immediately — the local view is optimistic,
the network catches up. `type` must be one of the eleven hazard types
`server/docs/api.md` lists (an unrecognized one is `invalidArgument`, not
silently dropped). The queue survives a process restart (it lives in the
same store as everything else) and is flushed by the next `sync`/`tick`,
oldest first: accepted (`201`/`200`, or `409` for an assertion already
seen — either way removed from the queue), permanently rejected (any other
`4xx` — dropped, nothing to gain by retrying), or requeued (`429`, `5xx`,
network failure — tried again next time, with an incremented attempt count).
Reports and votes are (re-)signed fresh at send time, not at queue time — a
`deviceAssertion`'s timestamp window is only 60 seconds, and the whole point
of an offline queue is to outlive that.

## Speed-limit corrections

```
reportWrongSpeedLimit({ segmentId | (lat,lng), proposedValue, unit, reason? }) -> Proposal
confirmSpeedLimitCorrection({ segmentId | correction, agrees }) -> localId | null
fetchCorrections() -> Correction[]                                    // async
```

Mirrors the community-corrections flow end to end (`server/docs/
speed-limit-corrections.md`): a proposal is an **overlay**, never a change to
the imported segment, effective for this device the instant it is made
(before it is even sent), validated up front against the server's own rules
(`GET /v1/config` → `communityCorrections`: range, step, unit, "not the
imported value"). `NotOffered` (an older server, or the feature switched off)
is a normal outcome, not treated as a crash-worthy error — hide the feature
in the host app. `confirmSpeedLimitCorrection` returns `null` when the vote
only withdrew this device's own still-queued proposal (nothing left to send).
`fetchCorrections` needs the network (open proposals for "still true?"
prompts) and returns an empty list, not an error, against a server that
predates the feature.

## Position and sync

```
updatePosition(lat, lng, speedKmh?) -> { tiles, changed }
sync() -> SyncReport                                                    // async
tick() -> { synced, report? }                                           // async
planBootstrap() -> BootstrapPlan                                        // async
```

`updatePosition` computes the H3 tiles (resolution from `GET /v1/config`,
default 7) around the position — one ring normally, two from 100 km/h
(checked against real `h3-js` output, see `core/src/api/tiles.rs`) — and
marks the next sync as due when the set changed.

**Nothing runs on its own.** `sync()` runs one full cycle: token, then
configuration (an already-cached one is kept if the refresh fails), then
static data, then every pool server's own reports/delta, then the queued
writes, then the online-status refresh. The static and dynamic parts do not
hold each other up — an interrupted or still-in-progress static bootstrap
never blocks fresh reports from arriving, and one pool server failing does
not stop the others. `sync()` fails outright only when the client is closed,
has no credentials, cannot get a token at all, or **the local store is
full** (`storageFull`, from `SyncError::StorageFull` — see
`bootstrap-measurements.md`); every partial failure (one server down, the
static part behind) is reported inside a successful `SyncReport`, not thrown:

```
{ skipped, ok, staticDataError?, dynamicDataError?, submitted, rejected, pendingWrites }
```

`skipped: true` means another `sync()` was already running (calls do not
overlap). `tick()` is what a host app's own timer/heartbeat should call —
cheap, syncs only when `syncIntervalSeconds` has passed or the tiles
changed, otherwise an instant no-op.

`planBootstrap()` fetches just the manifest (a few KB) and reports what a
static-data download still needs — `partitionsPending`/`bytesPending` — so a
host app can compare that against free space *before* starting one.

## Realtime push (add-on B1)

```
startRealtime()                                  // native / C ABI: tn_client_start_realtime
stopRealtime()                                    // native / C ABI: tn_client_stop_realtime
```

Keeps a WebSocket connection to the network open (`GET /v1/ws`,
`server/docs/api.md`'s "Real-time push") and applies pushed events as they
arrive — they come out through the same `dataChanged` events a delta pull
produces (see "Events" below), so a host app never has to tell the two
apart. Reconnects on its own with backoff when a connection drops, and
closes the gap with one delta sync right after each reconnect (the
WebSocket protocol itself has no replay). A server that fails to connect,
or errors once connected, is scored down exactly like a failed HTTP
request; a *clean* close is not held against it. `stopRealtime()` (or
closing the client) stops it between attempts, not by force-ending a
connection that is currently open.

The C ABI runs this on the library's own background task — a host app
using the C ABI does not need a thread or an async runtime of its own for
push to work. The Rust API itself (`TrafficNetworkClient::run_realtime`)
is a plain `async fn` a host app can instead drive on its own task if it
already has a runtime; the C ABI's `tn_client_start_realtime`/
`tn_client_stop_realtime` are the thin wrapper every other binding uses.

**Known simplification:** the tile subscription used for a connection is
whatever `updatePosition` last set — a change made while a connection is
open takes effect on the *next* reconnect, not immediately.

## Status

```
getSyncStatus() -> SyncStatus
getNetworkStatus() -> NetworkStatus
```

`getSyncStatus` — `connection` is `"never"` / `"online"` / `"offline"`
(the last sync's outcome), plus pending-write count, watched tiles, the
server's static-data version, the last error (if any) and, if the store can
report it, its size on disk.

`getNetworkStatus` — `knownNodes` (every server the pool has ever heard of,
with tier and whether it is currently backed off), `activeNodes` (known and
not backed off), `currentNodes` (the servers actually used right now),
`directoryGeneratedAt`, `configVersion` (of the *verified* network
configuration, if any — see below), `cameraNamespaceEnabled`, and the
"currently online" figures from add-on O (`onlineNode`/`onlineNetwork`/
`onlineEstimated`/`onlineAsOf` — absent on an older server, never blocking).

### The camera namespace

Speed-camera data is shown only when **three** things all say yes:

1. the server offers it (`GET /v1/config` → `speedCameraNamespaceEnabled`),
2. a **verified** signed network configuration does not switch it off
   (`blitzerEnabled`) — unverified (no `networkRootKey` given, or the
   signature does not check out against it) is treated as "no configuration
   opinion", never as "on",
3. the host app opted in (`cameraNamespaceEnabled: true`).

The network configuration can only narrow, never widen, what the other two
allow — a forged or wrongly-signed configuration is silently ignored, not
trusted "just in case".

## Events

```
pollEvents() -> ClientEvent[]
setEventListener(callback | null)                    // native / C ABI: tn_client_set_event_callback
```

Every event both queues (drained by `pollEvents`, capped at 500 — a host
app that never polls cannot make the client grow without bound; consecutive
`bootstrapProgress` events collapse to the latest) and, if a listener is
registered, is delivered to it immediately:

```
{ type: "bootstrapProgress", partitionsTotal, partitionsDone, bytesTotal, bytesDone }
{ type: "dataChanged", entityType, entityId, eventType }
{ type: "syncCompleted", pendingWrites }
{ type: "syncFailed", code, message }
{ type: "storageFull" }
```

## Closing

```
close()
```

Every later call fails with `closed`. The store is already durable — a new
client on the same `storagePath` picks up exactly where this one left off.
(The C ABI additionally has `tn_client_free`, which releases the native
resources; call `close()`/free it once you are done with a handle, not
before.)

## Errors

Every failure is `{ code, message }` (Rust: `ApiError`); `message` is for
logs, `code` is what a host app should branch on:

| Code | Meaning |
|---|---|
| `invalidArgument` | Bad input — unknown method, wrong shape, an out-of-range value. |
| `notConfigured` | No credentials were given. |
| `notOffered` | The server does not have this feature (older, or switched off) — hide it. |
| `unknownSegment` | No such segment. |
| `storageFull` | The local store is out of space. Nothing already stored is lost; free space and call again (`planBootstrap` first, to know how much). |
| `storage` | Any other local storage failure. |
| `network` | No server could be reached, or one answered with something unusable. |
| `auth` | The server refused the credentials. |
| `rejected` | The server refused the request itself. |
| `unavailable` | The data the call needs is not there yet (e.g. sync once first). |
| `closed` | The client was closed. |
| `internal` | An internal error (in the C ABI: including a caught panic — never crosses the boundary as a crash). |

## The `call` dispatcher (every binding but Rust)

```
call(method: string, argsJson: string) -> resultJson
```

One JSON call for the whole API — `{"ok": <result>}` on success,
`{"error": {"code", "message"}}` on failure — implemented once
(`core/src/api/dispatch.rs`) and reused by every binding, so every language
sees identical method names, argument shapes and results. `method` is the
`camelCase` name from this document (`getSpeedLimitAt`, `submitReport`, ...);
`version` reports `{ apiVersion, libraryVersion }` (`apiVersion` bumps only
on an incompatible change to a method or a result shape).

### C ABI

`bindings/c-abi/src/client.rs` — an opaque handle plus:

* `tn_client_new(optionsJson, &error) -> handle | NULL`
* `tn_client_new_with_secure_store(optionsJson, get, set, delete, userData, &error) -> handle | NULL`
* `tn_client_call(handle, method, argsJson) -> resultJson` (blocking)
* `tn_client_call_async(handle, method, argsJson, callback, userData)` (returns at once, calls back from a library thread)
* `tn_client_set_event_callback(handle, callback | NULL, userData)`
* `tn_client_start_realtime(handle) -> 0 | -1` / `tn_client_stop_realtime(handle)`
* `tn_client_free(handle)`
* `tn_free_string(ptr)` — every returned string is freed with this, never the host's own `free()`.

No panic ever unwinds across the boundary — it becomes an `internal` error
result instead. See the header comment of `client.rs` for the full safety
contract, and `client_tests.rs` for the same calls exercised against a real
local HTTP server.

### Python

`bindings/python/trafficnetwork` — a `ctypes` wrapper, no dependencies, no
compiler needed on the machine that uses it. `pip install`able once the
native library is built; see `bindings/python/README.md`.

### Conformance

`client-lib/conformance/scenarios.json` is the scenario set every binding is
checked against, run against `mock-server.mjs` (a scripted server, real
Ed25519/RFC 8785, no dependency on the real server code) — cold start via a
seed's directory, failover between two configured servers, an offline
report that survives a dead server and goes out later, the camera-namespace
three-way gate including a forged network configuration, a fully
unreachable network, and the JSON-call error shapes. `run_python.py` is the
first runner; a later binding adds `run_<language>.<ext>` alongside it and
the CI job that runs it (`.github/workflows/client-lib-ci.yml`'s
`conformance-<language>` jobs).

## Network & privacy — what each server sees

The federation design (F-C0 plan, `docs/federation.md`) spreads a device's
requests over several servers on purpose, so no single operator sees a
complete movement profile. What actually crosses the wire, and to whom:

* **Position** never leaves the device as a raw coordinate. `updatePosition`
  turns it into H3 tile ids (`~2.4 km` across at the default resolution 7)
  before anything is sent; `GET /v1/delta`/`GET /v1/snapshot` are called
  with those tile ids, not with lat/lng.
* **A submitted report** (`submitReport`) carries the exact position given
  (a hazard's location *is* the report) — sent, at most, to one server per
  attempt (`request_with_failover` tries the pool in order, stops at the
  first success), signed with the device key when one is bound. An
  unsigned report is not attributable to a device across servers at all; a
  signed one carries the device's public key (pseudonymous — no name, email
  or persistent account), which lets the *same* device's reports be linked
  to each other by any server that later sees that key, but not to a
  real-world identity.
* **Static data reads** (segments, signs) name only a tile, never a device
  or a route — the same request any device asking about that tile would
  make.
* **The device credential** (`clientId`/`clientSecret`, or the bound
  signing key) is sent with every authenticated request as a bearer token /
  assertion; a server that has ever authenticated a request therefore knows
  "this credential exists and made these calls to me", but not who holds
  it. Credentials never leave the device otherwise (they live in the
  secure store — see "Secrets" — and are never logged by the library).
* **No telemetry.** The library sends nothing beyond what a call above
  describes — no usage statistics, no crash reports, no analytics
  endpoint of its own.
* **The host app decides what a user is told.** This section is a
  statement of what the library itself transmits, not a substitute for a
  privacy policy; a host app combining this library with its own account
  system, analytics, or crash reporting adds its own exposure on top.
