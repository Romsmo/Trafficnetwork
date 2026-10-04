// Types for the JS/TS client surface shared by `bindings/wasm` (browser) and
// `bindings/node` (Node.js). Result shapes mirror `core/src/api/types.rs`
// field for field (camelCase on the wire); client-lib/docs/api.md describes
// the behavior behind each method.

// ------------------------------------------------------------------ options

export type Credentials =
  | { type: "client"; clientId: string; clientSecret: string }
  | { type: "app"; appClientId: string; appClientSecret: string };

export interface ClientOptions {
  /** Fixed server base URLs, used directly. The only servers used when `discovery` is `false`. */
  nodes?: string[];
  /** Look servers up through `GET /v1/network/directory`, starting from `seeds`. Default `true`. */
  discovery?: boolean;
  /** Seeds to start discovery from; empty means the built-in ones. */
  seeds?: string[];
  /** The network's root public key (base64url) — needed to verify a signed network configuration. */
  networkRootKey?: string;
  credentials?: Credentials;
  /** The host app's opt-in for speed cameras (one of three yeses). Default `false`. */
  cameraNamespaceEnabled?: boolean;
  /** How often `tick()` syncs, at the most. Default 30. */
  syncIntervalSeconds?: number;
}

/**
 * Where the device's secrets live, if not in the library's own default (a
 * file in Node, `localStorage` in a browser). All three are synchronous:
 * the core reads a secret in the middle of a call. Back them with the
 * platform's keystore where there is one.
 */
export interface SecureStore {
  get(key: string): string | null | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

// ------------------------------------------------------------------ results

export type HazardType =
  | "traffic"
  | "ice"
  | "accident"
  | "construction"
  | "breakdown"
  | "obstacle"
  | "fixedSpeedCamera"
  | "mobileSpeedCamera"
  | "trailerCamera"
  | "redLightCamera"
  | "distanceControl";

export type NearbyCategory = "hazards" | "signs" | "cameras";

export type SpeedLimitUnit = "kmh" | "mph";

export type SpeedLimitOrigin =
  | { kind: "imported" }
  | { kind: "locallyProposed"; confirmations: number }
  | { kind: "communityCorrected"; confirmations: number; needsReview: boolean };

export interface SpeedLimitAnswer {
  value: number;
  unit: SpeedLimitUnit;
  segmentId: string;
  /** Names the segment on every server (what a correction refers to). */
  segmentKey: string | null;
  distanceMeters: number;
  origin: SpeedLimitOrigin;
  /** The import's own value, while another one is in effect. */
  importedValue: number | null;
}

export type NearbyItem =
  | {
      kind: "hazard";
      id: string;
      hazardType: string;
      lat: number;
      lng: number;
      distanceMeters: number;
      expiresAt: string | null;
      confirmCount: number;
      denyCount: number;
      /** Submitted from this device and not delivered to a server yet. */
      pending: boolean;
    }
  | { kind: "sign"; id: string; signType: string; lat: number; lng: number; distanceMeters: number }
  | { kind: "camera"; id: string; cameraType: string; lat: number; lng: number; distanceMeters: number };

export interface Proposal {
  segmentKey: string;
  segmentId: string;
  value: number;
  unit: SpeedLimitUnit;
  /** `"queued"` (not sent yet) or `"sent"` (the server has it). */
  state: "queued" | "sent";
  correctionId: string | null;
  confirmations: number;
}

/** An open correction another device proposed (`fetchCorrections`). Shape as the server returns it. */
export type Correction = Record<string, unknown>;

export interface PositionUpdate {
  /** The tiles watched now. */
  tiles: string[];
  /** They differ from before, so the next `tick` syncs. */
  changed: boolean;
}

export interface SyncReport {
  /** Another sync was already running; this call did nothing. */
  skipped: boolean;
  /** Every part worked. */
  ok: boolean;
  staticDataError: string | null;
  dynamicDataError: string | null;
  /** Queued writes the server accepted this time. */
  submitted: number;
  /** Queued writes a server refused for good (they are dropped). */
  rejected: number;
  /** Still waiting to be sent. */
  pendingWrites: number;
}

export interface TickResult {
  synced: boolean;
  report: SyncReport | null;
}

export interface SyncStatus {
  connection: "never" | "online" | "offline";
  lastSyncedAtUnixMs: number | null;
  pendingWrites: number;
  subscribedTiles: string[];
  staticDataVersion: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  storageBytes: number | null;
}

export interface NodeView {
  nodeId: string;
  address: string;
  tier: "probation" | "active" | "trusted";
  backedOff: boolean;
}

/** A count that never reveals a number below the server's display threshold. */
export type OnlineCount = { exact: number } | { below: number };

export interface NetworkStatus {
  knownNodes: NodeView[];
  /** Known and not backed off. */
  activeNodes: string[];
  /** The servers used right now. */
  currentNodes: string[];
  directoryGeneratedAt: string | null;
  configVersion: number | null;
  cameraNamespaceEnabled: boolean;
  onlineNode: OnlineCount | null;
  onlineNetwork: OnlineCount | null;
  onlineEstimated: boolean | null;
  onlineAsOf: string | null;
}

export interface BootstrapPlan {
  partitionsTotal: number;
  partitionsPending: number;
  bytesTotal: number;
  bytesPending: number;
}

export interface VersionInfo {
  apiVersion: number;
  libraryVersion: string;
}

export type ClientEvent =
  | {
      type: "bootstrapProgress";
      partitionsTotal: number;
      partitionsDone: number;
      bytesTotal: number;
      bytesDone: number;
    }
  | { type: "dataChanged"; entityType: string; entityId: string; eventType: string }
  | { type: "syncCompleted"; pendingWrites: number }
  | { type: "syncFailed"; code: string; message: string }
  | { type: "storageFull" };

export type ErrorCode =
  | "invalidArgument"
  | "notConfigured"
  | "notOffered"
  | "unknownSegment"
  | "storageFull"
  | "storage"
  | "network"
  | "auth"
  | "rejected"
  | "unavailable"
  | "closed"
  | "internal";

// ------------------------------------------------------------------ client

export class TrafficNetworkError extends Error {
  /** One of the API's error codes (client-lib/docs/api.md, "Errors"). */
  readonly code: ErrorCode | string;
  /** The library's own message, without the code prefix `Error.message` carries. */
  readonly detail: string;
  constructor(code: string, message: string);
}

/** Opens a `{"ok"}`/`{"error"}` envelope: its value, or a thrown {@link TrafficNetworkError}. */
export function unwrap(envelope: unknown): unknown;

export interface WrongSpeedLimitReport {
  proposedValue: number;
  unit: SpeedLimitUnit;
  /** Name the segment by id, or by position (`lat` + `lng`). */
  segmentId?: string;
  lat?: number;
  lng?: number;
  reason?: string;
}

export interface SpeedLimitVote {
  agrees: boolean;
  segmentId?: string;
  correction?: Correction;
}

/** The API, identical in every JS binding. Every method resolves with its result or rejects with a {@link TrafficNetworkError}. */
export interface TrafficNetworkClient {
  /** Runs any API method by its camelCase name. */
  call(method: string, args?: Record<string, unknown>): Promise<unknown>;

