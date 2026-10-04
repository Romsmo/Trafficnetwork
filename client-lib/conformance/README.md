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

`run_node.mjs` and `run_web.mjs` share the scenario logic in
`scenario-runner.mjs` (environment-neutral: only `fetch` and `JSON`); a
runner only supplies how to create a client and where to store its data.
Start the mock first: `node conformance/mock-server.mjs --port 18990`, then
see each runner's header for its environment variables.

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
