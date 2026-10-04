import os
"""Which camera coordinates leave the node, per country, over EVERY read path."""
import json, subprocess, sys, urllib.request, urllib.error, gzip

B = "http://localhost:3000"
CID, CSEC = os.environ["TN_CLIENT_ID"], os.environ["TN_CLIENT_SECRET"]
SRV = r"D:\Recent\Projects\TN\r6\Trafficnetwork\server"
CAMT = {"fixedSpeedCamera", "mobileSpeedCamera", "trailerCamera", "redLightCamera", "distanceControl"}

def country(lat, lng):
    if 47.0 <= lat <= 48.0 and 8.0 <= lng <= 9.0: return "CH"
    if 48.0 <= lat <= 49.5 and 1.5 <= lng <= 3.5: return "FR"
    if 52.0 <= lat <= 53.0 and 13.0 <= lng <= 14.0: return "DE"
    return "??"

def get(path, tok, raw=False):
    r = urllib.request.Request(B + path, headers={"Authorization": "Bearer " + tok, "Accept-Encoding": "identity"})
    try:
        with urllib.request.urlopen(r) as x:
            b = x.read()
            if x.headers.get("content-encoding") == "gzip": b = gzip.decompress(b)
            return x.status, (b if raw else json.loads(b))
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:200]

def tok():
    r = urllib.request.Request(B + "/v1/auth/token", method="POST", data=json.dumps({"clientId": CID, "clientSecret": CSEC}).encode(), headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(r).read())["accessToken"]

def cell(lat, lng, res=7):
    return subprocess.run(["node", "-e", f"console.log(require('h3-js').latLngToCell({lat},{lng},{res}))"], cwd=SRV, capture_output=True, text=True).stdout.strip()

def points(obj, acc):
    """collect every (lat,lng) in camera-ish objects found anywhere in a JSON tree"""
    if isinstance(obj, dict):
        t = obj.get("type") or obj.get("hazardType") or obj.get("cameraType")
        pos = obj.get("position")
        lat = lng = None
        if isinstance(pos, dict) and "coordinates" in pos: lng, lat = pos["coordinates"][:2]
        elif isinstance(pos, list) and len(pos) >= 2: lng, lat = pos[:2]
        elif "lat" in obj and "lng" in obj: lat, lng = obj["lat"], obj["lng"]
        if lat is not None and (t in CAMT or obj.get("cameraType") in CAMT or obj.get("_cam")):
            acc.append((t, round(lat, 5), round(lng, 5)))
        for v in obj.values(): points(v, acc)
    elif isinstance(obj, list):
        for v in obj: points(v, acc)

def summarize(label, payload):
    acc = []; points(payload, acc)
    per = {}
    for t, la, ln in acc: per.setdefault(country(la, ln), []).append((t, la, ln))
    zones = []
    def zs(o):
        if isinstance(o, dict):
            if o.get("entityType") == "cameraZone" or ("cells" in o and "cameraTypes" in o) or ("cell" in o and "cameraTypes" in o): zones.append(o)
            for v in o.values(): zs(v)
        elif isinstance(o, list):
            for v in o: zs(v)
    zs(payload)
    print(f"{label:34s} points: " + ", ".join(f"{c}={len(v)}" for c, v in sorted(per.items())) + f" | zone-objects={len(zones)}")
    return per, zones

def run():
    T = tok()
    spots = {"DE": (52.52, 13.405), "CH": (47.378, 8.542), "FR": (48.857, 2.354)}
    res = {}
    for c, (la, ln) in spots.items():
        s, j = get(f"/v1/speed-cameras/nearby?lat={la}&lng={ln}&radiusM=5000", T)
        res[f"nearby {c}"] = summarize(f"speed-cameras/nearby {c} ({s})", j)
        t = cell(la, ln)
        s, j = get(f"/v1/speed-cameras/by-tile?tile={t}&k=2", T)
        res[f"bytile {c}"] = summarize(f"speed-cameras/by-tile {c} ({s})", j)
        s, j = get(f"/v1/hazard-reports/nearby?lat={la}&lng={ln}&radiusM=5000", T)
        acc = []; points(j, acc)
        print(f"{'hazard-reports/nearby '+c+' ('+str(s)+')':34s} camera types leaked: {len(acc)}")
    tiles = ",".join(cell(*v) for v in spots.values())
    s, j = get(f"/v1/snapshot?tiles={tiles}&staticData=false", T)
    res["snapshot"] = summarize(f"snapshot ({s}) keys=" + ",".join(k for k in j), j)
    s, j = get(f"/v1/snapshot?tiles={tiles}", T)
    res["snapshot+static"] = summarize(f"snapshot+static ({s})", j)
    s, j = get(f"/v1/delta?since=0&tiles={tiles}&limit=5000", T)
    res["delta"] = summarize(f"delta ({s}) events={len(j.get('events', []))}", j)
    s, m = get("/v1/static-data/manifest", T)
    if s != 200:
        print(f"static manifest -> {s} {m}")
    else:
        allp = []; accz = []
        for p in m["partitions"]:
            s2, body = get(p["path"], T, raw=True)
            if s2 == 200:
                jb = json.loads(body); points(jb, allp)
                def zs(o):
                    if isinstance(o, dict):
                        if "cameraTypes" in o and ("cell" in o or "cells" in o or "id" in o): accz.append(o)
                        for v in o.values(): zs(v)
                    elif isinstance(o, list):
                        for v in o: zs(v)
                zs(jb)
        per = {}
        for t, la, ln in allp: per.setdefault(country(la, ln), []).append((t, la, ln))
        print(f"{'static packages ('+str(len(m['partitions']))+' tiles)':34s} points: " + ", ".join(f"{c}={len(v)}" for c, v in sorted(per.items())) + f" | zone-objects={len(accz)}")
        res["packages"] = (per, accz)
    s, c = get("/v1/config", T)
    cp = c.get("cameraPolicy"); print("config.cameraPolicy:", json.dumps({k: cp[k] for k in ("namespaceEnabled", "defaultLevel", "byCountry")}), "speedCameraNamespaceEnabled=", c.get("speedCameraNamespaceEnabled"))
    return res

if __name__ == "__main__":
    run()
