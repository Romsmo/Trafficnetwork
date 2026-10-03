// Runs conformance/scenarios.json through a binding that lives behind a
// conformance bridge (see bridge-client.mjs) — the Kotlin one for now:
//
//     MOCK_URL=http://127.0.0.1:18990 \
//       node conformance/run_bridge.mjs --name kotlin [--host-secure-store] [--cwd <dir>] -- <bridge command> [args…]
//
// Everything after `--` is the bridge program; its environment is this
// process's (so e.g. JAVA_OPTS reaches it); `--cwd` is where it is started
// (a Dart program is run from inside its package). The mock server
// (conformance/mock-server.mjs) has to be running.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BridgeClient } from "./bridge-client.mjs";
import { runAll } from "./scenario-runner.mjs";

const separator = process.argv.indexOf("--");
if (separator < 0 || separator === process.argv.length - 1) {
  console.error(
    "usage: run_bridge.mjs --name <label> [--host-secure-store] [--cwd <dir>] -- <bridge command> [args…]",
  );
  process.exit(2);
}
const flags = process.argv.slice(2, separator);
const [command, ...commandArgs] = process.argv.slice(separator + 1);
const nameAt = flags.indexOf("--name");
const label = nameAt >= 0 ? flags[nameAt + 1] : "bridge";
const hostSecureStore = flags.includes("--host-secure-store");
const cwdAt = flags.indexOf("--cwd");
const cwd = cwdAt >= 0 ? path.resolve(flags[cwdAt + 1]) : undefined;

const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:18990";
const scenarios = JSON.parse(fs.readFileSync(new URL("./scenarios.json", import.meta.url), "utf8"));

let directory = null;
let last = null;
const failed = await runAll(
  scenarios,
  {
    mockUrl: MOCK,
    storagePathFor: () => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), `tn-conformance-${label}-`));
      return directory;
    },
    createClient: async (options) => {
      last = await BridgeClient.create(command, commandArgs, options, { hostSecureStore, cwd });
      return last;
    },
    cleanup: async () => {
      // The bridge may still be closing the database: wait before removing it.
      if (last) await last.exited;
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    },
  },
  hostSecureStore ? `${label}, secrets in the host's store` : label,
);
process.exit(failed > 0 ? 1 : 0);
