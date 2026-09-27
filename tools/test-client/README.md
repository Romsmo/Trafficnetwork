# Test client (Launch L)

Small tool to poke a Trafficnetwork server by hand: look up speed limits, browse the surroundings on a map, file and confirm reports, watch live push events and the sync/connection state — from the command line or a local web UI. Zero secrets in code; needs Node 22+ and nothing else but one dependency (`h3-js`).

> **Not built on `client-lib`.** The tool speaks plain HTTP/WebSocket against `server/docs/api.md`. `client-lib/` is a Rust library; when this tool was written, its bindings had not started, so it could not be called from a Node/CLI tool at all. That has since changed — there is now a C-ABI and a Python binding (`client-lib/bindings/python`), and a real WebSocket transport — but no Node/JS binding yet (see `client-lib/README.md`'s "Was noch fehlt"). Once one exists, this tool should be re-based on it; until then it stays a plain-HTTP reference implementation, still useful on its own (e.g. as a second, independent client during a manual multi-node test).

## Start in three steps

```bash
cd tools/test-client
npm install                                   # one dependency: h3-js
cp local.config.example.json local.config.json   # then put an app key (scope device-registration) per server into it
node src/cli.mjs serve                        # web UI at http://127.0.0.1:4173
```

`local.config.json` is gitignored; get the app keys from `npm run create-client -- --name test-app --scope device-registration` in `server/`. Each server needs its own key (servers do not share client credentials). The tool registers an anonymous device per server on first use (`POST /v1/devices/register`) and keeps its identity, an Ed25519 device key, a local copy of the surroundings and an outbox in `state/<profile>.json` (gitignored).

A second simulated device is a second process with another profile and port: `node src/cli.mjs serve --profile device-b --port 4174`.

## Web UI

- **Map** (canvas, no tiles needed): imported speed-limit segments coloured by limit, signs as dots, reports as red markers, the segment used for the current answer thick. Drag to pan, wheel to zoom, click to set the position. Optional OSM background (checkbox; loads tiles from `tile.openstreetmap.org`, off by default).
- **Position**: click, type lat/lng, quick buttons, or draw a route ("Route zeichnen" → click points → "Fahren") and drive along it at a chosen km/h; the top-left box shows the limit there and turns red when you are faster.
- **Reports**: buttons for the six general hazard types at the current position (optionally device-signed, which makes them replicate to other nodes); confirm / deny buttons next to every report in the surroundings.
- **Status**: per-server online/offline + latency + active server, push connection, age and size of the local copy, outbox (buffered writes), recent push events.
- Only listens on `127.0.0.1`, checks the `Host` header and requires a custom header on every write, so other pages in your browser cannot drive it.

## Offline behaviour

The surroundings (3 km radius) are copied into the local state when you move/sync. With every server unreachable the map stays, the speed limit is answered from that local copy, and reports/confirmations go into the outbox and are sent automatically (retry every few seconds) once a server is back. With several servers configured the tool probes them every 5 s and switches by itself (and moves the WebSocket with it).

## CLI

```
node src/cli.mjs limit 48.1374 11.5755
node src/cli.mjs nearby 48.1374 11.5755 500
node src/cli.mjs report ice 48.138 11.576 [--signed]      # --signed needs `bind-key` once per server
node src/cli.mjs confirm <reportId> [stillThere|gone]
node src/cli.mjs sync-status | network-status | flush | bind-key
node src/cli.mjs watch 48.1374 11.5755                    # live push events
node src/cli.mjs --profile device-b --only http://localhost:3001 nearby 48.2 11.6   # one specific node
```

## Known limits

- Server-first: the server's answer wins whenever a server is reachable; the local copy is a fallback (and answers when a server has no segment near the point).
- The local copy is a radius around the last synced position, not a full region download; `client-lib`'s partition sync is the proper answer for that.
- Reports replicated between federated nodes get a different local id on each node (the cross-node event id is not exposed by the API yet), so confirmations are per node.
