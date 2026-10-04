import os
import json, itertools, random
from cam_probe import get, tok, cell
T = tok()
s, j = get("/v1/speed-cameras/nearby?lat=48.857&lng=2.354&radiusM=5000", T)
print("zones body:", json.dumps(j["zones"], indent=1)[:900]); print("cameras:", j["cameras"])
# the real camera positions in FR (known from seeding)
cams = [(48.8566,2.3522),(48.8590,2.3560),(48.8530,2.3490),(48.8600,2.3600)]
zoneids = {}
random.seed(7)
pts = [(48.8566+dy*0.0025, 2.3522+dx*0.0035) for dy in range(-30,31,3) for dx in range(-30,31,3)]   # ~ 8 km x 12 km grid
for (la,ln) in cams: pts += [(la,ln)]          # exactly ON a camera
for (la,ln) in pts:
    for r in (1, 50, 200, 1000, 5000):
        s, j = get(f"/v1/speed-cameras/nearby?lat={la}&lng={ln}&radiusM={r}", T)
        assert s == 200, (s, j)
        assert j["cameras"] == [], ("single camera leaked", la, ln, r, j["cameras"])
        for z in j["zones"]: zoneids.setdefault(z.get("id") or z.get("cell"), json.dumps(z, sort_keys=True))
print("queries:", len(pts)*5, "| distinct zone ids ever returned:", len(zoneids))
for k, v in zoneids.items(): print(k, v[:300])
# a zone's bodies must be identical no matter where/how it was asked (nothing refines it)
bodies = {}
for (la,ln) in pts[::17]:
    s, j = get(f"/v1/speed-cameras/nearby?lat={la}&lng={ln}&radiusM=5000", T)
    for z in j["zones"]: bodies.setdefault(z.get("id") or z.get("cell"), set()).add(json.dumps(z, sort_keys=True))
print("variants per zone id across query positions:", {k: len(v) for k, v in bodies.items()})
# by-tile with k=0..5 and snapshot/delta carry no finer info
for t in {cell(la,ln) for la,ln in cams}:
    for k in (0,1,5):
        s, j = get(f"/v1/speed-cameras/by-tile?tile={t}&k={k}", T)
        assert j["cameras"] == [], j
print("by-tile: no single cameras for FR at k=0,1,5")
