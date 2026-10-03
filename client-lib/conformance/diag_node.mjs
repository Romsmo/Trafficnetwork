// TEMPORARY crash diagnosis for the Node FFI binding (delete once understood):
// each step is announced with a synchronous write *before* it runs, so the
// last line printed names the native call that took the process down.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, libraryVersion } from "../bindings/node/index.js";

const say = (text) => fs.writeSync(1, `${text}\n`);

say("1. libraryVersion");
say(`   -> ${libraryVersion()}`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-diag-"));
say("2. new Client");
const client = new Client({ storagePath: dir, discovery: false, nodes: ["http://127.0.0.1:1"] });
say("3. call version");
say(`   -> ${JSON.stringify(await client.call("version"))}`);
say("4. call getSyncStatus");
say(`   -> ${JSON.stringify(await client.call("getSyncStatus"))}`);
say("5. call sync (no credentials: expected an error)");
try {
  await client.call("sync");
} catch (error) {
  say(`   -> error ${error.code}`);
}
say("6. free");
client.free();
say("done");
