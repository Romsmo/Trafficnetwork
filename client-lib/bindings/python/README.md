# trafficnetwork (Python)

A thin `ctypes` wrapper of the Trafficnetwork C ABI — the local-first client
library for the Trafficnetwork traffic data network. No dependencies, no compiler
needed on the machine that uses it.

```python
from trafficnetwork import Client

with Client({
    "storagePath": "/var/lib/myapp/trafficnetwork",
    "credentials": {"type": "app", "appClientId": "…", "appClientSecret": "…"},
}) as client:
    client.update_position(52.52, 13.405)
    client.tick()                                       # syncs when due
    print(client.get_speed_limit_at(52.52, 13.405))     # answered locally
    client.submit_report("ice", 52.52, 13.405)          # queued, sent on the next sync
```

The native library is built from `client-lib/bindings/c-abi`
(`cargo build --release -p trafficnetwork-c-abi`) and found through the
`library_path` argument, the `TRAFFICNETWORK_LIB` environment variable, or a
file next to the package. Method names, arguments, results and error codes are
those of `client-lib/docs/api.md`.

Tests: `client-lib/conformance/run_python.py` runs the shared conformance
scenarios through this wrapper.
