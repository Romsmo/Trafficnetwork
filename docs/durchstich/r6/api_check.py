import os
import json, re, urllib.request, urllib.error, sys

B = "http://localhost:3000"
CID, CSEC = os.environ["TN_CLIENT_ID"], os.environ["TN_CLIENT_SECRET"]
BID, BSEC = os.environ["TN_CLIENT_ID"], os.environ["TN_CLIENT_SECRET"]
RFC = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$")
fails = []

def call(method, path, body=None, tok=None):
    req = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + tok} if tok else {})})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")

def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (" :: " + str(detail)[:200] if not cond else ""))
    if not cond: fails.append(name)

s, t = call("POST", "/v1/auth/token", {"clientId": CID, "clientSecret": CSEC})
check("auth/token 200 + accessToken string", s == 200 and isinstance(t.get("accessToken"), str), t)
tok = t["accessToken"]
s, bt = call("POST", "/v1/auth/token", {"clientId": BID, "clientSecret": BSEC}); btok = bt["accessToken"]

# seed one segment + one sign near Berlin Mitte via the public bulk-import API
s, r = call("POST", "/v1/bulk-import/speed-limit-segments", {"rows": [{
    "lineString": [[13.4000, 52.5200], [13.4100, 52.5200]], "speedLimit": 30, "speedLimitUnit": "kmh",
    "source": "osm", "sourceLicense": "ODbL"}]}, btok)
check("bulk-import segment 200 {inserted:1}", s == 200 and r.get("inserted") == 1, (s, r))

s, r = call("GET", "/v1/speed-limit?lat=52.5200&lng=13.4050", tok=tok)
check("speed-limit 200", s == 200, (s, r))
print("   speed-limit body:", json.dumps(r)[:300])
check("speed-limit speedLimit is int", isinstance(r.get("speedLimit"), int) and r["speedLimit"] == 30, r)
check("speed-limit unit 'kmh'", r.get("speedLimitUnit") == "kmh", r)
s, r2 = call("GET", "/v1/speed-limit?lat=0.5&lng=0.5", tok=tok)
check("speed-limit far away -> 404 (documented)", s == 404, (s, r2))

s, r = call("GET", "/v1/hazard-reports/nearby?lat=52.52&lng=13.405&radiusM=2000", tok=tok)
check("hazard nearby empty on fresh node: 200 + list", s == 200 and isinstance(next(iter(r.values())), list), (s, r))

s, r = call("POST", "/v1/hazard-reports", {"type": "accident", "lat": 52.5201, "lng": 13.4051}, tok)
check("hazard POST 201", s == 201, (s, r))
rep = r["report"]
check("report.id uuid", re.match(r"^[0-9a-f-]{36}$", rep["id"]) is not None, rep)
for k in ("reportedAt", "expiresAt"):
    check(f"report.{k} RFC3339", isinstance(rep.get(k), str) and RFC.match(rep[k]) is not None, rep.get(k))
check("report.confirmCount int", isinstance(rep.get("confirmCount"), int), rep)
check("report 'merged' is bool", r.get("merged") is False, r)

s, r = call("POST", "/v1/hazard-reports", {"type": "accident", "lat": 52.5201, "lng": 13.4051}, tok)
check("duplicate within 500 m -> 200 merged:true", s == 200 and r.get("merged") is True, (s, r))

s, r = call("GET", "/v1/hazard-reports/nearby?lat=52.52&lng=13.405&radiusM=2000", tok=tok)
lst = next(iter(r.values()))
check("hazard nearby now has exactly 1 report", s == 200 and len(lst) == 1, (s, r))

s, r = call("POST", f"/v1/hazard-reports/{rep['id']}/confirmations", {"confirmation": "stillThere"}, tok)
check("confirmation 2xx", s in (200, 201), (s, r))
print("   confirmation body:", json.dumps(r)[:300])

s, r = call("GET", "/v1/snapshot?tiles=" + rep["regionTile"], tok=tok)
check("snapshot snapshotSequence is NUMBER (api.md)", s == 200 and isinstance(r.get("snapshotSequence"), int), r.get("snapshotSequence"))
check("snapshot hazardReports[0].reportedAt RFC3339", RFC.match(r["hazardReports"][0]["reportedAt"]) is not None, r["hazardReports"][0]["reportedAt"])
seq = r["snapshotSequence"]
s, d = call("GET", f"/v1/delta?since=0&tiles={rep['regionTile']}", tok=tok)
check("delta nextSince is NUMBER", s == 200 and isinstance(d.get("nextSince"), int), d.get("nextSince"))
check("delta events[].occurredAt RFC3339", all(RFC.match(e["occurredAt"]) for e in d["events"]), [e.get("occurredAt") for e in d["events"]][:2])
check("delta events[].sequence NUMBER", all(isinstance(e["sequence"], int) for e in d["events"]))
s, c = call("GET", "/v1/config", tok=tok)
check("config.cameraPolicy defaultLevel 'full' by default", s == 200 and c["cameraPolicy"]["defaultLevel"] == "full", c.get("cameraPolicy"))
check("config.cameraPolicy.byCountry empty by default", c["cameraPolicy"]["byCountry"] == {}, c["cameraPolicy"]["byCountry"])
s, hh = call("GET", "/v1/health")
check("health", hh == {"status": "ok", "database": "ok"}, hh)
print("\nFAILS:", fails or "none")
sys.exit(1 if fails else 0)
