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
  /** How long a fetched server configuration is used before it is fetched again (default 120); also how long a change of the camera policy can go unnoticed. */
  configRefreshSeconds?: number;
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
  | { kind: "camera"; id: string; cameraType: string; lat: number; lng: number; distanceMeters: number }
  | {
      /**
       * A coarse area in which cameras of some kinds exist — all a country at
       * level `zones` lets through. Draw `outline` as an area, not a pin: there
       * is no position of a single camera.
       */
      kind: "cameraZone";
      id: string;
      /** The H3 index of the cell. */
      cell: string;
      resolution: number;
      /** The cell's outline as `[lng, lat]` positions (the outer ring). */
      outline: [number, number][];
      /** The kinds of camera present, sorted. */
      cameraTypes: string[];
      /** 0 when the position is inside the zone. */
      distanceMeters: number;
    };

/** How much of a camera a country allows: nothing, a coarse area, the camera itself. */
export type CameraLevel = "off" | "zones" | "full";

/** What the camera policy of the network allows right now (client-lib/docs/api.md, "Camera policy"). */
export interface CameraPolicy {
  /** The host's own switch (the `cameraNamespaceEnabled` option) — off unless the host turned it on. */
  hostEnabled: boolean;
  /** Cameras (or zones) are shown by `getNearby` right now: the host switch is on and the policy lets something through. */
  active: boolean;
  /** The emergency brake is released. `false`: every country is off. */
  enabled: boolean;
  /** The most any country allows: `off` shows nothing, `zones` only zones, `full` individual cameras too. */
  maxLevel: CameraLevel;
  /** The level of every country not in `byCountry`. */
  defaultLevel: CameraLevel;
  /** ISO 3166-1 alpha-2 → level: the strictest reading of the node's policy and the verified network policy. */
  byCountry: Record<string, CameraLevel>;
  zoneResolution: number | null;
  /** Changes whenever the node's policy changes. */
  version: string | null;
  /** The legal notice by language — show it once when the user first switches cameras on, and again when `version` grows. */
  notice: { version: number; text: Record<string, string> };
}

/** What `submitReportWithDuration` tells about the duration of what it queued. */
export interface SubmittedReport {
  localId: string;
  /** The duration that was queued (and will be signed), if one was asked for and the server takes it. */
  expiresInSeconds: number | null;
  /** `false`: a duration was asked for but this server does not take one; the server's default applies. */
  durationHonoured: boolean;
  /** How long the report lives when nothing is asked for, if known. */
  defaultSeconds: number | null;
}

export interface ReportLimits {
  /** `false`: the server takes no requested duration (an older server, or a type that never expires). */
  supported: boolean;
  defaultSeconds: number | null;
  minSeconds: number | null;
  maxSeconds: number | null;
}

/** A point picked on the map. */
export interface RoadPoint {
  lat: number;
  lng: number;
}

/** A limit for a stretch of road, named by two points on it. The device needs no road data: the server finds the road. */
export interface SpeedLimitIntervalReport {
  from: RoadPoint;
  to: RoadPoint;
  value: number;
  unit: SpeedLimitUnit;
  reason?: string;
}

/** What the server found for two picked points (`resolveRoadInterval`). */
export interface RoadInterval {
  /** `ivl:…` reference of the two points (what a device signs). */
  ref: string;
  segmentKey: string;
  /** The stretch along the road's own shape, between the two points on the road: draw this. */
  geometry: { type: "LineString"; coordinates: [number, number][] };
  lengthM: number;
  road: { name: string | null; ref: string | null; class: string | null };
  /** Limits already on record under the stretch (what a proposal would replace). */
  covered: {
    segmentId: string;
    segmentKey: string;
    speedLimit: number;
    unit: SpeedLimitUnit;
    source: string;
    coveredMeters: number;
  }[];
  /** Proposals and applied values for exactly this stretch. */
  proposals: Correction[];
}

// ---- context signs (server 1.4.0)

export type ContextSignDirection = "along" | "both";

/** A weekday/time window, read in the entry's time zone. `from > to` crosses midnight and belongs to the day it starts on. */
export interface ContextSignWindow {
  /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
  days: number[];
  /** "HH:MM", local time. */
  from: string;
  to: string;
}

