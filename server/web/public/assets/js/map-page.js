import { ApiClient } from "./api.js";
import { loadWebConfig } from "./config.js";
import { clear, h } from "./dom.js";
import { selectableTypes, sortNewestFirst } from "./filter.js";
import { formatAge, formatKm, formatRemaining } from "./format.js";
import { HazardLayer, reportLatLng } from "./hazard-layer.js";
import { applyTranslations, currentTranslator, initI18n, onLangChange, t } from "./i18n.js";
import { mountLayout } from "./layout.js";
import { LimitsLayer, limitsStateText } from "./limits-layer.js";
import { LiveConnection } from "./live.js";
import { describeSubmitFailure, ReportDialog } from "./report-dialog.js";
import { latLngToCell } from "/web/vendor/h3/h3-js.es.js";

const L = window.L;
const LIVE_K = 2;
const REFRESH_MS = 60_000;
const DEFAULT_VIEW = { center: [51.16, 10.45], zoom: 6 };

initI18n();
const config = await loadWebConfig();
mountLayout(config, "map");

const api = new ApiClient();
const $ = (id) => document.getElementById(id);

// ---- what this node allows -------------------------------------------------------------------------------------
let serverConfig = null;
try {
  serverConfig = (await api.get("/v1/config")).data;
} catch {
  $("map-status").textContent = t("map.session.error");
}
const cameraEnabled = serverConfig?.speedCameraNamespaceEnabled === true;
const tileResolution = serverConfig?.regionTileH3Resolution ?? 7;
const types = selectableTypes(cameraEnabled);
const enabledTypes = new Set(types);

// ---- map -------------------------------------------------------------------------------------------------------
const map = L.map("map", { zoomControl: false, attributionControl: false, worldCopyJump: true });
L.control.zoom({ position: "topright" }).addTo(map);
// The panel's size settles after the header/footer are built and after orientation changes: keep Leaflet in step.
new ResizeObserver(() => map.invalidateSize()).observe($("map-panel"));
if (config.tiles) {
  L.tileLayer(config.tiles.url, { maxZoom: config.tiles.maxZoom, detectRetina: false }).addTo(map);
  const attribution = L.control({ position: "bottomright" });
  attribution.onAdd = () => {
    const box = h("div", { class: "leaflet-control-attribution leaflet-control" }, "© ", h("a", { href: config.tiles.attributionUrl, target: "_blank", rel: "noopener noreferrer" }, config.tiles.attributionText.replace(/^©\s*/, "")));
    return box;
  };
  attribution.addTo(map);
}
if (config.region) {
  map.fitBounds(L.latLngBounds(config.region.bounds));
  if (map.getZoom() < 9) map.setZoom(9);
} else {
  map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
}
$("map").setAttribute("aria-label", t("map.aria"));

// ---- hazards ---------------------------------------------------------------------------------------------------
const hazards = new HazardLayer({ map, onVote: vote, onChange: () => renderList() });
hazards.setFilter(enabledTypes, cameraEnabled);

let loadTicket = 0;
let coverage = null;
let lastLoad = { key: "", at: 0 };
const DEDUPE_MS = 3_000;
async function loadHazards({ force = false } = {}) {
  const center = map.getCenter();
  const wanted = map.distance(center, map.getBounds().getNorthEast());
  const radius = Math.min(Math.ceil(wanted), config.limits.maxHazardRadiusM);
  const tooLarge = wanted > config.limits.maxHazardRadiusM;

  // Map init fires several moveend events for one and the same view: do not ask the node three times.
  const key = `${center.lat.toFixed(4)}|${center.lng.toFixed(4)}|${radius}`;
  if (!force && key === lastLoad.key && Date.now() - lastLoad.at < DEDUPE_MS) return;
  lastLoad = { key, at: Date.now() };
  const ticket = ++loadTicket;

  coverage?.remove();
  coverage = null;
  if (tooLarge) {
    coverage = L.circle(center, { radius, color: "#0b5cd5", weight: 1, dashArray: "6 6", fill: false, interactive: false }).addTo(map);
  }
  setChip("area-chip", tooLarge ? t("map.areaTooLarge", { km: formatKm(radius) }) : null);

  try {
    const query = { lat: center.lat.toFixed(6), lng: center.lng.toFixed(6), radiusM: radius };
    const requests = [api.get("/v1/hazard-reports/nearby", query)];
    if (cameraEnabled) requests.push(api.get("/v1/speed-cameras/nearby", query));
    const results = await Promise.all(requests);
    if (ticket !== loadTicket) return;
    hazards.replaceAll([...(results[0].data.reports ?? []), ...(results[1]?.data.cameras ?? [])]);
    $("list-status").textContent = "";
  } catch {
    if (ticket === loadTicket) $("list-status").textContent = t("map.loadError");
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
  } else if (event.entityType === "fixedSpeedCamera" && cameraEnabled) {
    if (event.type === "StaticDataRemoved") hazards.remove(event.entityId);
    else hazards.upsert({ ...payload, id: payload.id ?? event.entityId, type: "fixedSpeedCamera" });
  }
}

function subscribeAroundCenter() {
  const center = map.getCenter();
  live.subscribe(latLngToCell(center.lat, center.lng, tileResolution), LIVE_K);
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
    input.addEventListener("change", () => {
      if (input.checked) enabledTypes.add(type);
      else enabledTypes.delete(type);
      hazards.setFilter(enabledTypes, cameraEnabled);
    });
    box.append(h("label", null, input, h("span", null, tr.t(`type.${type}`))));
  }
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
  clear(list);
  if (items.length === 0) {
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
    const created = data.report ?? data.camera;
    if (created) hazards.upsert(created);
    return { kind: data.merged ? "merged" : "created" };
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
    subscribeAroundCenter();
  }, 400);
  renderList();
});

onLangChange(() => {
  renderFilters();
  renderList();
  renderLiveChip();
  $("map").setAttribute("aria-label", t("map.aria"));
  $("limits-hint").textContent = limitsStateText(limitsState);
  if (pendingPick) setChip("pick-chip", t("reportDialog.pick.hint"));
  applyTranslations(document);
});

setInterval(() => void loadHazards({ force: true }), REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void loadHazards({ force: true });
});

live.start();
subscribeAroundCenter();
void loadHazards();
