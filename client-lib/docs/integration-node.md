# Integration guide — Node.js

The same client every binding exposes (`api.md`), reached from Node through
the C ABI (`libtrafficnetwork`) with [`koffi`](https://koffi.dev) — prebuilt
binaries, so no compiler is needed on the machine that *uses* the library.
It is the same typed surface as the browser binding
(`integration-web.md`): code written against one runs against the other.

**What you need:** Node.js 18 or newer, and the native library for your
platform. Nothing is published to npm yet; you build the library from this
repository.

## Build and run the example

```bash
# 1. Build the native library (needs a Rust toolchain).
cd client-lib
cargo build -p trafficnetwork-c-abi --release
#    → target/release/libtrafficnetwork.so    (Linux)
#      target/release/libtrafficnetwork.dylib (macOS)
#      target/release/trafficnetwork.dll      (Windows)

# 2. Install the binding's one dependency (koffi).
cd bindings/node
npm install

# 3. Run the example against a server, with a credential of scope `client`
#    (in server/: npm run create-client -- --name node-example --scope client;
#    in the Docker stack: server/docs/installation.md, "Create the first client").
TRAFFICNETWORK_LIB=../../target/release/libtrafficnetwork.so \
TN_NODE=http://localhost:3000 TN_CLIENT_ID=… TN_CLIENT_SECRET=… \
  node example.mjs
```

On Windows set the variables with `$env:NAME = "value"` (PowerShell) and
point `TRAFFICNETWORK_LIB` at the `.dll`.

## The smallest possible use

```js
import { Client } from "./index.js";

const client = new Client({
  storagePath: "/var/lib/myapp/trafficnetwork", // a directory: database + secrets live here
  discovery: false,
  nodes: ["https://node.example.org"],
  credentials: { type: "client", clientId: "…", clientSecret: "…" },
});

await client.updatePosition(52.52, 13.405);          // which map tiles to watch
await client.sync();                                  // fetch what is around
console.log(await client.getSpeedLimitAt(52.52, 13.405)); // local, instant
console.log(await client.getNearby(52.52, 13.405, 2000)); // local, instant

await client.submitReport("accident", 52.52, 13.405); // queued, shown at once
await client.sync();                                  // …and sent
client.free();
```

Every method returns a Promise and rejects with a `TrafficNetworkError`
whose `code` is one of the API's error codes (`api.md`, "Errors"). TypeScript
types ship alongside (`index.d.ts`).

- **Where the library is found:** the `libraryPath` option
  (`new Client(options, { libraryPath })`), then the `TRAFFICNETWORK_LIB`
  environment variable, then a file next to `index.js`.
- **Keep it fresh:** call `client.tick()` from a timer; it is cheap and syncs
  only when due. Nothing runs by itself.
- **Live updates:** `client.startRealtime()` keeps a WebSocket open on the
  library's own background task — no thread or event loop of yours needed;
  `client.onEvent(listener)` tells you when data changed.
- **Your own secret store:** `new Client(options, { secureStore })`, an object
  with synchronous `get(key)`, `set(key, value)`, `delete(key)` — back it with
  a keychain where the platform has one. By default secrets go to a file
  (`secure-store.json`, mode 0600 on Unix) in `storagePath`.
- **Finish:** `client.free()`. The data stays on disk; a new client on the
  same `storagePath` picks up where this one left off.

## How it behaves

- **Calls run on a worker thread**, so a sync (which waits for the network)
  never freezes your event loop. Event and secret-store callbacks run on the
  JS thread whenever the event loop gets a turn — do not block the loop
  waiting for the library from inside one of them.
- **A throwing listener or store is contained:** an exception in your
  callback never unwinds into the native library (a failing store answers
  "not there"/"refused", like in every other binding).
- Do not call `free()` while a call on that client is still in flight.
- **Koffi's call stacks are sized at load.** Koffi runs each native call on a
  stack of its own, and its defaults (2 MiB sync, 128 KiB async) were far too
  small for a real sync back when the library ran the call on the calling
  thread — it overflowed with a segmentation fault on the first request.
  `index.js` raises them (`koffi.config(...)`: 8 MiB each, plus a 4 MiB async
  heap) before declaring anything. Since add-on B5 the library runs every call on
  its own 8 MiB threads and the calling thread only waits, so this is no longer
  what keeps a call alive — it stays as insurance. If your application configures
  koffi itself, do it before importing this package.

## Differences from the browser binding

Same methods, same types, same results — that is what the shared
conformance scenarios check. What differs is the environment: the Node
binding stores data in SQLite on disk with a spatial index (no memory ceiling
beyond the machine's, and it can hold a whole country's static data), writes
synchronously, and has no CORS or mixed-content rules. See
`integration-web.md` for what a browser cannot do.

## Verified in CI

`conformance-node` runs `conformance/scenarios.json` through this binding
against the scripted mock server — the same scenarios, with the same
expectations, as the Python, browser and mobile runs. `typescript-types`
compiles a typed usage of `index.d.ts`. The same job then runs the example
from this guide (`bindings/node/example.mjs`) against a mock server instance
and checks what it prints, so the steps above are known to work, not just
plausible.

## Packaging

`node bindings/pack-npm.mjs` assembles the package as a tarball that stands on
its own (`trafficnetwork-client-node-<version>.tgz`: the sources, the shared
typed surface copied in, the example, a README) — in the repository the
sources import `../shared/`, a path that does not exist once a package is
installed elsewhere, and the script points the two imports at the copy. CI
installs the tarball into an empty project and runs the example from there
(job `npm-packages`); the tarball is attached to the run.

```bash
cd client-lib
node bindings/pack-npm.mjs dist/npm
mkdir ~/try-it && cd ~/try-it && npm init -y
npm install ~/…/client-lib/dist/npm/trafficnetwork-client-node-1.0.0.tgz
```

The package does **not** contain the native library — it is per platform and
big; build it (`cargo build -p trafficnetwork-c-abi --release`, see above) or
take it from the CI run's `trafficnetwork-c-abi-<os>` artifact, and point the
package at it. The package is marked `"private": true`: `npm pack` works,
`npm publish` refuses — publishing to a registry is a decision of its own, and
nothing has been published.
