import { h } from "./dom.js";
import { speedLimitColor } from "./format.js";
import { currentTranslator } from "./i18n.js";

const MIN_ZOOM = 14;
const DEBOUNCE_MS = 250;
/** Load this much more than the view needs (capped by what the node allows), so panning and zooming in stay inside what is already drawn. */
const MARGIN = 1.6;

/** Legend bands, matching speedLimitColor(). */
const LEGEND = [
  { color: "#0f8a5f", label: "≤ 30" },
  { color: "#c26a00", label: "31–50" },
  { color: "#b5177a", label: "51–70" },
  { color: "#1d5fd0", label: "71–100" },
  { color: "#6b3fd4", label: "> 100" },
];

/**
 * Optional map layer: road segments coloured by speed limit. Only fetched when the current view fits inside what
 * a web session may query (a small radius) — the server's segment query is deliberately not offered for wide views.
 * Only roads with a recorded limit exist in the data, so other roads stay uncoloured (the legend says so).
 * `onState` receives { kind: "off" | "zoom" | "loading" | "ready" | "error", zoom?, count? } for the hint line.
 */
export class LimitsLayer {
  #enabled = false;
  #ticket = 0;
  #timer = null;
  #abort = null;
  /** The circle that is drawn right now (what was requested last). */
  #loaded = null;

  constructor({ map, api, maxRadiusM, onState }) {
    this.map = map;
    this.api = api;
    this.maxRadiusM = maxRadiusM;
    this.onState = onState;
    this.group = window.L.layerGroup();
    this.renderer = window.L.canvas({ padding: 0.5 });
    this.legend = window.L.control({ position: "bottomleft" });
    this.legend.onAdd = () => {
      this.legendBox = h("div", { class: "legend", "aria-hidden": "true" });
      this.renderLegend();
      return this.legendBox;
    };
    map.on("moveend", () => this.schedule());
  }

  /** Fills the legend in the current language (also called after a language switch). */
  renderLegend() {
    if (!this.legendBox) return;
    const tr = currentTranslator();
    const rows = LEGEND.map((band) => h("div", null, h("i", { "data-color": band.color }), `${band.label} km/h`));
    rows.push(h("div", null, h("i", { class: "none" }), tr.t("map.layer.speedlimits.none")));
    this.legendBox.replaceChildren(...rows);
    for (const swatch of this.legendBox.querySelectorAll("i[data-color]")) swatch.style.background = swatch.dataset.color;
  }

  set enabled(value) {
    this.#enabled = value;
    if (value) {
      this.group.addTo(this.map);
      this.legend.addTo(this.map);
      this.schedule(0);
    } else {
      this.#cancel();
      window.clearTimeout(this.#timer);
      this.#loaded = null;
      this.group.clearLayers();
      this.group.remove();
      this.legend.remove();
      this.onState({ kind: "off" });
    }
  }

  get enabled() {
    return this.#enabled;
  }

  #cancel() {
    this.#ticket += 1;
    this.#abort?.abort();
    this.#abort = null;
  }

  schedule(delay = DEBOUNCE_MS) {
    if (!this.#enabled) return;
    window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => void this.refresh(), delay);
  }

  /** Radius (metres) of the smallest circle around the map centre that covers the current view. */
  viewRadiusM() {
    return this.map.distance(this.map.getCenter(), this.map.getBounds().getNorthEast());
  }

  /** Segments that are (at least partly) inside the current view. */
  #visibleCount() {
    const bounds = this.map.getBounds();
    let count = 0;
    for (const polyline of this.group.getLayers()) if (bounds.intersects(polyline.getBounds())) count += 1;
    return count;
  }

  async refresh() {
    if (!this.#enabled) return;
    const center = this.map.getCenter();
    const radius = this.viewRadiusM();
    const zoom = this.map.getZoom();

    if (zoom < MIN_ZOOM || radius > this.maxRadiusM) {
      this.#cancel();
      this.#loaded = null;
      this.group.clearLayers();
      const needed = Math.max(MIN_ZOOM, Math.ceil(zoom + Math.log2(Math.max(radius / this.maxRadiusM, 1))));
      this.onState({ kind: "zoom", zoom: needed });
      return;
    }

    // Zooming in and small pans stay inside what is already drawn: nothing to fetch, nothing flickers.
    if (this.#loaded && this.map.distance(center, this.#loaded.center) + radius <= this.#loaded.radius) {
      this.onState({ kind: "ready", count: this.#visibleCount() });
      return;
    }

    this.#cancel();
    const ticket = this.#ticket;
    const controller = new AbortController();
    this.#abort = controller;
    const requested = Math.min(this.maxRadiusM, Math.ceil(radius * MARGIN));
    // The old drawing stays until the new one is ready; only the hint line says that something is loading.
    this.onState({ kind: "loading" });
    try {
      const { data } = await this.api.get(
        "/v1/speed-limit-segments/nearby",
        { lat: center.lat.toFixed(6), lng: center.lng.toFixed(6), radiusM: requested },
        { signal: controller.signal },
      );
      if (ticket !== this.#ticket) return;
      this.#draw(data.segments ?? []);
      this.#loaded = { center, radius: requested };
      this.onState({ kind: "ready", count: this.#visibleCount() });
    } catch (error) {
      if (ticket !== this.#ticket || error?.name === "AbortError") return;
      this.onState({ kind: "error" });
    }
  }

  #draw(segments) {
    const lines = [];
    for (const segment of segments) {
      const coords = segment.geometry?.coordinates;
      if (!coords || coords.length < 2) continue;
      lines.push(
        window.L.polyline(
          coords.map(([lng, lat]) => [lat, lng]),
          { color: speedLimitColor(segment.speedLimit, segment.speedLimitUnit), weight: 5, opacity: 0.9, lineCap: "round", lineJoin: "round", renderer: this.renderer, interactive: false },
        ),
      );
    }
    // Swap in one go: the canvas is redrawn with the new lines only.
    this.group.clearLayers();
    for (const line of lines) this.group.addLayer(line);
  }
}

/** Text for the hint line under the layer toggle. */
export function limitsStateText(state) {
  const tr = currentTranslator();
  switch (state.kind) {
    case "zoom":
      return tr.t("map.layer.speedlimits.zoomHint", { zoom: state.zoom });
    case "loading":
      return tr.t("map.layer.speedlimits.loading");
    case "ready":
      return tr.tn("map.layer.speedlimits.count", state.count);
    case "error":
      return tr.t("map.layer.speedlimits.error");
    default:
      return tr.t("map.click.hint");
  }
}
