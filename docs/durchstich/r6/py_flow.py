import os
import json, os, subprocess, sys, tempfile, threading, time, urllib.request

sys.path.insert(0, r"D:\Recent\Projects\TN\r6\Trafficnetwork\client-lib\bindings\python")
from trafficnetwork import Client

LIB = r"D:\Recent\Projects\TN\r6\Trafficnetwork\client-lib\target\release\trafficnetwork.dll"
COMPOSE = r"D:\Recent\Projects\TN\r6\Trafficnetwork\server\docker-compose.yml"
BERLIN = (52.52, 13.405)

def api(method, path, body=None, tok=None):
    r = urllib.request.Request("http://localhost:3000" + path, method=method,
                               data=json.dumps(body).encode() if body is not None else None,
                               headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + tok} if tok else {})})
    with urllib.request.urlopen(r) as x:
        return x.status, json.loads(x.read())

def step(n, ok, msg):
    print(("PASS " if ok else "FAIL ") + n + " - " + str(msg)[:220])
    if not ok: step.fail.append(n)
step.fail = []

storage = tempfile.mkdtemp(prefix="r6-py-")
events = []
c = Client({"storagePath": storage, "discovery": False, "nodes": ["http://localhost:3000"],
            "credentials": {"type": "app", "appClientId": os.environ["TN_CLIENT_ID"],
                            "appClientSecret": os.environ["TN_CLIENT_SECRET"]}}, library_path=LIB)
c.on_event(lambda e: events.append(e))

c.update_position(*BERLIN)
rep = c.sync()
step("registration+bootstrap sync ok", rep["ok"] is True, rep)
st = c.get_sync_status()
step("sync status online", st["connection"] == "online", st)
sl = c.get_speed_limit_at(*BERLIN)
step("speed limit local = 30 kmh", sl["value"] == 30 and sl["unit"] == "kmh", sl)
near = c.get_nearby(*BERLIN, 2000)
step("nearby has the 4 server reports", len([n for n in near if n.get("kind") == "hazard"]) >= 4, [n.get("hazardType") for n in near])

# report
rid = c.submit_report("breakdown", 52.5170, 13.3950)
near = c.get_nearby(*BERLIN, 2000)
step("own report shown at once, pending", any(n.get("id") == rid and n.get("pending") for n in near), rid[:12])
rep = c.sync()
step("report sent", rep["ok"] and rep["pendingWrites"] == 0 and rep["submitted"] >= 1, rep)

# push: another client posts via REST, library must hear it without sync()
c.start_realtime()
time.sleep(3)
s, t = api("POST", "/v1/auth/token", {"clientId": os.environ["TN_CLIENT_ID"], "clientSecret": os.environ["TN_CLIENT_SECRET"]})
t0 = time.time()
api("POST", "/v1/hazard-reports", {"type": "construction", "lat": 52.5250, "lng": 13.4100}, t["accessToken"])
seen = None
while time.time() - t0 < 20:
    near = c.get_nearby(*BERLIN, 2000)
    if any(n.get("hazardType") == "construction" for n in near):
        seen = time.time() - t0; break
    time.sleep(0.2)
step("push: construction visible without sync()", seen is not None, f"after {seen:.2f}s" if seen else "never; events=%d" % len(events))
step("on_event callback fired", len(events) > 0, f"{len(events)} events")

# offline: stop server, report, restart, deliver
subprocess.run(["docker", "compose", "-f", COMPOSE, "stop", "server"], check=True, capture_output=True)
rid2 = c.submit_report("obstacle", 52.5185, 13.4020)
near = c.get_nearby(*BERLIN, 2000)
step("offline: own report visible + pending", any(n.get("id") == rid2 and n.get("pending") for n in near), "")
r_off = c.sync()
step("offline: sync reports a network problem, no crash, write kept", r_off.get("pendingWrites", 0) >= 1 or r_off["ok"] is False, r_off)
subprocess.run(["docker", "compose", "-f", COMPOSE, "start", "server"], check=True, capture_output=True)
for _ in range(60):
    try:
        urllib.request.urlopen("http://localhost:3000/v1/health", timeout=2); break
    except Exception: time.sleep(1)
delivered = False
for _ in range(10):
    r2 = c.sync()
    if r2["ok"] and r2["pendingWrites"] == 0: delivered = True; break
    time.sleep(3)
step("offline: queued report delivered after server returns", delivered, r2)
s, t = api("POST", "/v1/auth/token", {"clientId": os.environ["TN_CLIENT_ID"], "clientSecret": os.environ["TN_CLIENT_SECRET"]})
s, lst = api("GET", "/v1/hazard-reports/nearby?lat=52.52&lng=13.405&radiusM=2000", tok=t["accessToken"])
types = [r["type"] for r in list(lst.values())[0]]
step("server now has breakdown+obstacle from the library", "breakdown" in types and "obstacle" in types, types)
c.stop_realtime(); c.free()
print("FAILS:", step.fail or "none")
