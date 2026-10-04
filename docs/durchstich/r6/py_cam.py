import os
import sys, tempfile, json, urllib.request
sys.path.insert(0, r"D:\Recent\Projects\TN\r6\Trafficnetwork\client-lib\bindings\python")
from trafficnetwork import Client
LIB=r"D:\Recent\Projects\TN\r6\Trafficnetwork\client-lib\target\release\trafficnetwork.dll"
CRED={"type":"client","clientId":os.environ["TN_CLIENT_ID"],"clientSecret":os.environ["TN_CLIENT_SECRET"]}
def mk(extra):
    c=Client({"storagePath":tempfile.mkdtemp(prefix="r6-cam-"),"discovery":False,"nodes":["http://localhost:3000"],"credentials":CRED,**extra},library_path=LIB)
    c.update_position(52.52,13.405); r=c.sync(); assert r["ok"],r; return c
cam=lambda near:[n for n in near if n.get("hazardType") in ("fixedSpeedCamera","mobileSpeedCamera","trailerCamera","redLightCamera","distanceControl") or n.get("kind")=="cameraZone"]
a=mk({})
print("default host option, camera items in getNearby:", len(cam(a.get_nearby(52.52,13.405,5000))), "| other items:", len(a.get_nearby(52.52,13.405,5000)))
print("getCameraPolicy default:", json.dumps(a.call("getCameraPolicy",{}))[:420])
b=mk({"cameraNamespaceEnabled":True})
items=cam(b.get_nearby(52.52,13.405,5000))
print("host option ON, camera items:", [(i.get("kind"),i.get("hazardType")) for i in items])
