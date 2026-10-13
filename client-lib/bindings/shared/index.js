// The one JS/TS-facing client surface, shared by both JS bindings: the
// browser (`bindings/wasm`, WebAssembly) and Node.js (`bindings/node`, FFI
// over the C ABI). Each of them only supplies the transport — how a single
// `call(method, argsJson) -> resultJson` reaches the Rust core; everything a
// host app actually sees (the typed methods, the error class, the result
// shapes) lives here, once, so the two cannot drift apart and neither adds
// behavior of its own (client-lib/docs/api.md describes the methods).
//
// Every method returns a Promise: a browser has no way to block on the
// network, and Node's FFI calls run on a worker thread rather than freezing
// the event loop for the length of a sync.

export class TrafficNetworkError extends Error {
  /**
   * @param {string} code    one of the API's error codes (client-lib/docs/api.md, "Errors")
   * @param {string} message human-readable, for logs
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "TrafficNetworkError";
    this.code = code;
    this.detail = message;
  }
}

/** Opens a `{"ok": ...}` / `{"error": {...}}` envelope: the value, or a thrown {@link TrafficNetworkError}. */
export function unwrap(envelope) {
  if (envelope && typeof envelope === "object" && "error" in envelope) {
    const error = envelope.error ?? {};
    throw new TrafficNetworkError(error.code ?? "internal", error.message ?? "");
  }
  return envelope?.ok;
}

export class BaseClient {
  /**
   * The transport. Implemented by each binding: one API call as JSON text in,
   * the `{"ok"|"error"}` envelope as JSON text out. Must resolve, never reject,
   * for an ordinary API failure — those are in the envelope.
   * @param {string} _method
   * @param {string} _argsJson
   * @returns {Promise<string>}
   */
  async _callRaw(_method, _argsJson) {
    throw new Error("BaseClient._callRaw is implemented by the binding");
  }

  /** Runs any API method by its camelCase name; resolves with its result or rejects with a {@link TrafficNetworkError}. */
  async call(method, args) {
    const text = await this._callRaw(method, JSON.stringify(args ?? {}));
    return unwrap(JSON.parse(text));
  }

  // ------------------------------------------------------- the API methods

  version() {
    return this.call("version");
  }

  getSpeedLimitAt(lat, lng, heading) {
    const args = { lat, lng };
    if (heading !== undefined) args.heading = heading;
    return this.call("getSpeedLimitAt", args);
  }

  async getNearby(lat, lng, radiusMeters, categories) {
    const args = { lat, lng, radiusMeters };
    if (categories && categories.length > 0) args.categories = categories;
    return (await this.call("getNearby", args)).items;
  }

  async submitReport(type, lat, lng, speedKmh, ttlSeconds) {
    const args = { type, lat, lng };
    if (speedKmh !== undefined) args.speedKmh = speedKmh;
    if (ttlSeconds !== undefined) args.ttlSeconds = ttlSeconds;
    return (await this.call("submitReport", args)).localId;
  }

  /** As `submitReport`, but resolves with what was queued: the local id and the duration that applies. */
  submitReportWithDuration(type, lat, lng, { speedKmh, ttlSeconds } = {}) {
    const args = { type, lat, lng };
    if (speedKmh !== undefined) args.speedKmh = speedKmh;
    if (ttlSeconds !== undefined) args.ttlSeconds = ttlSeconds;
    return this.call("submitReport", args);
  }

  getReportLimits(type) {
    return this.call("getReportLimits", { type });
  }

  async confirmReport(reportId, stillThere) {
    return (await this.call("confirmReport", { reportId, stillThere })).localId;
  }

  async reportCameraRemoved(cameraId) {
    return (await this.call("reportCameraRemoved", { cameraId })).localId;
  }

  reportWrongSpeedLimit({ proposedValue, unit, segmentId, lat, lng, reason }) {
    const args = { proposedValue, unit };
    if (segmentId !== undefined) args.segmentId = segmentId;
    if (lat !== undefined && lng !== undefined) {
      args.lat = lat;
      args.lng = lng;
    }
    if (reason !== undefined) args.reason = reason;
    return this.call("reportWrongSpeedLimit", args);
  }

  reportSpeedLimitInterval({ from, to, value, unit, reason }) {
    const args = { from, to, value, unit };
    if (reason !== undefined) args.reason = reason;
    return this.call("reportSpeedLimitInterval", args);
  }

  resolveRoadInterval(from, to) {
    return this.call("resolveRoadInterval", { from, to });
  }

  dataDefectsNear(lat, lng, radiusMeters) {
    const args = { lat, lng };
    if (radiusMeters !== undefined) args.radiusMeters = radiusMeters;
    return this.call("dataDefectsNear", args);
  }

  reportDataDefect({ targetType, targetId, reason }) {
    const args = { targetType, targetId };
    if (reason !== undefined) args.reason = reason;
    return this.call("reportDataDefect", args);
  }

  lookupSpeedLimit(lat, lng, heading) {
    const args = { lat, lng };
    if (heading !== undefined) args.heading = heading;
    return this.call("lookupSpeedLimit", args);
  }

  async confirmSpeedLimitCorrection({ agrees, segmentId, correction }) {
    const args = { agrees };
    if (segmentId !== undefined) args.segmentId = segmentId;
    if (correction !== undefined) args.correction = correction;
    return (await this.call("confirmSpeedLimitCorrection", args)).localId;
  }

  async fetchCorrections() {
    return (await this.call("fetchCorrections")).corrections;
  }

  updatePosition(lat, lng, speedKmh) {
    const args = { lat, lng };
    if (speedKmh !== undefined) args.speedKmh = speedKmh;
    return this.call("updatePosition", args);
  }

  sync() {
    return this.call("sync");
  }

  tick() {
    return this.call("tick");
  }

  planBootstrap() {
    return this.call("planBootstrap");
  }

  getSyncStatus() {
    return this.call("getSyncStatus");
  }

  getNetworkStatus() {
    return this.call("getNetworkStatus");
  }

  getCameraPolicy() {
    return this.call("getCameraPolicy");
  }

  // ------------------------------------------------------- offline area

  getOfflineSettings() {
    return this.call("getOfflineSettings");
  }

  /** `{ mode?: "auto"|"regions"|"all", regions?: string[] }` — regions are ids from `listOfflineRegions`. */
  setOfflineRegions(settings) {
    return this.call("setOfflineRegions", settings ?? {});
  }

  setAutoRegionPolicy(policy) {
    return this.call("setAutoRegionPolicy", policy ?? {});
  }

  /** `{ maxBytes?: number | null, wifiOnly?: boolean }` — `null` removes the limit, absent leaves it. */
  setStorageLimits(limits) {
    return this.call("setStorageLimits", limits ?? {});
  }

  setConnectionMetered(metered) {
    return this.call("setConnectionMetered", { metered });
  }

  async listOfflineRegions() {
    return (await this.call("listOfflineRegions")).regions;
  }

  getStoragePlan() {
    return this.call("getStoragePlan");
  }

  getStorageUsage() {
    return this.call("getStorageUsage");
  }

  getCoverage(lat, lng) {
    return this.call("getCoverage", { lat, lng });
  }

  async pollEvents() {
    return (await this.call("pollEvents")).events;
  }

  close() {
    return this.call("close");
  }
}
