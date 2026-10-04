import os
import json,urllib.request
def call(m,p,b=None,t=None):
    r=urllib.request.Request("http://localhost:3000"+p,method=m,data=json.dumps(b).encode() if b is not None else None,headers={"Content-Type":"application/json",**({"Authorization":"Bearer "+t} if t else {})})
    try:
        with urllib.request.urlopen(r) as x: return x.status,json.loads(x.read() or b"null")
    except urllib.error.HTTPError as e: return e.code,json.loads(e.read() or b"null")
bt=call("POST","/v1/auth/token",{"clientId":os.environ["TN_CLIENT_ID"],"clientSecret":os.environ["TN_CLIENT_SECRET"]})[1]["accessToken"]
rows=[
 {"lat":52.5200,"lng":13.4000,"source":"osm","sourceLicense":"ODbL"},                       # DE fixed
 {"lat":52.5210,"lng":13.4090,"cameraType":"redLightCamera","source":"osm","sourceLicense":"ODbL"},  # DE red light
 {"lat":47.3769,"lng":8.5417,"source":"osm","sourceLicense":"ODbL"},                       # CH fixed (Zürich)
 {"lat":47.3790,"lng":8.5450,"source":"osm","sourceLicense":"ODbL"},
 {"lat":47.3750,"lng":8.5380,"cameraType":"redLightCamera","source":"osm","sourceLicense":"ODbL"},
 {"lat":48.8566,"lng":2.3522,"source":"osm","sourceLicense":"ODbL"},                       # FR fixed (Paris)
 {"lat":48.8590,"lng":2.3560,"source":"osm","sourceLicense":"ODbL"},
 {"lat":48.8530,"lng":2.3490,"cameraType":"distanceControl","source":"osm","sourceLicense":"ODbL"},
]
print(call("POST","/v1/bulk-import/speed-cameras",{"rows":rows},bt))
tok=call("POST","/v1/auth/token",{"clientId":os.environ["TN_CLIENT_ID"],"clientSecret":os.environ["TN_CLIENT_SECRET"]})[1]["accessToken"]
for name,lat,lng in (("CH mobile",47.3800,8.5500),("FR mobile",48.8600,2.3600)):
    print(name,call("POST","/v1/hazard-reports",{"type":"mobileSpeedCamera","lat":lat,"lng":lng,"speedKmh":50},tok))
