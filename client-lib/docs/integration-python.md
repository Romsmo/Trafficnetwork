# Integration guide — Python

The same client every binding exposes (`api.md` describes every method), in
Python: a `ctypes` wrapper over the C ABI (`integration-c.md`) — no dependencies,
no compiler on the machine that *uses* it. Every method is the API method of the
same name in `snake_case`; `call(method, args)` runs any method by its JSON name.

**What you need:** Python 3.9 or newer, and the native library for your platform
(a Rust toolchain builds it). Nothing is published to PyPI yet; you use the
package from this repository.

## Build and run the example

All paths are relative to `client-lib/`.

```bash
# 1. The native library.
cargo build -p trafficnetwork-c-abi --release
#    → target/release/libtrafficnetwork.so      (Linux)
#      target/release/libtrafficnetwork.dylib   (macOS)
#      target/release/trafficnetwork.dll        (Windows)

# 2. Run the example against a server, with a credential of scope `client`
#    (in server/: npm run create-client -- --name py-example --scope client).
cd bindings/python
TRAFFICNETWORK_LIB=../../target/release/libtrafficnetwork.so \
TN_NODE=http://localhost:3000 TN_CLIENT_ID=… TN_CLIENT_SECRET=… \
PYTHONPATH=. python example.py
```

On Windows set the variables with `$env:NAME = "value"` (PowerShell) and point
`TRAFFICNETWORK_LIB` at the `.dll`.

## The smallest possible use

```python
from trafficnetwork import Client

with Client({
    "storagePath": "/var/lib/myapp/trafficnetwork",   # database + secrets live here
    "discovery": False,
    "nodes": ["https://node.example.org"],
    "credentials": {"type": "client", "clientId": "…", "clientSecret": "…"},
}) as client:
    client.update_position(52.52, 13.405)             # which map tiles to watch
    client.sync()                                     # fetch what is around
    print(client.get_speed_limit_at(52.52, 13.405))   # local, instant
    print(client.get_nearby(52.52, 13.405, 2000))     # local, instant

    client.submit_report("accident", 52.52, 13.405)   # queued, shown at once
    client.sync()                                     # …and sent
```

`bindings/python/example.py` is this as a complete program.

- **Where the library is found:** the `library_path` argument
  (`Client(options, library_path=…)`), then the `TRAFFICNETWORK_LIB`
  environment variable, then a file next to the package.
- **Errors:** every method raises `TrafficNetworkError`, whose `code` is one of
  the API's error codes (`api.md`, "Errors").
- **Keep it fresh:** call `client.tick()` from a timer; it is cheap and syncs only
  when due. Nothing runs by itself. `client.start_realtime()` keeps a WebSocket
  open on the library's own background task; `client.on_event(callback)` tells you
  when data changed (called from a library thread).
- **Your own secret store:** `Client(options, secure_store=…)`, an object with
  `get(key)`, `set(key, value)`, `delete(key)` — back it with a keychain where the
  platform has one. By default secrets go to a file (`secure-store.json`, mode
  0600 on Unix) in `storagePath`.
- **Finish:** leave the `with` block, or call `client.free()`. The data stays on
  disk.

Calls block the calling thread until they are done (a sync takes as long as the
network does); they run on the library's own threads, so the size of yours does
not matter. Run them in a thread or an executor if your program has an event loop.

## Verified in CI

`conformance-python` runs `conformance/scenarios.json` — the same scenarios,
with the same expectations, as every other binding — through this wrapper on
**Linux, macOS and Windows**, and runs the example above against the scripted
server, checking its output.
