// Trafficnetwork client for Node.js — FFI over the C ABI (`libtrafficnetwork`)
// through `koffi` (prebuilt binaries, no compiler needed on the machine that
// uses it), the Node counterpart of `bindings/python`. All the actual API
// lives in `../shared` and is identical to the browser binding's; this file
// only moves one `call(method, argsJson) -> resultJson` across the FFI line.
//
//     import { Client } from "@trafficnetwork/client-node";
//
//     const client = new Client({ storagePath: "/var/lib/myapp/trafficnetwork", credentials: {...} });
//     await client.updatePosition(52.52, 13.405);
//     await client.tick();                                  // syncs when due
//     console.log(await client.getSpeedLimitAt(52.52, 13.405)); // answered locally
//
// The native library is found through, in this order: the `libraryPath`
// option, the `TRAFFICNETWORK_LIB` environment variable, and a file next to
// this package.

import path from "node:path";
import { fileURLToPath } from "node:url";

import koffi from "koffi";

import { BaseClient, TrafficNetworkError, unwrap } from "../shared/index.js";

export * from "../shared/index.js";

const EventCallback = koffi.proto("void TnEventCallback(void *userData, const char *eventJson)");
const SecureGet = koffi.proto(
  "int TnSecureGet(void *userData, const char *key, void *buffer, int capacity)",
);
const SecureSet = koffi.proto("int TnSecureSet(void *userData, const char *key, const char *value)");
const SecureDelete = koffi.proto("int TnSecureDelete(void *userData, const char *key)");

function libraryNames() {
  if (process.platform === "win32") return ["trafficnetwork.dll"];
  if (process.platform === "darwin") return ["libtrafficnetwork.dylib"];
  return ["libtrafficnetwork.so"];
}

function bind(lib) {
  return {
    clientNew: lib.func("void *tn_client_new(const char *optionsJson, _Out_ void **errorJson)"),
    clientNewWithSecureStore: lib.func(
      "void *tn_client_new_with_secure_store(const char *optionsJson, TnSecureGet *get, " +
        "TnSecureSet *set, TnSecureDelete *del, void *userData, _Out_ void **errorJson)",
    ),
    clientCall: lib.func("void *tn_client_call(void *client, const char *method, const char *argsJson)"),
    clientSetEventCallback: lib.func(
      "void tn_client_set_event_callback(void *client, TnEventCallback *callback, void *userData)",
    ),
    clientStartRealtime: lib.func("int tn_client_start_realtime(void *client)"),
    clientStopRealtime: lib.func("void tn_client_stop_realtime(void *client)"),
    clientFree: lib.func("void tn_client_free(void *client)"),
    libraryVersion: lib.func("void *tn_library_version()"),
    freeString: lib.func("void tn_free_string(void *text)"),
  };
}

const loaded = new Map();

function load(libraryPath) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [];
  if (libraryPath) candidates.push(libraryPath);
  if (process.env.TRAFFICNETWORK_LIB) candidates.push(process.env.TRAFFICNETWORK_LIB);
  for (const name of libraryNames()) candidates.push(path.join(here, name));
  let lastError = null;
  for (const candidate of candidates) {
    if (loaded.has(candidate)) return loaded.get(candidate);
    try {
      const native = bind(koffi.load(candidate));
      loaded.set(candidate, native);
      return native;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    "the trafficnetwork native library was not found (set TRAFFICNETWORK_LIB); " +
      `tried ${JSON.stringify(candidates)}: ${lastError}`,
  );
}

/** Copies a library-allocated string and frees it (with the library's own free, never `free()`). */
function take(native, pointer) {
  if (!pointer) throw new TrafficNetworkError("internal", "the library returned no result");
  try {
    return koffi.decode(pointer, "char", -1);
  } finally {
    native.freeString(pointer);
  }
}

export function libraryVersion(libraryPath) {
  const native = load(libraryPath);
  return take(native, native.libraryVersion());
}

const CLOSED = JSON.stringify({ error: { code: "closed", message: "the client was freed" } });

