import {
  BaseClient,
  ClientEvent,
  ClientOptions,
  SecureStore,
  TrafficNetworkClient,
} from "../../shared/index.js";

export * from "../../shared/index.js";

export interface WebClientExtras {
  /** Keeps the device's secrets here instead of in `localStorage`. Synchronous. */
  secureStore?: SecureStore;
  /** Where the `.wasm` file comes from — whatever wasm-bindgen's `init` accepts (a URL, bytes, ...). */
  wasm?: unknown;
}

/** Loads the WebAssembly module (once). `Client.create` does this itself. */
export function initialize(input?: unknown): Promise<unknown>;

/** The client in the browser. Methods are those of {@link TrafficNetworkClient}. */
export class Client extends BaseClient implements TrafficNetworkClient {
  /** `storagePath` is the name of the IndexedDB database — a different one per client. */
  static create(
    options: ClientOptions & { storagePath: string },
    extras?: WebClientExtras,
  ): Promise<Client>;

  onEvent(listener: ((event: ClientEvent) => void) | null): void;
  startRealtime(): void;
  stopRealtime(): void;
  free(): void;
}
