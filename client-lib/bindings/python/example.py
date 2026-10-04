"""Minimal Python example - see client-lib/docs/integration-python.md.

    TRAFFICNETWORK_LIB=/path/to/libtrafficnetwork.so \
    TN_NODE=http://localhost:3000 TN_CLIENT_ID=... TN_CLIENT_SECRET=... \
        python example.py
"""

import os
import tempfile

from trafficnetwork import Client, library_version

BERLIN = (52.52, 13.405)

print("native library", library_version())

# A directory this client keeps its database and secrets in; reuse the same
# one next time and it carries on where it left off.
storage = tempfile.mkdtemp(prefix="trafficnetwork-example-")

with Client(
    {
        "storagePath": storage,
        "discovery": False,
        "nodes": [os.environ.get("TN_NODE", "http://localhost:3000")],
        "credentials": {
            "type": "client",
            "clientId": os.environ["TN_CLIENT_ID"],
            "clientSecret": os.environ["TN_CLIENT_SECRET"],
        },
    }
) as client:
    client.update_position(*BERLIN)  # which map tiles to watch
    report = client.sync()  # fetch what is around
    print(f"sync ok: {str(report['ok']).lower()}, pending writes: {report['pendingWrites']}")

    # Reads never touch the network - they answer from the local copy.
    print("speed limit here:", client.get_speed_limit_at(*BERLIN))
    nearby = client.get_nearby(*BERLIN, 2000)
    print(f"{len(nearby)} things within 2 km")

    # Queued locally first (get_nearby shows it at once), sent by the next sync.
    local_id = client.submit_report("accident", *BERLIN)
    sent = client.sync()
    print(f"queued report {local_id}; sync ok: {str(sent['ok']).lower()}")
