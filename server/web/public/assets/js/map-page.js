import { ApiClient } from "./api.js";
import { loadWebConfig } from "./config.js";
import { clear, h } from "./dom.js";
import { readCameraPolicy } from "./camera-policy.js";
import { CameraNotice } from "./camera-notice.js";
import { anyCameraEnabled, isCameraType, selectableTypes, sortNewestFirst, zoneLatLngs } from "./filter.js";
import { formatAge, formatKm, formatRemaining } from "./format.js";
import { HazardLayer, reportLatLng } from "./hazard-layer.js";
import { applyTranslations, currentTranslator, initI18n, onLangChange, t } from "./i18n.js";
import { mountLayout } from "./layout.js";
import { LimitsLayer, limitsStateText } from "./limits-layer.js";
import { LiveConnection } from "./live.js";
import { initialSelection, loadFilterPrefs, markNoticeSeen, noticeSeen, saveFilterPref } from "./prefs.js";
import { describeSubmitFailure, ReportDialog } from "./report-dialog.js";
import { ZoneLayer } from "./zone-layer.js";

const L = window.L;
const LIVE_K = 2;
const REFRESH_MS = 60_000;
/** Ask for a bit more than the view needs, so small pans and zooming in are answered from what is already loaded. */
const HAZARD_MARGIN = 1.5;
const DEFAULT_VIEW = { center: [51.16, 10.45], zoom: 6 };

initI18n();
const $ = (id) => document.getElementById(id);
const api = new ApiClient();
// Everything below needs the anonymous session: request it right away, while the config is still downloading.
api.ensureToken().catch(() => {});
const config = await loadWebConfig();
mountLayout(config, "map");

// What this node allows arrives while the map is already on screen; until then the general categories are assumed.
// The camera categories exist only where the node delivers camera data, and even then they start switched off: the visitor ticks them
// themselves (and is told the legal position once). What they chose is remembered in this browser.
let cameraAvailable = false;
let zonesSomewhere = false;
let noticeVersion = 1;
let tileResolution = 7;
let types = selectableTypes(false);
const filterPrefs = loadFilterPrefs();
const enabledTypes = initialSelection(types, filterPrefs);

// ---- map -------------------------------------------------------------------------------------------------------
const map = L.map("map", {
  zoomControl: false,
  attributionControl: false,
  worldCopyJump: true,
  // Zoom continuously instead of in whole levels: with Leaflet's defaults a mouse-wheel notch jumps a whole level (two on
  // Linux/macOS), a trackpad gesture moves in coarse steps and a pinch snaps to a level when the fingers lift. Here a notch
  // is a bit over half a level on Windows and about one on other systems (Leaflet halves the wheel delta of Chrome on Windows).
  zoomSnap: 0,
  zoomDelta: 1,
  wheelPxPerZoomLevel: 50,
  wheelDebounceTime: 30,
  minZoom: 3,
  maxZoom: config.tiles?.maxZoom ?? 19,
  bounceAtZoomLimits: false,
});
L.control.zoom({ position: "topright" }).addTo(map);
// The panel's size settles after the header/footer are built and after orientation changes: keep Leaflet in step (only on a real change).
const panel = $("map-panel");
let panelSize = "";
new ResizeObserver(() => {
  const size = `${panel.clientWidth}x${panel.clientHeight}`;
  if (size === panelSize) return;
  panelSize = size;
  map.invalidateSize({ animate: false });
}).observe(panel);
let tileLayer = null;
if (config.tiles) {
  tileLayer = L.tileLayer(config.tiles.url, {
    maxZoom: config.tiles.maxZoom,
    detectRetina: false,
    // Load tiles while the map is moving (on phones Leaflet waits until the finger lifts and shows grey), but only for the
    // level the zoom ends on: intermediate levels of a smooth zoom would be requested and thrown away.
    updateWhenIdle: false,
    updateWhenZooming: false,
    updateInterval: 150,
    keepBuffer: 3,
  }).addTo(map);
  const attribution = L.control({ position: "bottomright" });
  attribution.onAdd = () => {
    const box = h("div", { class: "leaflet-control-attribution leaflet-control" }, "© ", h("a", { href: config.tiles.attributionUrl, target: "_blank", rel: "noopener noreferrer" }, config.tiles.attributionText.replace(/^©\s*/, "")));
    return box;
  };
  attribution.addTo(map);
}
if (config.region) {
  // One initial view, not "fit, then zoom in to level 9": the second step would run as a zoom animation on load,
  // request two sets of tiles and ignore any view change for the next quarter second.
  const bounds = L.latLngBounds(config.region.bounds);
  map.setView(bounds.getCenter(), Math.max(9, map.getBoundsZoom(bounds)));
} else {
  map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
}
$("map").setAttribute("aria-label", t("map.aria"));

