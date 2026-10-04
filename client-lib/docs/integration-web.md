# Integration guide — the browser (WebAssembly)

The same client the native bindings expose (`api.md` describes every method),
compiled to WebAssembly and wrapped in a small typed JavaScript module.
Reads answer from a local copy kept in the browser; reports queue locally and
go out on the next sync.

**What you need:** a Rust toolchain (`rustup`), the WebAssembly target
(`rustup target add wasm32-unknown-unknown`), `wasm-pack`
(`cargo install wasm-pack`), and any static file server. Nothing here is
published to npm yet — you build the package from this repository (packaging
is described at the end).

## Build and run the example

```bash
# 1. Build the WebAssembly package (writes client-lib/bindings/wasm/pkg/).
cd client-lib/bindings/wasm
wasm-pack build --target web --out-dir pkg
# (If it stops with "failed to download … binaryen" — a proxy or no network for the wasm-opt step —
#  add --no-opt: the package works, it is only not size-optimised.)

# 2. Serve client-lib/bindings/ — the example imports ../js/index.js, which
#    imports ../pkg/ and ../../shared/, so all three must be reachable.
cd ..
python -m http.server 8080
```

Open <http://localhost:8080/wasm/example/>. It asks for a server and a
credential, then connects, syncs and shows what is around Berlin. To try it
against the reference server: start it (`server/README.md`), create a
credential with `npm run create-client -- --name browser-example --scope client`
in `server/` (in the Docker stack: the snippet in `server/docs/installation.md`,
"Create the first client"), and paste the id and secret into the page. The reference
server answers cross-origin requests; any other server you point a browser
at must too (see "What a browser cannot do").

## The smallest possible use

```html
<script type="module">
  import { Client } from "./js/index.js";

  const client = await Client.create({
    storagePath: "my-app", // the IndexedDB database name — one per client
    discovery: false,
    nodes: ["https://node.example.org"],
    credentials: { type: "client", clientId: "…", clientSecret: "…" },
  });

  await client.updatePosition(52.52, 13.405);   // which map tiles to watch
  await client.sync();                          // fetch what is around
  console.log(await client.getSpeedLimitAt(52.52, 13.405)); // local, instant
  console.log(await client.getNearby(52.52, 13.405, 2000)); // local, instant

  await client.submitReport("accident", 52.52, 13.405); // queued, shown at once
  await client.sync();                                  // …and sent
</script>
```

Every method returns a Promise and rejects with a `TrafficNetworkError`
whose `code` is one of the API's error codes (`api.md`, "Errors"). TypeScript
types ship alongside (`js/index.d.ts`); the same code type-checks against the
Node binding, because both implement one shared interface.

Things a page usually wants on top of that:

- **Keep it fresh:** call `client.tick()` from a timer (`setInterval`, every
  few seconds). It is cheap and syncs only when due. Nothing runs by itself.
- **Live updates:** `client.startRealtime()` opens a WebSocket and applies
  pushed events; `client.onEvent(listener)` tells you when data changed.
- **Your own secret store:** `Client.create(options, { secureStore })`, an
  object with synchronous `get(key)`, `set(key, value)`, `delete(key)`.
- **Finish:** `client.free()` releases the WebAssembly memory. Stored data
  stays in IndexedDB.

## What a browser cannot do (or does worse) than a native build

These are real differences, not omissions waiting to be fixed:

1. **Persistence trails memory.** The whole local store lives in memory and
   is mirrored to IndexedDB in the background — writes within 250 ms share
   one snapshot. A tab that crashes inside that window (plus the IndexedDB
   write itself) loses those writes' persistence. The session's own data is
   never affected. Native builds write to SQLite synchronously.
2. **Data volume.** Because the store is held in memory *and* written as one
   record, cost grows with what it holds. That suits a region's reports and a
   modest static dataset. It does **not** suit "all static data of a country
   or Europe on this device" — use `planBootstrap()` to see the size before
   starting, and see `bootstrap-measurements.md` for the native numbers
   (hundreds of MB for Bavaria alone). A native `SqliteStore` is the
   backend for that; a browser should limit itself to small regions.
3. **One tab per database.** Every tab holds its own in-memory copy and
   writes the whole snapshot; two tabs on the same `storagePath` overwrite
   each other (last writer wins). Use one tab, or coordinate (a
   `BroadcastChannel`, a lock) in your page.
4. **Secrets are weaker.** There is no browser keystore. By default the
   device credential and signing key sit in `localStorage`, readable by any
   script of the same origin; a `secureStore` you supply is only as good as
   what you back it with (it must be synchronous, which rules out WebCrypto
   storage). A page serving third-party scripts should not hold long-lived
   credentials this way.
5. **No background work.** A tab that is hidden or closed does not sync;
   timers are throttled in background tabs. There is no service-worker mode.
6. **Cross-origin rules apply.** The page may only call servers that send
   CORS headers (the reference server does), and an `https://` page cannot
   call an `http://` server (mixed content). Seeds and nodes must be
   `https://` for a page served over `https://`.
7. **No spatial index.** Position lookups scan with a bounding-box
   pre-filter instead of SQLite's R\*Tree — fine for a region, slow for a
   whole country (the same reason as 2).
8. **Hard-wired choices a native build can change:** IndexedDB (not OPFS —
   OPFS's synchronous access only works in a dedicated Worker, which would
   have forced a worker-and-message-bridge architecture on every page using
   the library) and the browser's own `fetch()`/`WebSocket` (no custom TLS
   or proxy settings).

## Verified in CI

- `wasm-test` runs the IndexedDB store's tests inside headless Chrome (a real
  IndexedDB).
- `conformance-web` runs `conformance/scenarios.json` — the scenario set
  every binding must pass — through this binding in headless Chrome, against
  the scripted mock server, with the same expectations as every other
  binding.
- `conformance-web` then opens this guide's example page
  (`wasm/example/`) in the same headless Chrome, fills in the form, and checks
  that it syncs, shows a speed limit and nearby items, and queues a report —
  so the build-and-serve steps above are known to work, not just plausible.
- `typescript-types` compiles a typed usage of the `.d.ts` files.

## Packaging

`wasm-pack build --target web` produces a self-contained package directory
(`pkg/`: the `.wasm`, its JavaScript loader and `.d.ts`). The wrapper in `js/`
and the shared module in `../shared/` are plain ES modules; bundlers (Vite,
webpack, esbuild) handle them as they are.

`node bindings/pack-npm.mjs` (after the `wasm-pack build` above) assembles
`@trafficnetwork/client-web` as a tarball that stands on its own
(`trafficnetwork-client-web-<version>.tgz`: wrapper, types, the WebAssembly
package, the shared typed surface copied in, the example page, a README); in
the repository the wrapper imports `../pkg/` and `../../shared/`, paths the
script points at the copies inside the package. CI installs the tarball into
an empty project, serves the installed package and opens its example page in
headless Chrome (job `npm-packages`); the tarball is attached to the run.
The package is marked `"private": true` — nothing has been published to a
registry.
