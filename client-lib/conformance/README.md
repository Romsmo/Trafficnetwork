# Conformance scenarios

One set of scenarios (`scenarios.json`) that every binding has to pass with
the same expectations — that is what makes "one core, thin bindings,
identical behavior everywhere" a checked claim rather than a hope. They run
against `mock-server.mjs`, a scripted stand-in for a Trafficnetwork server
(real Ed25519 signatures and RFC 8785 canonical JSON, deliberately no
dependency on the real server's code, so a misunderstanding shared by both
cannot hide).

## Runners

| Binding | Runner | Where it runs |
|---|---|---|
| C ABI via Python | `run_python.py` | CI job `conformance-python` |
| C ABI via Node.js | `run_node.mjs` | CI job `conformance-node` |
| WebAssembly | `run_web.mjs` (drives headless Chrome) | CI job `conformance-web` |
| Kotlin (UniFFI), on a JVM | `run_bridge.mjs` + `bindings/kotlin/jvm/…/Bridge.kt` | CI job `conformance-kotlin` |
| Swift (UniFFI), on macOS | `run_bridge.mjs` + `bindings/swift/conformance/…/main.swift` | CI job `swift-package` |
| Dart (flutter_rust_bridge), on the Dart VM | `run_bridge.mjs` + `bindings/dart/bin/conformance_bridge.dart` | CI job `dart-package` |

`run_node.mjs` and `run_web.mjs` share the scenario logic in
`scenario-runner.mjs` (environment-neutral: only `fetch` and `JSON`); a
runner only supplies how to create a client and where to store its data.
Start the mock first: `node conformance/mock-server.mjs --port 18990`, then
see each runner's header for its environment variables.

## Bridges (bindings that are not JavaScript)

Kotlin, Swift and Dart have no JavaScript surface, but they must run the very
same scenarios with the very same expectations — so the scenario logic is not
rewritten per language. Instead each of them ships a small *bridge*: a
program that holds the real binding and answers one JSON request per line on
stdin with one JSON line on stdout (`bridge-client.mjs` is the Node side,
`run_bridge.mjs` the runner):

| Request | Reply |
|---|---|
| `{"op":"new","options":"<json>","hostSecureStore":false}` | `{"ok":true}` or `{"error":{"code","message"}}` |
| `{"op":"call","method":"sync","args":"<json>"}` | `{"result":"<the result envelope, as text>"}` |
| `{"op":"events"}` | `{"count":N}` — events its listener has been told about |
| `{"op":"free"}` | `{"ok":true}`, then the program ends |

A bridge knows nothing about scenarios; it moves strings across the boundary
the way an app would. With `--host-secure-store` the bridge keeps the device's
secrets in a store the *host language* implements (the Keychain/Keystore
binding's shape), so the library calling back into Kotlin, Swift or Dart is
exercised by the full scenario set too, not only by a unit test.

## Scenario format

```jsonc
{
  "name": "…",
  "servers": {                       // mock instances to create, by name
    "a": { "cameraNamespace": false, "peers": ["${b}"] }   // ${b} = an earlier server's URL
  },
  "options": { "nodes": ["${a}"], "discovery": false },    // ClientOptions; `storagePath` is added by the runner
  "steps": [ /* in order */ ]
}
```

`${name}` is replaced by that server's base URL, `${name.rootKey}` by the
public key the mock signs its network configuration with — in `servers`,
`options` and every step.

Steps:

| Step | Meaning |
|---|---|
| `{"call": "sync", "args": {…}}` | Run an API method. Then optionally `"expect"` (the result **contains** this — objects by key, lists by exact length and order, scalars equal), `"expectKeys"` (the result has these keys), `"expectSome": {"path", "match"}` (some element of `result[path]` contains `match`), or `"expectError": "network"` (it must fail with exactly that code). |
| `{"mockFail": {"server", "route", "status", "times"}}` | Make the mock answer `route` (e.g. `"POST /v1/hazard-reports"`) with `status` for the next `times` requests. |
| `{"mockLog": {"server", "route", "count"?, "bodyIncludes"?, "signatureValid"?}}` | Check what the mock saw: how often a route was asked, that the first body contains something, that every device signature on it was (in)valid. |

A binding that fails a scenario is wrong, or the difference is genuinely
platform-bound and documented in that platform's integration guide
(`../docs/integration-*.md`) — never silently skipped.