// ---- hazards ---------------------------------------------------------------------------------------------------
const hazards = new HazardLayer({ map, onVote: vote, onChange: () => renderList() });
// Where a country shows cameras only as areas, the node delivers zones; they are drawn as areas, never as pins.
const zones = new ZoneLayer({ map, onChange: () => renderList() });
hazards.setFilter(enabledTypes, cameraAvailable);
zones.setFilter(enabledTypes, cameraAvailable);

let loadTicket = 0;
let hazardAbort = null;
let coverage = null;
/** The circle the current reports were loaded for, so a view inside it needs no new request. */
let loadedArea = null;

function showCoverage(center, radius, tooLarge) {
  coverage?.remove();
  coverage = null;
  if (tooLarge) coverage = L.circle(center, { radius, color: "#0b5cd5", weight: 1, dashArray: "6 6", fill: false, interactive: false }).addTo(map);
  setChip("area-chip", tooLarge ? t("map.areaTooLarge", { km: formatKm(radius) }) : null);
}

async function loadHazards({ force = false } = {}) {
  const center = map.getCenter();
  const cap = config.limits.maxHazardRadiusM;
  const wanted = Math.ceil(map.distance(center, map.getBounds().getNorthEast()));
  const needed = Math.min(wanted, cap);
  showCoverage(center, needed, wanted > cap);

  // Map init fires several moveend events for one view, zooming in only shrinks it: answer from what is loaded.
  if (!force && loadedArea && Date.now() - loadedArea.at < REFRESH_MS && map.distance(center, loadedArea.center) + needed <= loadedArea.radius) return;

  const radius = Math.min(cap, Math.ceil(needed * HAZARD_MARGIN));
  const ticket = ++loadTicket;
  hazardAbort?.abort();
  const controller = new AbortController();
  hazardAbort = controller;
  loadedArea = { center, radius, at: Date.now() };
  try {
    const query = { lat: center.lat.toFixed(6), lng: center.lng.toFixed(6), radiusM: radius };
    const requests = [api.get("/v1/hazard-reports/nearby", query, { signal: controller.signal })];
    // Camera data is asked for only while the visitor has a camera category switched on.
    if (cameraAvailable && anyCameraEnabled(enabledTypes)) requests.push(api.get("/v1/speed-cameras/nearby", query, { signal: controller.signal }));
    const results = await Promise.all(requests);
    if (ticket !== loadTicket) return;
    hazards.replaceAll([...(results[0].data.reports ?? []), ...(results[1]?.data.cameras ?? [])]);
    zones.replaceAll(results[1]?.data.zones ?? []);
    $("list-status").textContent = "";
  } catch (error) {
    if (ticket !== loadTicket || error?.name === "AbortError") return;
    loadedArea = null;
    $("list-status").textContent = t("map.loadError");
  }
}

