"""End-to-end step 4, the native binding: the Python wheel (ctypes over the C ABI)
and the C-ABI library of the release files, against the Docker stack — register,
bootstrap, speed limit, post a report, receive a push, deliver a report that was
buffered while the server was down. The library is used as docs/integration-python.md
describes; the server's HTTP API is used on the side to trigger and to check things.

  DURCHSTICH_DIR   directory with appkey.json (scope device-registration),
                   alice.json and bob.json (scope client)
  TN_SERVER_DIR    <fresh clone>/server (where `docker compose` runs)
  TRAFFICNETWORK_LIB  the C-ABI library from the release archive
"""

import json
import os
import random
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import trafficnetwork  # installed from the release wheel
from trafficnetwork import Client, TrafficNetworkError

BASE = os.environ.get("TN_BASE", "http://localhost:3000")
HERE = os.environ["DURCHSTICH_DIR"]
DOCKER = {"cwd": os.environ["TN_SERVER_DIR"], "check": True, "capture_output": True}
HERE_POS = (52.5200, 13.4050)
# The server merges a report of the same type near an existing one (DUPLICATE_MERGE_RADIUS_METERS),
# and so does the library; random spots make the run repeatable.
JITTER = lambda: (random.uniform(-0.012, 0.012), random.uniform(-0.012, 0.012))


def creds(name):
    return json.load(open(os.path.join(HERE, name)))


def api(method, path, token=None, body=None):
    request = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})},
    )
    with urllib.request.urlopen(request) as response:
        return json.loads(response.read())


def token_for(name):
    c = creds(name)
    return api("POST", "/v1/auth/token", body={"clientId": c["clientId"], "clientSecret": c["clientSecret"]})["accessToken"]


def server_reports():
    return api("GET", "/v1/hazard-reports/nearby?lat=52.52&lng=13.405&radiusM=3000", token_for("alice.json"))["reports"]


def line(text=""):
    print(text, flush=True)


app = creds("appkey.json")
storage = tempfile.mkdtemp(prefix="tn-durchstich-native-")
line(f"native library {trafficnetwork.library_version()}")

options = {
    "storagePath": storage,
    "discovery": False,
    "nodes": [BASE],
    # An app key (scope device-registration): the library registers the device itself.
    "credentials": {"type": "app", "appClientId": app["clientId"], "appClientSecret": app["clientSecret"]},
}

events = []
with Client(options) as client:
    client.on_event(lambda event: events.append(event))

    line("\n== 1. Register + 2. bootstrap: sync() on first use")
    client.update_position(*HERE_POS)
    report = client.sync()
    line(f"sync -> ok={report['ok']} staticDataError={report['staticDataError']} dynamicDataError={report['dynamicDataError']}")
    secrets = json.load(open(os.path.join(storage, "secure-store.json")))
    line(f"device registered: secure-store.json holds {sorted(secrets)}")
    line(f"device clientId: {secrets.get('device.clientId')} (not the app key {app['clientId']})")
    line(f"getSyncStatus -> {json.dumps(client.get_sync_status())[:300]}")

    line("\n== 3. Speed limit (local, from the bootstrap)")
    line(f"getSpeedLimitAt{HERE_POS} -> {json.dumps(client.get_speed_limit_at(*HERE_POS))}")

    line("\n== 4. Post a report")
    dlat, dlng = JITTER()
    local_id = client.submit_report("traffic", HERE_POS[0] + dlat, HERE_POS[1] + dlng)
    line(f"submitReport(traffic) -> localId {local_id[:16]}... (buffered locally, visible in getNearby at once: "
         f"{[i for i in client.get_nearby(*HERE_POS, 2000) if i.get('pending')] != []})")
    sent = client.sync()
    line(f"sync -> ok={sent['ok']} submitted={sent['submitted']} pendingWrites={sent['pendingWrites']}")
    mine = [r for r in server_reports() if r["type"] == "traffic" and r["reporterId"] == secrets["device.clientId"]]
    line(f"on the server: {[(r['type'], r['reporterId']) for r in mine]}")
    assert mine and mine[0]["reporterId"] == secrets["device.clientId"], "the report is on the server under the device id"

    line("\n== 5. Receive a push")
    client.start_realtime()
    time.sleep(2)  # let the connection come up
    before = len(events)
    api("POST", "/v1/hazard-reports", token_for("bob.json"), {"type": "construction", "lat": 52.5195, "lng": 13.4045})
    deadline = time.time() + 15
    while len(events) == before and time.time() < deadline:
        time.sleep(0.25)
    line(f"events after someone else's report: {[e.get('type') for e in events[before:]]}")
    assert len(events) > before, "no push event arrived"
    nearby = client.get_nearby(*HERE_POS, 2000)
    line(f"getNearby -> {sorted({i.get('hazardType') for i in nearby if i.get('kind') == 'hazard'})}")
    client.stop_realtime()

    line("\n== 6. Deliver a report buffered while offline")
    subprocess.run(["docker", "compose", "stop", "server"], **DOCKER)
    line("server stopped.")
    dlat, dlng = JITTER()
    queued = client.submit_report("breakdown", HERE_POS[0] + dlat, HERE_POS[1] + dlng)
    try:
        offline = client.sync()
        line(f"sync (offline) -> ok={offline['ok']} dynamicDataError={offline['dynamicDataError']} pendingWrites={offline['pendingWrites']}")
    except TrafficNetworkError as error:
        line(f"sync (offline) -> Fehler {error.code}")
    line(f"report stays visible locally: {any(i.get('pending') for i in client.get_nearby(*HERE_POS, 2000))}")
    subprocess.run(["docker", "compose", "start", "server"], **DOCKER)
    for _ in range(60):
        try:
            if api("GET", "/v1/health").get("status") == "ok":
                break
        except Exception:
            pass
        time.sleep(1)
    line("server is back.")
    later = client.sync()
    line(f"sync (online) -> ok={later['ok']} submitted={later['submitted']} pendingWrites={later['pendingWrites']}")
    delivered = [r for r in server_reports() if r["type"] == "breakdown" and r["reporterId"] == secrets["device.clientId"]]
    line(f"on the server: {[(r['type'], r['reporterId']) for r in delivered]}")
    assert delivered, "the report buffered offline did not arrive"

    line("\n== Interplay: what the library sees of the web UI and of others")
    client.sync()
    seen = sorted({i.get('hazardType') for i in client.get_nearby(*HERE_POS, 3000) if i.get('kind') == 'hazard'})
    line(f"getNearby after sync -> {seen}")

line("\nEnd-to-end run (native binding) passed.")