/** When a context sign applies. No `windows` and no `period`: always. */
export interface ContextSignValidity {
  v?: 1;
  /** IANA time zone, e.g. "Europe/Berlin". */
  tz: string;
  windows?: ContextSignWindow[];
  /** Local dates "YYYY-MM-DD", inclusive. `to: null`: until revoked. */
  period?: { from: string; to: string | null };
}

/** What `getContextSigns` takes. */
export interface ContextSignsQuery {
  lat: number;
  lng: number;
  /** Compass direction of travel in degrees (0 = north). Without it only both-way signs that contain the position are told. */
  heading?: number;
  /** How far ahead (metres) to look for the start of a sign. Default 1500. */
  aheadMeters?: number;
  /** The instant to read the time windows at: an RFC 3339 text or Unix milliseconds. Default now. */
  at?: string | number;
  /** Also signs that fewer devices than the node requires have confirmed (`confirmed: false`). Default `false`. */
  includeUnconfirmed?: boolean;
  /** Also signs that do not apply at `at` (they carry `nextActiveAt`). Default `false`. */
  includeInactive?: boolean;
}

/** A traffic sign that applies here or begins ahead. Ordered by `startsInM`; the app decides side and replacement (`sign-rules.json`). */
export interface ContextSign {
  id: string;
  /** Country-prefixed catalogue reference: `DE:276`, `DE:142-10`. */
  signType: string;
  /** For signs that carry one (weight in t, height/width/length/distance in m). */
  value: number | null;
  unit: "t" | "m" | null;
  /** Metres to where it starts along the direction of travel; `<= 0`: it applies already (minus the metres driven along it). */
  startsInM: number;
  /** Metres to where it ends. */
  endsInM: number | null;
  /** RFC 3339 (UTC): the instant its current validity ends. `null`: no end. */
  validUntil: string | null;
  /** For a sign that does not apply now (with `includeInactive`): when it next does, within eight days. */
  nextActiveAt: string | null;
  activeNow: boolean;
  confirmed: boolean;
  confirmations: number;
  direction: ContextSignDirection;
  lengthM: number;
}

export interface ContextSigns {
  signs: ContextSign[];
  /** The device holds the context signs of this place. `false`: the empty list means "nothing downloaded", not "no sign here". */
  covered: boolean;
  entriesHeld: number;
}

/** What a person picked for a context sign. The server finds the road. */
export interface ContextSignRequest {
  signType: string;
  /** The start of the stretch, or the place of a sign that stands at one place. */
  from: RoadPoint;
  /** The end of the stretch. Omit for a sign at one place. */
  to?: RoadPoint;
  /** Default `both`. */
  direction?: ContextSignDirection;
  /** Direction of travel (degrees) for a sign at one place that applies one way. */
  heading?: number;
  validity?: { tz?: string; windows?: ContextSignWindow[]; period?: { from: string; to: string | null } };
  value?: number;
  unit?: "t" | "m";
}

/** An entry as the server describes it. */
export interface ContextSignEntry {
  id: string;
  signType: string;
  /** `[lng, lat]` vertices in the direction the sign applies in. */
  geometry: [number, number][];
  direction: ContextSignDirection;
  validity: ContextSignValidity;
  value: number | null;
  unit: "t" | "m" | null;
  lengthM: number;
  status: "proposed" | "confirmed" | "disputed" | "expired";
  confirmed: boolean;
  confirmations: number;
  denials: number;
  expiresAt: string | null;
}

/** What the node makes of the picked points (`resolveContextSign`). If `existing` is set, confirm it instead of proposing. */
export interface ContextSignPreview {
  /** The stretch on the road in the form a device signs; `geometry` is what to draw. */
  descriptor: { signType: string; geometry: [number, number][]; direction: ContextSignDirection; validity: ContextSignValidity; value: number | null; unit: "t" | "m" | null };
  entryKey: string;
  lengthM: number;
  road: { name: string | null; ref: string | null; class: string | null };
  timezone: string;
  existing: ContextSignEntry | null;
  similar: { entry: ContextSignEntry; overlapOfNew: number; overlapOfEntry: number; sameDirection: boolean }[];
}

