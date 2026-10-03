// Trafficnetwork client for the browser — a thin wrapper over the
// wasm-bindgen package (`wasm-pack build --target web --out-dir pkg`), the
// browser counterpart of `bindings/node`. All the API lives in `../../shared`
// and is identical to the Node binding's; this file only loads the
// WebAssembly module and moves one `call(method, argsJson) -> resultJson`
// across it.
//
//     import { Client } from "./index.js";
//
//     const client = await Client.create({ storagePath: "my-app", credentials: {...} });
//     await client.updatePosition(52.52, 13.405);
//     await client.tick();                                       // syncs when due
//     console.log(await client.getSpeedLimitAt(52.52, 13.405));  // answered locally
//
// `storagePath` is the name of the IndexedDB database here (there is no
// filesystem); use a different one per client. What a browser can do less
// than a native build is in client-lib/docs/integration-web.md.

import init, { Client as RawClient } from "../pkg/trafficnetwork_wasm.js";

import { BaseClient, TrafficNetworkError } from "../../shared/index.js";

export * from "../../shared/index.js";

let ready = null;

/**
 * Loads the WebAssembly module (once). `Client.create` does this itself;
 * call it directly only to control where the `.wasm` file comes from
 * (`input` is whatever wasm-bindgen's `init` accepts: a URL, bytes, ...).
 */
export function initialize(input) {
  ready ??= init(input);
  return ready;
}

const CLOSED = JSON.stringify({ error: { code: "closed", message: "the client was freed" } });

/** `Client.create` rejects with the library's own `{"error": ...}` text; turn it back into an error. */
function toError(thrown) {
  if (typeof thrown === "string") {
    try {
      const parsed = JSON.parse(thrown);
      if (parsed?.error) return new TrafficNetworkError(parsed.error.code, parsed.error.message);
    } catch {
      // not an envelope: fall through
    }
    return new TrafficNetworkError("internal", thrown);
  }
  return thrown instanceof Error ? thrown : new TrafficNetworkError("internal", String(thrown));
}

export class Client extends BaseClient {
  /**
   * @param {object} options the client options; `storagePath` (the IndexedDB database name) is required
   * @param {{secureStore?: import("../../shared/index.js").SecureStore, wasm?: unknown}} [extra]
   *        `secureStore` keeps the device's secrets there instead of in `localStorage`;
   *        `wasm` is passed to {@link initialize}
   */
  static async create(options, { secureStore, wasm } = {}) {
    await initialize(wasm);
    try {
      return new Client(await RawClient.create(JSON.stringify(options), secureStore));
    } catch (thrown) {
      throw toError(thrown);
    }
  }

  constructor(raw) {
    super();
    this._raw = raw;
  }

  async _callRaw(method, argsJson) {
    if (!this._raw) return CLOSED;
    return this._raw.call(method, argsJson);
  }

  /** Calls `listener(event)` for every event. `null` removes it. */
  onEvent(listener) {
    if (!this._raw) throw new TrafficNetworkError("closed", "the client was freed");
    this._raw.onEvent(
      listener
        ? (text) => {
            try {
              listener(JSON.parse(text));
            } catch {
              // A throwing listener must not unwind into the WebAssembly module.
            }
          }
        : undefined,
    );
  }

  startRealtime() {
    if (!this._raw) throw new TrafficNetworkError("closed", "the client was freed");
    this._raw.startRealtime();
  }

  stopRealtime() {
    this._raw?.stopRealtime();
  }

  /** Releases the WebAssembly resources. Its data stays in IndexedDB. Safe to call twice. */
  free() {
    if (!this._raw) return;
    const raw = this._raw;
    this._raw = null;
    raw.stopRealtime();
    raw.free();
  }
}
