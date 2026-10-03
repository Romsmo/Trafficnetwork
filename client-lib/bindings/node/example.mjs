// Minimal Node.js example — see client-lib/docs/integration-node.md.
//
//     TRAFFICNETWORK_LIB=/path/to/libtrafficnetwork.so \
//     TN_NODE=http://localhost:3000 TN_CLIENT_ID=… TN_CLIENT_SECRET=… \
//         node example.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, libraryVersion } from "./index.js";

const node = process.env.TN_NODE ?? "http://localhost:3000";
const BERLIN = { lat: 52.52, lng: 13.405 };

console.log(`native library ${libraryVersion()}`);

// A directory this client keeps its database and secrets in; reuse the same
// one next time and it carries on where it left off.
const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "trafficnetwork-example-"));

const client = new Client({
  storagePath,
  discovery: false,
  nodes: [node],
  credentials: {
    type: "client",
    clientId: process.env.TN_CLIENT_ID,
    clientSecret: process.env.TN_CLIENT_SECRET,
  },
});

try {
  await client.updatePosition(BERLIN.lat, BERLIN.lng); // which map tiles to watch
  const report = await client.sync(); //                    fetch what is around
  console.log(`sync ok: ${report.ok}, pending writes: ${report.pendingWrites}`);

  // Reads never touch the network — they answer from the local copy.
  console.log("speed limit here:", await client.getSpeedLimitAt(BERLIN.lat, BERLIN.lng));
  const nearby = await client.getNearby(BERLIN.lat, BERLIN.lng, 2000);
  console.log(`${nearby.length} things within 2 km`);

  // Queued locally first (getNearby shows it at once), sent by the next sync.
  const id = await client.submitReport("accident", BERLIN.lat, BERLIN.lng);
  console.log(`queued report ${id}; sync ok: ${(await client.sync()).ok}`);
} finally {
  client.free();
}
