# End-to-end run — the scripts

What [`../final-report.md`](../final-report.md) was produced with. They are
the hand tools of one run, not a test suite: the automated tests are in CI.
Nothing here needs more than a fresh clone, Docker, Python, Node and a browser.

| File | Step | What it does |
|---|---|---|
| `mkclient.sh <name> <scope>` | 1–2 | runs the "Create the first client" snippet of `server/docs/installation.md` with the name and scope swapped in; prints the id and secret |
| `api.sh` | 2 | the API calls of `server/docs/api.md`: speed limit at a position, nearby, post a report, confirm |
| `native.py` | 4 | the Python wheel + the C-ABI library from the release files against the Docker stack: register, bootstrap, speed limit, post a report, receive a push, deliver a report buffered while the server was stopped |
| `browser.html` | 4 | the browser build, installed from its tarball and imported the way its README shows; driven from the browser's console as below |

## Order

```bash
git clone https://github.com/Romsmo/Trafficnetwork && cd Trafficnetwork/server
docker compose up -d --build                       # server/docs/installation.md
curl http://localhost:3000/v1/health               # {"status":"ok","database":"ok"}

export DURCHSTICH_DIR=$(mktemp -d)                 # credentials stay out of the repository
bash ../docs/durchstich/mkclient.sh alice client           > $DURCHSTICH_DIR/alice.json
bash ../docs/durchstich/mkclient.sh bob client             > $DURCHSTICH_DIR/bob.json
bash ../docs/durchstich/mkclient.sh importer bulk-import   > $DURCHSTICH_DIR/importer.json
bash ../docs/durchstich/mkclient.sh app device-registration > $DURCHSTICH_DIR/appkey.json
bash ../docs/durchstich/api.sh                     # step 2

# step 4, native — from the release files (trafficnetwork-c-abi-<v>-<platform>, the wheel):
python -m venv venv && . venv/bin/activate
pip install ./trafficnetwork-<v>-py3-none-any.whl
TRAFFICNETWORK_LIB=<unpacked archive>/libtrafficnetwork.so TN_SERVER_DIR=$PWD python ../docs/durchstich/native.py
```

## The browser steps

In an empty directory: `npm install ./trafficnetwork-client-web-<v>.tgz`, copy
`browser.html` next to `node_modules/`, `python -m http.server 8080`, open
`http://localhost:8080/browser.html`, and in the console (credentials from
`mkclient.sh browser client`; `await` works at the console's top level):

```js
await start(clientId, clientSecret)
await tn.updatePosition(52.52, 13.405); await tn.sync()              // register + bootstrap
await tn.getSpeedLimitAt(52.52, 13.405)                              // local, instant
await tn.submitReport("obstacle", 52.515, 13.390); await tn.sync()   // report
await tn.startRealtime()                                             // push; then POST a report from another credential
events                                                               // ["dataChanged", …]
// offline: `docker compose stop server`, then
await tn.submitReport("obstacle", 52.530, 13.380); await tn.sync()   // ok:false, dynamicDataError:"network", pendingWrites:1
// `docker compose start server`, then
await tn.sync()                                                      // submitted:1, pendingWrites:0
```
