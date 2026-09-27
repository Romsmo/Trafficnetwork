#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { latLngToCell } from "h3-js";
import { TestClient, loadConfig, HAZARD_TYPES } from "./core.mjs";
import { startWebServer } from "./web.mjs";

const USAGE = `Trafficnetwork test client (plain HTTP; local use only)

Usage: node src/cli.mjs [global options] <command> [args]

Commands:
  limit <lat> <lng>                       speed limit at a position (server, or local cache when offline)
  nearby <lat> <lng> [radiusM]            segments / signs / hazard reports around a position (also fills the local cache)
  sync <lat> <lng> [radiusM]              download the surroundings into the local cache
  report <type> <lat> <lng> [--speed N] [--signed]   submit a hazard report (buffered if offline). types: ${HAZARD_TYPES.join(", ")}
  confirm <reportId> [stillThere|gone]    confirm/deny a report (buffered if offline)
  flush                                   send buffered reports now
  bind-key                                bind this device's Ed25519 key (needed for --signed / federated reports)
  sync-status                             cache, outbox, push and per-server state
  network-status                          health + directory of every configured server
  watch <lat> <lng>                       print live push events around a position
  serve [--port N]                        start the local web UI (127.0.0.1 only)

Global options:
  --config <file>      default: ./local.config.json (see local.config.example.json)
  --profile <name>     simulated device, default "device-a" (use another name for a second device)
  --state-dir <dir>    default: ./state
  --only <url>         use just this one configured server (e.g. to look at node B directly)
`;

function parse(argv) {
  const opts = { config: "local.config.json", profile: "device-a", stateDir: "state", port: 4173, speed: undefined, signed: false, only: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") opts.config = argv[++i];
    else if (a === "--profile") opts.profile = argv[++i];
    else if (a === "--state-dir") opts.stateDir = argv[++i];
    else if (a === "--only") opts.only = argv[++i];
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--speed") opts.speed = Number(argv[++i]);
    else if (a === "--signed") opts.signed = true;
    else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
    else rest.push(a);
  }
  return { opts, cmd: rest[0], args: rest.slice(1) };
}

const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`); return n; };
const out = (o) => console.log(JSON.stringify(o, null, 2));

async function main() {
  const { opts, cmd, args } = parse(process.argv.slice(2));
  if (!cmd) { console.log(USAGE); return; }
  const cfgPath = resolve(opts.config);
  if (!existsSync(cfgPath)) throw new Error(`config file ${cfgPath} not found - copy local.config.example.json to local.config.json and fill in the app keys`);
  const config = loadConfig(cfgPath);
  const norm = (u) => u.replace(/\/+$/, "");
  if (opts.only) config.servers = config.servers.filter((s) => norm(s.url) === norm(opts.only));
  if (!config.servers.length) throw new Error(`--only ${opts.only}: no such server in ${cfgPath}`);
  const client = new TestClient(config, { profile: opts.profile, stateDir: opts.stateDir });

  switch (cmd) {
    case "limit": {
      const lat = num(args[0], "lat"), lng = num(args[1], "lng");
      out(await client.speedLimitAt(lat, lng));
      break;
    }
    case "nearby": {
      const lat = num(args[0], "lat"), lng = num(args[1], "lng"), radiusM = args[2] ? num(args[2], "radiusM") : 500;
      const q = `lat=${lat}&lng=${lng}&radiusM=${radiusM}`;
      const [seg, sign, haz] = await Promise.all([client.api(`/v1/speed-limit-segments/nearby?${q}`), client.api(`/v1/static-signs/nearby?${q}`), client.api(`/v1/hazard-reports/nearby?${q}`)]);
      out({
        server: seg.server, radiusM,
        segments: { count: seg.data.segments.length, sample: seg.data.segments.slice(0, 5).map((s) => ({ id: s.id, speedLimit: s.speedLimit, unit: s.speedLimitUnit, points: s.geometry.coordinates.length })) },
        signs: { count: sign.data.signs.length, sample: sign.data.signs.slice(0, 5).map((s) => ({ signType: s.signType, at: s.position.coordinates })) },
        hazardReports: haz.data.reports,
      });
      break;
    }
    case "sync": {
      const lat = num(args[0], "lat"), lng = num(args[1], "lng");
      out(await client.syncSurroundings(lat, lng, args[2] ? num(args[2], "radiusM") : undefined));
      break;
    }
    case "report": {
      const [type, la, ln] = args;
      if (!HAZARD_TYPES.includes(type)) throw new Error(`type must be one of ${HAZARD_TYPES.join(", ")}`);
      out(await client.submit({ kind: "report", type, lat: num(la, "lat"), lng: num(ln, "lng"), speedKmh: opts.speed, signed: opts.signed }));
      break;
    }
    case "confirm": {
      const kind = args[1] ?? "stillThere";
      if (!["stillThere", "gone"].includes(kind)) throw new Error("kind must be stillThere or gone");
      out(await client.submit({ kind: "confirm", reportId: args[0], confirmKind: kind }));
      break;
    }
    case "flush": out(await client.flushOutbox()); break;
    case "bind-key": out(await client.bindDeviceKey()); break;
    case "sync-status": out(client.syncStatus()); break;
    case "network-status": out(await client.networkStatus()); break;
    case "watch": {
      const lat = num(args[0], "lat"), lng = num(args[1], "lng");
      client.setPosition(lat, lng);
      client.on("event", (ev) => console.log(new Date().toISOString(), ev.type, ev.entityType, ev.entityId, JSON.stringify(ev.payload)));
      client.on("status", () => {});
      client.startPush((la, ln) => latLngToCell(la, ln, 7));
      console.log(`watching around ${lat},${lng} (Ctrl+C to stop)`);
      await new Promise(() => {});
      break;
    }
    case "serve": {
      client.startBackground();
      client.startPush((la, ln) => latLngToCell(la, ln, 7));
      await startWebServer(client, { port: opts.port });
      await new Promise(() => {});
      break;
    }
    default: console.log(USAGE); process.exitCode = 2;
  }
  if (!["watch", "serve"].includes(cmd)) client.stop();
}

main().catch((e) => { console.error("Error:", e.message ?? e); process.exit(1); });
