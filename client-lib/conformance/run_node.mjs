// Runs conformance/scenarios.json through the Node.js binding
// (bindings/node, FFI over the C ABI):
//
//     MOCK_URL=http://127.0.0.1:18990 TRAFFICNETWORK_LIB=path/to/libtrafficnetwork.so \
//         node conformance/run_node.mjs
//
// The mock server (conformance/mock-server.mjs) has to be running. The
// scenario logic is shared with the browser run (scenario-runner.mjs).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "../bindings/node/index.js";
import { runAll } from "./scenario-runner.mjs";

const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:18990";
const scenarios = JSON.parse(fs.readFileSync(new URL("./scenarios.json", import.meta.url), "utf8"));

let directory = null;
const failed = await runAll(
  scenarios,
  {
    mockUrl: MOCK,
    storagePathFor: () => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), "tn-conformance-node-"));
      return directory;
    },
    createClient: async (options) => new Client(options),
    cleanup: async () => {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    },
  },
  "node",
);
process.exit(failed > 0 ? 1 : 0);