// ---- live updates ----------------------------------------------------------------------------------------------
const live = new LiveConnection({
  api,
  url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/ws`,
  onEvent: handleEvent,
  onStatus: renderLiveChip,
  onResync: () => void loadHazards({ force: true }),
});

function handleEvent(event) {
  const payload = event.payload ?? {};
  if (event.entityType === "hazardReport") {
    if (event.type === "ReportExpired") hazards.remove(event.entityId ?? payload.id);
    else if (event.type === "ReportCreated" || event.type === "ReportConfirmed" || event.type === "ReportDenied") hazards.upsert({ ...payload, id: payload.id ?? event.entityId });
  } else if (event.entityType === "fixedSpeedCamera" && cameraAvailable) {
    if (event.type === "StaticDataRemoved") hazards.remove(event.entityId);
    else hazards.upsert({ ...payload, id: payload.id ?? event.entityId, type: "fixedSpeedCamera" });
  } else if (event.entityType === "enforcementDevice" && cameraAvailable) {
    // Red-light and distance devices: a persistent camera of its own kind (the payload names it in `type`).
    if (event.type === "StaticDataRemoved") hazards.remove(event.entityId);
    else hazards.upsert({ ...payload, id: payload.id ?? event.entityId });
  } else if (event.entityType === "cameraZone" && cameraAvailable) {
    // An area, not a camera: the node delivers it where it shows cameras only roughly.
    if (event.type === "StaticDataRemoved") zones.remove(payload.id ?? event.entityId);
    else zones.upsert({ ...payload, id: payload.id ?? event.entityId });
  }
}

// The tile library only names the tile for live updates, and it is the biggest file of the page: fetch it on the side,
// once the first map tiles are in (on a slow connection it would otherwise compete with them).
let h3 = null;
let liveReady = false;
function enableLiveUpdates() {
  if (liveReady) return;
  liveReady = true;
  void subscribeAroundCenter();
}
async function subscribeAroundCenter() {
  if (!liveReady) return;
  const center = map.getCenter();
  h3 ??= import("/web/vendor/h3/h3-js.es.js");
  const { latLngToCell } = await h3;
  live.subscribe(latLngToCell(center.lat, center.lng, tileResolution), LIVE_K);
}

async function loadServerConfig() {
  try {
    const { data } = await api.get("/v1/config");
    const policy = readCameraPolicy(data);
    cameraAvailable = policy.available;
    zonesSomewhere = policy.hasZones;
    noticeVersion = policy.noticeVersion;
    tileResolution = data?.regionTileH3Resolution ?? tileResolution;
    types = selectableTypes(cameraAvailable);
    enabledTypes.clear();
    for (const type of initialSelection(types, filterPrefs)) enabledTypes.add(type);
    hazards.setFilter(enabledTypes, cameraAvailable);
    zones.setFilter(enabledTypes, cameraAvailable);
    renderFilters();
    if (cameraAvailable && anyCameraEnabled(enabledTypes)) void loadHazards({ force: true });
    void subscribeAroundCenter();
  } catch {
    $("map-status").textContent = t("map.session.error");
  }
}

// ---- speed limit on click ---------------------------------------------------------------------------------------
let pendingPick = null;

map.on("click", async (event) => {
  if (pendingPick) {
    const { resolve } = pendingPick;
    endPick();
    resolve(event.latlng);
    return;
  }
  const popup = L.popup({ autoPanPadding: [30, 60] }).setLatLng(event.latlng).setContent(h("p", null, "…")).openOn(map);
  const tr = currentTranslator();
  try {
    const { data } = await api.get("/v1/speed-limit", { lat: event.latlng.lat.toFixed(6), lng: event.latlng.lng.toFixed(6) });
    popup.setContent(h("div", null, h("h3", null, tr.t("limit.here", { value: data.speedLimit, unit: tr.t(`unit.${data.speedLimitUnit}`) })), h("div", null, tr.t("limit.distance", { m: Math.round(data.distanceMeters) }))));
  } catch (error) {
    popup.setContent(h("p", null, error.status === 404 ? tr.t("limit.none") : error.status === 429 ? tr.t("limit.rateLimited") : tr.t("limit.error")));
  }
});

// ---- filters, layer toggle, list --------------------------------------------------------------------------------
function renderFilters() {
  const tr = currentTranslator();
  const box = $("filters");
  clear(box);
  box.append(h("legend", null, tr.t("map.filters.title")));
  for (const type of types) {
    const input = h("input", { type: "checkbox", value: type, checked: enabledTypes.has(type) ? true : undefined });
    input.addEventListener("change", () => onFilterChange(type, input.checked));
    box.append(h("label", null, input, h("span", null, tr.t(`type.${type}`))));
  }
  if (cameraAvailable) {
    // Where the node shows cameras only as areas, say so; the legal notice is always one link away.
    box.append(
      h(
        "p",
        { class: "hint filter-note" },
        zonesSomewhere ? `${tr.t("map.filters.cameraZones")} ` : null,
        h("a", { href: "/about#cameras" }, tr.t("cameraNotice.link")),
      ),
    );
  }
}

const cameraNotice = new CameraNotice({ dialog: $("camera-notice") });

function onFilterChange(type, on) {
  const hadCameras = anyCameraEnabled(enabledTypes);
  if (on) enabledTypes.add(type);
  else enabledTypes.delete(type);
  saveFilterPref(type, on);
  hazards.setFilter(enabledTypes, cameraAvailable);
  zones.setFilter(enabledTypes, cameraAvailable);
  if (!isCameraType(type) || !on) return;
  // The first time a visitor switches a camera category on: the legal position, once. The category is already on behind it.
  if (!noticeSeen(noticeVersion)) {
    markNoticeSeen(noticeVersion);
    cameraNotice.show();
  }
  // Camera data was not loaded while every camera category was off.
  if (!hadCameras) void loadHazards({ force: true });
}

let limitsState = { kind: "off" };
const limits = new LimitsLayer({
  map,
  api,
  maxRadiusM: config.limits.maxSegmentRadiusM,
  onState: (state) => {
    limitsState = state;
    $("limits-hint").textContent = limitsStateText(state);
  },
});
$("layer-limits").addEventListener("change", (event) => {
  limits.enabled = event.target.checked;
  $("limits-note").hidden = !event.target.checked;
});

function renderList() {
  const tr = currentTranslator();
  const list = $("report-list");
  const bounds = map.getBounds();
  const now = Date.now();
  const items = sortNewestFirst(hazards.visible.filter((report) => {
    const ll = reportLatLng(report);
    return ll && bounds.contains(ll);
  }));
  const areas = zones.visible.filter((zone) => zoneInView(zone, bounds));
  clear(list);
  if (items.length === 0 && areas.length === 0) {
    list.append(h("li", null, h("span", { class: "hint" }, tr.t("map.list.empty"))));
    return;
  }
  for (const report of items) {
    list.append(
      h(
        "li",
        null,
        h("div", null, h("strong", null, tr.t(`type.${report.type}`)), h("div", { class: "meta" }, [formatAge(report.reportedAt, now, tr), formatRemaining(report.expiresAt, now, tr)].filter(Boolean).join(" · "))),
        h("button", { type: "button", class: "small", onclick: () => hazards.focus(report.id) }, tr.t("map.list.show")),
      ),
    );
  }
  // Areas come after the reports: they have no age or lifetime, only the kinds of camera that are somewhere in them.
  for (const zone of areas) {
    list.append(
      h(
        "li",
        null,
        h("div", null, h("strong", null, tr.t("zone.listTitle")), h("div", { class: "meta" }, zones.describe(zone))),
        h("button", { type: "button", class: "small", onclick: () => zones.focus(zone.id) }, tr.t("map.list.show")),
      ),
    );
  }
}

function zoneInView(zone, bounds) {
  const latlngs = zoneLatLngs(zone);
  return latlngs ? L.latLngBounds(latlngs).intersects(bounds) : false;
}

// ---- votes and reports ------------------------------------------------------------------------------------------
async function vote(id, kind) {
  const tr = currentTranslator();
  try {
    const { data } = await api.post(`/v1/hazard-reports/${encodeURIComponent(id)}/confirmations`, { kind });
    if (data.report) hazards.upsert(data.report);
    return data.recorded ? tr.t("report.vote.sent") : tr.t("report.vote.already");
  } catch (error) {
    if (error.status === 429) return tr.t("report.vote.rateLimited", { minutes: Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60)) });
    return tr.t("report.vote.error");
  }
}

async function submitReport({ type, lat, lng }) {
  try {
    const { data } = await api.post("/v1/hazard-reports", { type, lat, lng });
    // A camera the node does not show individually is answered "accepted" (202) — the same for a new and a merged one — with the
    // area it falls in where the node shows areas. Nothing about it is drawn as a pin, and nothing says whether it was merged.
    const hiddenByFilter = isCameraType(type) && !enabledTypes.has(type) ? { filterOffType: type } : {};
    if (data.accepted) {
      if (data.zone) zones.upsert(data.zone);
      return { kind: "accepted", zone: Boolean(data.zone), ...hiddenByFilter };
    }
    const created = data.report ?? data.camera;
    if (created) hazards.upsert(created);
    return { kind: data.merged ? "merged" : "created", ...hiddenByFilter };
  } catch (error) {
    return describeSubmitFailure(error);
  }
}

function beginPick(resolve, cancel) {
  pendingPick = { resolve, cancel };
  $("map").classList.add("picking");
  setChip("pick-chip", t("reportDialog.pick.hint"));
  $("pick-cancel").hidden = false;
}

function endPick() {
  pendingPick = null;
  $("map").classList.remove("picking");
  setChip("pick-chip", null);
  $("pick-cancel").hidden = true;
}

$("pick-cancel").addEventListener("click", () => {
  const { cancel } = pendingPick ?? {};
  endPick();
  cancel?.();
});

const dialog = new ReportDialog({ dialog: $("report-dialog"), onSubmit: submitReport, onPickRequested: beginPick });
$("report-open").addEventListener("click", () => dialog.open({ types, center: map.getCenter() }));

// ---- own location (only when the visitor presses the button) ---------------------------------------------------
let hereMarker = null;
$("locate").addEventListener("click", () => {
  if (!("geolocation" in navigator)) {
    $("map-status").textContent = t("map.locate.unsupported");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const latlng = [pos.coords.latitude, pos.coords.longitude];
      hereMarker?.remove();
      hereMarker = L.marker(latlng, { icon: L.divIcon({ className: "here-icon", html: h("span", { class: "dot" }), iconSize: [24, 24], iconAnchor: [12, 12] }), interactive: false, keyboard: false }).addTo(map);
      map.setView(latlng, Math.max(map.getZoom(), 15));
    },
    () => {
      $("map-status").textContent = t("map.locate.denied");
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
  );
});

// ---- chips / status ---------------------------------------------------------------------------------------------
function setChip(id, text) {
  const chip = $(id);
  chip.hidden = !text;
  chip.textContent = text ?? "";
}

function renderLiveChip(connected = live.connected) {
  const chip = $("live-chip");
  chip.textContent = connected ? `● ${t("map.live.on")}` : t("map.live.off");
  chip.className = `chip ${connected ? "ok" : "bad"}`;
}

// ---- wiring -----------------------------------------------------------------------------------------------------
let moveTimer = null;
map.on("moveend", () => {
  window.clearTimeout(moveTimer);
  moveTimer = window.setTimeout(() => {
    void loadHazards();
    void subscribeAroundCenter();
  }, 300);
  renderList();
});

onLangChange(() => {
  renderFilters();
  renderList();
  renderLiveChip();
  limits.renderLegend();
  $("map").setAttribute("aria-label", t("map.aria"));
  $("limits-hint").textContent = limitsStateText(limitsState);
  if (pendingPick) setChip("pick-chip", t("reportDialog.pick.hint"));
  applyTranslations(document);
});

setInterval(() => void loadHazards({ force: true }), REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void loadHazards({ force: true });
});

// Start everything at once: the live connection, the node's settings and the first reports all wait for the same session.
live.start();
void loadServerConfig();
void loadHazards();
if (tileLayer) {
  tileLayer.once("load", enableLiveUpdates);
  window.setTimeout(enableLiveUpdates, 4000);
} else {
  enableLiveUpdates();
}
