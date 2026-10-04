import os
import subprocess, time, urllib.request, tempfile, sys
sys.path.insert(0, r"D:\Recent\Projects\TN\r6\Trafficnetwork\client-lib\bindings\python")
from trafficnetwork import Client
LIB=r"D:\Recent\Projects\TN\r6\Trafficnetwork\client-lib\target\release\trafficnetwork.dll"
COMPOSE=r"D:\Recent\Projects\TN\r6\Trafficnetwork\server\docker-compose.yml"
c=Client({"storagePath":tempfile.mkdtemp(prefix="r6-off-"),"discovery":False,"nodes":["http://localhost:3000"],"credentials":{"type":"client","clientId":os.environ["TN_CLIENT_ID"],"clientSecret":os.environ["TN_CLIENT_SECRET"]}},library_path=LIB)
c.update_position(52.52,13.405); c.sync()
subprocess.run(["docker","compose","-f",COMPOSE,"stop","server"],check=True,capture_output=True)
rid=c.submit_report("ice",52.5100,13.3800)
near=c.get_nearby(52.52,13.405,5000)
mine=[n for n in near if n.get("id")==rid]
print("offline own report visible+pending:", bool(mine) and mine[0].get("pending"), mine[:1])
print("offline sync:", c.sync())
subprocess.run(["docker","compose","-f",COMPOSE,"start","server"],check=True,capture_output=True)
for _ in range(60):
    try: urllib.request.urlopen("http://localhost:3000/v1/health",timeout=2); break
    except Exception: time.sleep(1)
for _ in range(10):
    r=c.sync()
    if r["ok"] and r["pendingWrites"]==0: break
    time.sleep(3)
print("after restart:", r)
c.free()
