import {
  BaseClient,
  ClientEvent,
  ClientOptions,
  SecureStore,
  TrafficNetworkClient,
} from "../shared/index.js";

export * from "../shared/index.js";

export interface NodeClientExtras {
  /** Keeps the device's secrets here instead of in a file next to the database. */
  secureStore?: SecureStore;
  /** Path of the native library; otherwise `TRAFFICNETWORK_LIB`, then a file next to this package. */
  libraryPath?: string;
}

/** The client over the C ABI. Methods are those of {@link TrafficNetworkClient}. */
export class Client extends BaseClient implements TrafficNetworkClient {
  /** `storagePath` is a directory this client keeps its database and secrets in. */
  constructor(options: ClientOptions & { storagePath: string }, extras?: NodeClientExtras);

  onEvent(listener: ((event: ClientEvent) => void) | null): void;
  startRealtime(): void;
  stopRealtime(): void;
  free(): void;
}

/** The native library's own version string. */
export function libraryVersion(libraryPath?: string): string;