/** An entry near a point that can be marked as wrong. */
export interface DataDefect {
  targetType: "speedLimitSegment" | "staticSign";
  targetId: string;
  distanceMeters: number;
  speedLimit?: number;
  speedLimitUnit?: SpeedLimitUnit;
  signType?: string;
  source?: string;
  /** The line of a speed-limit entry. */
  geometry?: { type: "LineString"; coordinates: [number, number][] };
  /** The place of a sign. */
  position?: { type: "Point"; coordinates: [number, number] };
  /** How many distinct devices have marked it so far. */
  reports: number;
  /** How many it takes to take the entry out. */
  threshold: number;
}

export type DataDefectReason = "not_on_a_road" | "wrong_place" | "does_not_exist" | "wrong_value" | "other";

export interface DataDefectReport {
  targetType: "speedLimitSegment" | "staticSign";
  targetId: string;
  reason?: DataDefectReason;
}

export interface DataDefectAnswer {
  /** `false`: this device had marked the entry before. */
  recorded: boolean;
  reports: number;
  threshold: number;
  /** The entry is out now. */
  removed: boolean;
}

/** The answer of `lookupSpeedLimit`: always an answer, never a bare "nothing". */
export type SpeedLimitLookup =
  | ({ status: "found"; source: "offline" | "online" } & SpeedLimitAnswer)
  | { status: "notRecorded"; source: "offline" | "online" }
  /** The place is outside the offline area and there is no network. */
  | { status: "outsideOfflineArea" };

export type OfflineMode = "auto" | "regions" | "all";

export interface AutoRegionPolicy {
  homeRadiusTiles: number;
  currentRadiusTiles: number;
  recentPlaces: number;
  recentRadiusTiles: number;
}

export interface OfflineSettings {
  mode: OfflineMode;
  regions: string[];
  auto: AutoRegionPolicy;
  /** `[lat, lng]`, once known. */
  home: [number, number] | null;
  maxBytes: number | null;
  wifiOnly: boolean;
}

export interface AutoRegionPolicyPatch {
  homeRadiusTiles?: number;
  currentRadiusTiles?: number;
  recentPlaces?: number;
  recentRadiusTiles?: number;
  homeLat?: number;
  homeLng?: number;
}

export interface OfflineRegion {
  id: string;
  /** ISO 3166-1 alpha-2, or `null` for a coarse area. */
  country: string | null;
  tileCount: number;
  /** What it takes on the wire (brotli), as JSON, and an estimate for the device. */
  downloadBytes: number;
  sizeBytes: number;
  estimatedDeviceBytes: number;
  /** `false`: the byte counts are lower bounds. */
  complete: boolean;
  /** `[west, south, east, north]`. */
  bbox: [number, number, number, number];
  selected: boolean;
  storedTiles: number;
  state: "none" | "partial" | "complete";
}

export interface StoragePlan {
  mode: OfflineMode;
  /** Automatic mode and neither a position nor a home is known: nothing is selected yet. */
  needsLocation: boolean;
  offeredTiles: number;
  offeredBytes: number;
  toFetchTiles: number;
  toFetchBytes: number;
  toFetchDeviceBytes: number;
  toRemoveTiles: number;
  cachedUnwantedTiles: number;
  deferredTiles: number;
  deferredForLimit: number;
  deferredForMetered: number;
  maxBytes: number | null;
  fits: boolean;
  storedTiles: number;
  storedDeviceBytes: number | null;
}

export interface StorageUsage {
  storedTiles: number;
  storeBytes: number | null;
  storedJsonBytes: number;
  estimatedDeviceBytes: number;
  maxBytes: number | null;
  /** Least recently used first. */
  tiles: { tile: string; sizeBytes: number; lastUsedUnixMs: number | null }[];
}

