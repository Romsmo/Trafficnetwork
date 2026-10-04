import os
import sys, tempfile, json
sys.path.insert(0, r"D:\Recent\Projects\TN\r6\Trafficnetwork\client-lib\bindings\python")
from trafficnetwork import Client
LIB=r"D:\Recent\Projects\TN\r6\Trafficnetwork\client-lib\target\release\trafficnetwork.dll"
CRED={"type":"client","clientId":os.environ["TN_CLIENT_ID"],"clientSecret":os.environ["TN_CLIENT_SECRET"]}
c=Client({"storagePath":tempfile.mkdtemp(prefix="r6-cam2-"),"discovery":False,"nodes":["http://localhost:3000"],"credentials":CRED,"cameraNamespaceEnabled":True},library_path=LIB)
for name,(la,ln) in {"DE":(52.52,13.405),"CH":(47.378,8.542),"FR":(48.857,2.354)}.items():
    c.update_position(la,ln)
c.update_position(48.857,2.354); r=c.sync(); print("sync",r["ok"],r["staticDataError"],r["dynamicDataError"])
for name,(la,ln) in {"DE":(52.52,13.405),"CH":(47.378,8.542),"FR":(48.857,2.354)}.items():
    near=c.get_nearby(la,ln,8000)
    cams=[n for n in near if n.get("kind")=="hazard" and "Camera" in str(n.get("hazardType")) or n.get("kind") in ("camera","fixedSpeedCamera")]
    zones=[n for n in near if n.get("kind")=="cameraZone"]
    print(name,"kinds:",sorted({n.get("kind") for n in near}),"| single-camera items:",[(n.get("hazardType") or n.get("kind"),round(n["lat"],4),round(n["lng"],4)) for n in cams],"| zones:",len(zones), [list(z.keys()) for z in zones][:1])
print("policy:", json.dumps({k:v for k,v in c.call("getCameraPolicy",{}).items() if k!="notice"}))
