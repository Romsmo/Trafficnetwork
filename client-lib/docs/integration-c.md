# Integration guide — C (Linux, macOS, Windows)

The client library as a C library: `libtrafficnetwork`, one small header, one
function that runs any API method by name with JSON in and JSON out. Everything
else — Python, Node.js, and the other guides' languages — is a thin wrapper
around exactly these functions, so a method name, an argument shape or an error
is what `api.md` says everywhere. Use this guide from C, C++, Go, Zig —
anything that can load a C library.

**What you need:** a Rust toolchain (`rustup`) to build the library, `cbindgen`
(`cargo install --locked cbindgen`) to generate the header, and a C compiler.
Nothing is published yet; you build the library from this repository (CI builds
it on Linux, macOS and Windows and attaches each build to the run).

## Build and run the example

All paths are relative to `client-lib/`.

```bash
# 1. The library.
cargo build -p trafficnetwork-c-abi --release
#    → target/release/libtrafficnetwork.so     (Linux)
#      target/release/libtrafficnetwork.dylib  (macOS)
#      target/release/trafficnetwork.dll       (Windows; with trafficnetwork.dll.lib, its import library)

# 2. The header.
(cd bindings/c-abi && cbindgen --config cbindgen.toml --output trafficnetwork.h)

# 3. The example, compiled and linked against it.
cd bindings/c-abi/example
cc example.c -I.. -L../../../target/release -ltrafficnetwork -o example           # Linux, macOS
gcc example.c -I.. ../../../target/release/trafficnetwork.dll -o example.exe      # Windows (MinGW; with MSVC: cl example.c /I.. trafficnetwork.dll.lib)

# 4. Run it against a server, with a credential of scope `client`
#    (in server/: npm run create-client -- --name c-example --scope client;
#    in the Docker stack: server/docs/installation.md, "Create the first client").
#    The library has to be findable: LD_LIBRARY_PATH (Linux), DYLD_LIBRARY_PATH
#    (macOS), or next to the executable (Windows).
LD_LIBRARY_PATH=../../../target/release \
TN_NODE=http://localhost:3000 TN_CLIENT_ID=… TN_CLIENT_SECRET=… ./example
```

## The smallest possible use

```c
#include "trafficnetwork.h"

char *error = NULL;
void *client = tn_client_new(
    "{\"storagePath\": \"/var/lib/myapp/trafficnetwork\", \"discovery\": false,"
    " \"nodes\": [\"https://node.example.org\"],"
    " \"credentials\": {\"type\": \"client\", \"clientId\": \"…\", \"clientSecret\": \"…\"}}",
    &error);
if (client == NULL) { /* `error` holds {"error": {...}} */ tn_free_string(error); return 1; }

char *result = tn_client_call(client, "updatePosition", "{\"lat\": 52.52, \"lng\": 13.405}");
tn_free_string(result);                        /* which map tiles to watch */
result = tn_client_call(client, "sync", "{}"); /* fetch what is around */
tn_free_string(result);
result = tn_client_call(client, "getSpeedLimitAt", "{\"lat\": 52.52, \"lng\": 13.405}");
printf("%s\n", result);                        /* {"ok": …}, answered locally */
tn_free_string(result);

tn_client_free(client);                        /* the data stays on disk */
```

`bindings/c-abi/example/example.c` is this as a complete program. The rules:

- **One call, JSON in, JSON out:** `tn_client_call(client, method, argsJson)`
  returns `{"ok": <result>}` or `{"error": {"code", "message"}}` — never a crash;
  a panic inside the library becomes an `internal` error. `argsJson` may be
  `NULL` or empty for a method without arguments. Parse the result with any
  JSON library; the codes are in `api.md`, "Errors".
- **Ownership:** every string the library returns is freed with
  `tn_free_string`, never with your own `free()` (the allocators may differ).
  Strings you pass in stay yours.
- **Threads:** a client may be used from any thread, several at once. A call
  runs on one of the library's own threads (8 MiB stacks) and the calling thread
  only waits — your thread's stack size does not matter. `tn_client_call`
  blocks until the call is done (a sync takes as long as the network does);
  `tn_client_call_async` returns at once and calls back from a library thread.
- **`tn_client_new` fails** with `NULL` and, if you pass a pointer, an error
  string in `{"error": …}` form.
- **Keep it fresh:** call `tick` from a timer; it is cheap and syncs only when due.
  Nothing runs by itself. `tn_client_start_realtime` keeps a WebSocket open on
  the library's own background task; `tn_client_set_event_callback` tells you
  when data changed (from a library thread — copy the string, it is valid only
  during the call).
- **Your own secret store:** `tn_client_new_with_secure_store` takes three
  callbacks (`get`, `set`, `delete`) backed by your platform's keystore; they
  may be called from any thread. Without one, secrets live in a file
  (`secure-store.json`, mode 0600 on Unix) in `storagePath`.

## How it behaves

- **TLS** trusts the Mozilla root certificates bundled in the library, not the
  operating system's store — the same on all three platforms (`api.md`,
  "Network & privacy").
- **Storage** is SQLite on disk with a spatial index; a whole country's static
  data fits (`planBootstrap` tells you the size first).
- **Windows:** the DLL is `trafficnetwork.dll`; put it next to your executable
  (or on `PATH`). The import library is `trafficnetwork.dll.lib`.

## Verified in CI

`c-abi` (Linux, macOS, Windows): the library builds and the crate's own tests
(which call these functions against a real local HTTP server) pass, on all
three; the release library is kept as an artifact. The example above is compiled
with the platform's C compiler and run against the scripted server
(`conformance/mock-server.mjs`), and its output is checked. `conformance-python`
runs the shared scenario set — the same scenarios every binding passes — through
this C ABI on all three platforms.