export class Client extends BaseClient {
  /**
   * @param {object} options the client options; `storagePath` (a directory) is required
   * @param {{secureStore?: import("../shared/index.js").SecureStore, libraryPath?: string}} [extra]
   *        `secureStore` keeps the device's secrets there instead of in a file
   */
  constructor(options, { secureStore, libraryPath } = {}) {
    super();
    this._native = load(libraryPath);
    this._handle = null;
    this._eventCallback = null;
    this._secureCallbacks = [];
    const encoded = JSON.stringify(options);
    const error = [null];
    let handle;
    if (secureStore) {
      const [get, set, del] = this._registerSecureStore(secureStore);
      handle = this._native.clientNewWithSecureStore(encoded, get, set, del, null, error);
    } else {
      handle = this._native.clientNew(encoded, error);
    }
    if (!handle) {
      this._releaseSecureStore();
      unwrap(JSON.parse(take(this._native, error[0])));
      throw new TrafficNetworkError("internal", "the client could not be created");
    }
    this._handle = handle;
  }

  _registerSecureStore(store) {
    // A store that fails answers "not there" / "refused", like every other binding.
    const get = koffi.register((_user, key, buffer, capacity) => {
      try {
        const value = store.get(key);
        if (value === null || value === undefined) return -1;
        const bytes = Buffer.from(value, "utf8");
        if (bytes.length >= capacity) return -1;
        koffi.encode(buffer, "uint8_t", [...bytes, 0], bytes.length + 1);
        return bytes.length;
      } catch {
        return -1;
      }
    }, koffi.pointer(SecureGet));
    const set = koffi.register((_user, key, value) => {
      try {
        store.set(key, value);
        return 0;
      } catch {
        return 1;
      }
    }, koffi.pointer(SecureSet));
    const del = koffi.register((_user, key) => {
      try {
        store.delete(key);
        return 0;
      } catch {
        return 1;
      }
    }, koffi.pointer(SecureDelete));
    this._secureCallbacks = [get, set, del];
    return this._secureCallbacks;
  }

  _releaseSecureStore() {
    for (const callback of this._secureCallbacks) koffi.unregister(callback);
    this._secureCallbacks = [];
  }

  /** One API call on a worker thread, so a sync never freezes the event loop. */
  _callRaw(method, argsJson) {
    if (!this._handle) return Promise.resolve(CLOSED);
    return new Promise((resolve, reject) => {
      this._native.clientCall.async(this._handle, method, argsJson, (error, pointer) => {
        if (error) return reject(error);
        try {
          return resolve(take(this._native, pointer));
        } catch (failure) {
          return reject(failure);
        }
      });
    });
  }

  /** Calls `listener(event)` for every event, whenever the event loop gets a turn. `null` removes it. */
  onEvent(listener) {
    if (!this._handle) throw new TrafficNetworkError("closed", "the client was freed");
    const previous = this._eventCallback;
    if (listener === null || listener === undefined) {
      this._native.clientSetEventCallback(this._handle, null, null);
      this._eventCallback = null;
    } else {
      const callback = koffi.register((_user, text) => {
        try {
          listener(JSON.parse(text));
        } catch {
          // A throwing listener must not unwind into the native library.
        }
      }, koffi.pointer(EventCallback));
      this._native.clientSetEventCallback(this._handle, callback, null);
      this._eventCallback = callback;
    }
    // Only after the library holds the new one (or none): never leave it
    // pointing at a trampoline that no longer exists.
    if (previous !== null) koffi.unregister(previous);
  }

  startRealtime() {
    if (!this._handle) throw new TrafficNetworkError("closed", "the client was freed");
    if (this._native.clientStartRealtime(this._handle) !== 0) {
      throw new TrafficNetworkError("internal", "realtime push could not be started");
    }
  }

  stopRealtime() {
    if (this._handle) this._native.clientStopRealtime(this._handle);
  }

  /** Releases the client. Its data stays on disk. Safe to call twice. */
  free() {
    if (!this._handle) return;
    const handle = this._handle;
    this._handle = null;
    // Detach the event callback first: the library may still emit while it
    // winds down, and must not call a trampoline we are about to release.
    this._native.clientSetEventCallback(handle, null, null);
    this._native.clientFree(handle);
    if (this._eventCallback !== null) koffi.unregister(this._eventCallback);
    this._eventCallback = null;
    this._releaseSecureStore();
  }
}