  version(): Promise<VersionInfo>;
  /** Local, never touches the network. */
  getSpeedLimitAt(lat: number, lng: number, heading?: number): Promise<SpeedLimitAnswer | null>;
  /** Local, never touches the network. Nearest first. */
  getNearby(
    lat: number,
    lng: number,
    radiusMeters: number,
    categories?: NearbyCategory[],
  ): Promise<NearbyItem[]>;
  submitReport(type: HazardType, lat: number, lng: number, speedKmh?: number): Promise<string>;
  confirmReport(reportId: string, stillThere: boolean): Promise<string>;
  reportCameraRemoved(cameraId: string): Promise<string>;
  reportWrongSpeedLimit(report: WrongSpeedLimitReport): Promise<Proposal>;
  /** Resolves `null` when the vote only withdrew this device's own still-queued proposal. */
  confirmSpeedLimitCorrection(vote: SpeedLimitVote): Promise<string | null>;
  fetchCorrections(): Promise<Correction[]>;
  updatePosition(lat: number, lng: number, speedKmh?: number): Promise<PositionUpdate>;
  /** One full sync cycle. */
  sync(): Promise<SyncReport>;
  /** Syncs if it is due, otherwise an instant no-op — cheap to call often. */
  tick(): Promise<TickResult>;
  planBootstrap(): Promise<BootstrapPlan>;
  getSyncStatus(): Promise<SyncStatus>;
  getNetworkStatus(): Promise<NetworkStatus>;
  pollEvents(): Promise<ClientEvent[]>;
  /** Closes the client: every later call fails with `closed`. */
  close(): Promise<unknown>;

  /** Calls `listener` for every event as it happens; `null` removes it. */
  onEvent(listener: ((event: ClientEvent) => void) | null): void;
  /** Keeps a WebSocket open and applies pushed events (client-lib/docs/api.md, "Realtime push"). */
  startRealtime(): void;
  stopRealtime(): void;
  /** Releases the native/WebAssembly resources. Safe to call twice. */
  free(): void;
}

export class BaseClient {
  _callRaw(method: string, argsJson: string): Promise<string>;
  call(method: string, args?: Record<string, unknown>): Promise<unknown>;
  version(): Promise<VersionInfo>;
  getSpeedLimitAt(lat: number, lng: number, heading?: number): Promise<SpeedLimitAnswer | null>;
  getNearby(
    lat: number,
    lng: number,
    radiusMeters: number,
    categories?: NearbyCategory[],
  ): Promise<NearbyItem[]>;
  submitReport(type: HazardType, lat: number, lng: number, speedKmh?: number): Promise<string>;
  confirmReport(reportId: string, stillThere: boolean): Promise<string>;
  reportCameraRemoved(cameraId: string): Promise<string>;
  reportWrongSpeedLimit(report: WrongSpeedLimitReport): Promise<Proposal>;
  confirmSpeedLimitCorrection(vote: SpeedLimitVote): Promise<string | null>;
  fetchCorrections(): Promise<Correction[]>;
  updatePosition(lat: number, lng: number, speedKmh?: number): Promise<PositionUpdate>;
  sync(): Promise<SyncReport>;
  tick(): Promise<TickResult>;
  planBootstrap(): Promise<BootstrapPlan>;
  getSyncStatus(): Promise<SyncStatus>;
  getNetworkStatus(): Promise<NetworkStatus>;
  pollEvents(): Promise<ClientEvent[]>;
  close(): Promise<unknown>;
}