export interface Coverage {
  covered: boolean;
  tile: string | null;
  state: "stored" | "wanted" | "outside";
  /** A lookup here goes to the server (`lookupSpeedLimit` does it itself). */
  usesNetwork: boolean;
}

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
  /** Offline area: packages fetched this time, let go of, and wanted but held back. */
  offlineFetchedTiles: number;
  offlineRemovedTiles: number;
  offlineDeferredTiles: number;
  /** Automatic offline area and neither a position nor a home is known: nothing was selected. */
  needsLocation: boolean;
  /** Context signs held after this sync (absent when the server does not offer them). */
  contextSignsEntries?: number;
  /** Error code of the context-sign part, if it failed. This does not make `ok` false. */
  contextSignsError?: string;
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
  /** A duration asked for a report is outside the server's bounds for its type (`getReportLimits`). */
  | "ttlOutOfRange"
  /** The server has no road data for that area and cannot look it up (`resolveRoadInterval`). */
  | "noRoadData"
  /** No road was found near one of the two points: tap closer to the road. */
  | "noRoadFound"
  /** The two points are not on one road that runs between them. */
  | "noRoadBetweenPoints"
  /** The two points are further apart than one stretch may be (the server's `roadNetwork.intervalMaxMeters`). */
  | "intervalTooLong"
  /** The two points are closer together than a stretch can be. */
  | "intervalTooShort"
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
  submitReport(
    type: HazardType,
    lat: number,
    lng: number,
    speedKmh?: number,
    ttlSeconds?: number,
  ): Promise<string>;
  /** As `submitReport`, resolving with what was queued: the local id and the duration that applies. */
  submitReportWithDuration(
    type: HazardType,
    lat: number,
    lng: number,
    options?: { speedKmh?: number; ttlSeconds?: number },
  ): Promise<SubmittedReport>;
  /** The default, minimum and maximum duration of a report of this type, from the server's configuration. Local. */
  getReportLimits(type: HazardType): Promise<ReportLimits>;
  confirmReport(reportId: string, stillThere: boolean): Promise<string>;
  reportCameraRemoved(cameraId: string): Promise<string>;
  reportWrongSpeedLimit(report: WrongSpeedLimitReport): Promise<Proposal>;
  /**
   * "On this stretch of road the limit is X": a limit for a stretch named by two points on it — for a road the import has
   * no limit for, or to change a limit that is wrong on part of a road. Effective for this device at once (as its own,
   * unconfirmed proposal), sent signed on the next sync.
   */
  reportSpeedLimitInterval(report: SpeedLimitIntervalReport): Promise<Proposal>;
  /** Which stretch of which road two picked points name — draw `geometry` before anybody proposes a value. Needs the network. */
  resolveRoadInterval(from: RoadPoint, to: RoadPoint): Promise<RoadInterval>;
  /**
   * Which traffic signs apply here and just ahead (server 1.4.0): the entries the device holds, read at `at`. Local and offline, like
   * `getSpeedLimitAt`; the entries come with every sync for the offline area and the places around the position. Nearest first.
   */
  getContextSigns(query: ContextSignsQuery): Promise<ContextSigns>;
  /** The stretch of road the picked points of a context sign mean, and the same/similar entries. Needs the network. */
  resolveContextSign(request: ContextSignRequest): Promise<ContextSignPreview>;
  /** Proposes a context sign. Queued like every write (the node finds the road when it is sent), signed then; returns the local queue id. */
  reportContextSign(request: ContextSignRequest): Promise<string>;
  /** "This sign is right here" / "it is not" for an entry from `getContextSigns`. Queued and signed like a proposal; returns the local queue id. */
  voteContextSign(id: string, agrees: boolean): Promise<string>;
  /** The entries near a point that can be marked as wrong, with how many devices have marked each. Needs the network. */
  dataDefectsNear(lat: number, lng: number, radiusMeters?: number): Promise<DataDefect[]>;
  /** "This entry is wrong": one mark per device and entry; enough distinct devices take it out. Needs the network. */
  reportDataDefect(report: DataDefectReport): Promise<DataDefectAnswer>;
  /** The limit here: from the offline data, or from the server when the place is outside the offline area. */
  lookupSpeedLimit(lat: number, lng: number, heading?: number): Promise<SpeedLimitLookup>;
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
  /** The levels the network allows per country, and the legal notice to show before cameras are switched on. Local. */
  getCameraPolicy(): Promise<CameraPolicy>;
  /** What the offline area is set to (mode, chosen regions, home, limit). Local. */
  getOfflineSettings(): Promise<OfflineSettings>;
  /** Chooses what is kept: `auto` (default), `regions` (ids from `listOfflineRegions`) or `all`. Applied with the next sync. */
  setOfflineRegions(settings: { mode?: OfflineMode; regions?: string[] }): Promise<OfflineSettings>;
  /** How the automatic area is cut, and where home is. */
  setAutoRegionPolicy(policy: AutoRegionPolicyPatch): Promise<OfflineSettings>;
  /** `maxBytes: null` removes the limit, absent leaves it. */
  setStorageLimits(limits: { maxBytes?: number | null; wifiOnly?: boolean }): Promise<OfflineSettings>;
  /** The host app tells the library whether the connection is metered; the library cannot tell. */
  setConnectionMetered(metered: boolean): Promise<unknown>;
  /** The server's regions with their size, whether chosen, and how much of each is stored. */
  listOfflineRegions(): Promise<OfflineRegion[]>;
  /** What a sync would fetch, let go of, or hold back — and whether it fits. */
  getStoragePlan(): Promise<StoragePlan>;
  getStorageUsage(): Promise<StorageUsage>;
  /** Whether the offline data answers for this position. Local. */
  getCoverage(lat: number, lng: number): Promise<Coverage>;
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
  submitReport(
    type: HazardType,
    lat: number,
    lng: number,
    speedKmh?: number,
    ttlSeconds?: number,
  ): Promise<string>;
  submitReportWithDuration(
    type: HazardType,
    lat: number,
    lng: number,
    options?: { speedKmh?: number; ttlSeconds?: number },
  ): Promise<SubmittedReport>;
  getReportLimits(type: HazardType): Promise<ReportLimits>;
  confirmReport(reportId: string, stillThere: boolean): Promise<string>;
  reportCameraRemoved(cameraId: string): Promise<string>;
  reportWrongSpeedLimit(report: WrongSpeedLimitReport): Promise<Proposal>;
  reportSpeedLimitInterval(report: SpeedLimitIntervalReport): Promise<Proposal>;
  resolveRoadInterval(from: RoadPoint, to: RoadPoint): Promise<RoadInterval>;
  getContextSigns(query: ContextSignsQuery): Promise<ContextSigns>;
  resolveContextSign(request: ContextSignRequest): Promise<ContextSignPreview>;
  reportContextSign(request: ContextSignRequest): Promise<string>;
  voteContextSign(id: string, agrees: boolean): Promise<string>;
  dataDefectsNear(lat: number, lng: number, radiusMeters?: number): Promise<DataDefect[]>;
  reportDataDefect(report: DataDefectReport): Promise<DataDefectAnswer>;
  lookupSpeedLimit(lat: number, lng: number, heading?: number): Promise<SpeedLimitLookup>;
  confirmSpeedLimitCorrection(vote: SpeedLimitVote): Promise<string | null>;
  fetchCorrections(): Promise<Correction[]>;
  updatePosition(lat: number, lng: number, speedKmh?: number): Promise<PositionUpdate>;
  sync(): Promise<SyncReport>;
  tick(): Promise<TickResult>;
  planBootstrap(): Promise<BootstrapPlan>;
  getSyncStatus(): Promise<SyncStatus>;
  getNetworkStatus(): Promise<NetworkStatus>;
  getCameraPolicy(): Promise<CameraPolicy>;
  getOfflineSettings(): Promise<OfflineSettings>;
  setOfflineRegions(settings: { mode?: OfflineMode; regions?: string[] }): Promise<OfflineSettings>;
  setAutoRegionPolicy(policy: AutoRegionPolicyPatch): Promise<OfflineSettings>;
  setStorageLimits(limits: { maxBytes?: number | null; wifiOnly?: boolean }): Promise<OfflineSettings>;
  setConnectionMetered(metered: boolean): Promise<unknown>;
  listOfflineRegions(): Promise<OfflineRegion[]>;
  getStoragePlan(): Promise<StoragePlan>;
  getStorageUsage(): Promise<StorageUsage>;
  getCoverage(lat: number, lng: number): Promise<Coverage>;
  pollEvents(): Promise<ClientEvent[]>;
  close(): Promise<unknown>;
}
