// A client for a conformance *bridge*: a small program in another language
// (Kotlin today) that holds the real binding and answers one JSON request per
// line on stdin with one JSON line on stdout. This is what lets the very same
// scenario runner (scenario-runner.mjs) drive a binding that has no JS
// surface — the scenarios and their expectations are not re-implemented per
// language, so they cannot drift apart.
//
// Protocol (conformance/README.md, "Bridges"):
//   {"op":"new","options":"<json>","hostSecureStore":bool} -> {"ok":true} | {"error":{"code","message"}}
//   {"op":"call","method":"…","args":"<json>"}             -> {"result":"<envelope>"}
//   {"op":"events"}                                         -> {"count":N}
//   {"op":"free"}                                           -> {"ok":true}, then the program exits

import { spawn } from "node:child_process";
import readline from "node:readline";

import { BaseClient, TrafficNetworkError } from "../bindings/shared/index.js";

export class BridgeClient extends BaseClient {
  constructor(child) {
    super();
    this._child = child;
    this._waiting = [];
    this._lines = readline.createInterface({ input: child.stdout });
    this._lines.on("line", (line) => {
      const waiter = this._waiting.shift();
      if (waiter) waiter.resolve(JSON.parse(line));
    });
    this.exited = new Promise((resolve) => child.on("exit", resolve));
    child.on("exit", (code) => {
      for (const waiter of this._waiting.splice(0)) {
        waiter.reject(new Error(`the bridge ended unexpectedly (exit code ${code})`));
      }
    });
  }

  /** Starts the bridge and creates the client in it; rejects with a TrafficNetworkError like any binding. */
  static async create(command, args, options, { hostSecureStore = false, env = {}, cwd } = {}) {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...env },
      cwd,
    });
    const client = new BridgeClient(child);
    const reply = await client._request({
      op: "new",
      options: JSON.stringify(options),
      hostSecureStore,
    });
    if (reply.error) {
      child.stdin.end();
      throw new TrafficNetworkError(reply.error.code, reply.error.message);
    }
    return client;
  }

  _request(message) {
    return new Promise((resolve, reject) => {
      this._waiting.push({ resolve, reject });
      this._child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  async _callRaw(method, argsJson) {
    return (await this._request({ op: "call", method, args: argsJson })).result;
  }

  /** How many events the bridge's listener has been told about. */
  async eventCount() {
    return (await this._request({ op: "events" })).count;
  }

  /** Releases the client and ends the bridge; `exited` resolves once it is gone. */
  free() {
    if (this._freed) return;
    this._freed = true;
    this._request({ op: "free" }).then(
      () => this._child.stdin.end(),
      () => {},
    );
  }
}
