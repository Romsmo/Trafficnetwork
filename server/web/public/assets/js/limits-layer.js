import { h } from "./dom.js";
import { speedLimitColor } from "./format.js";
import { currentTranslator } from "./i18n.js";

const MIN_ZOOM = 14;
const DEBOUNCE_MS = 450;

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
 * `onState` receives { kind: "off" | "zoom" | "loading" | "ready" | "error", zoom?, count? } for the hint line.
 */
export class LimitsLayer {
  #enabled = false;
  #ticket = 0;
  #timer = null;

  constructor({ map, api, maxRadiusM, onState }) {
    this.map = map;
    this.api = api;
    this.maxRadiusM = maxRadiusM;
    this.onState = onState;
    this.group = window.L.layerGroup();
    this.renderer = window.L.canvas({ padding: 0.4 });
    this.legend = window.L.control({ position: "bottomleft" });
    this.legend.onAdd = () => {
      const box = h("div", { class: "legend", "aria-hidden": "true" }, LEGEND.map((band) => h("div", null, h("i", { "data-color": band.color }), `${band.label} km/h`)));
      for (const swatch of box.querySelectorAll("i[data-color]")) swatch.style.background = swatch.dataset.color;
      return box;
    };
    map.on("moveend", () => this.schedule());
  }

  set enabled(value) {
    this.#enabled = value;
    if (value) {
      this.group.addTo(this.map);
      this.legend.addTo(this.map);
      this.schedule(0);
    } else {
      this.#ticket += 1;
      window.clearTimeout(this.#timer);
      this.group.clearLayers();
      this.group.remove();
      this.legend.remove();
      this.onState({ kind: "off" });
    }
  }

  get enabled() {
    return this.#enabled;
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

  async refresh() {
    if (!this.#enabled) return;
    const ticket = ++this.#ticket;
    const radius = this.viewRadiusM();
    const zoom = this.map.getZoom();
    if (zoom < MIN_ZOOM || radius > this.maxRadiusM) {
      this.group.clearLayers();
      const needed = Math.max(MIN_ZOOM, zoom + Math.ceil(Math.log2(Math.max(radius / this.maxRadiusM, 1))));
      this.onState({ kind: "zoom", zoom: needed });
      return;
    }
    this.onState({ kind: "loading" });
    try {
      const center = this.map.getCenter();
      const { data } = await this.api.get("/v1/speed-limit-segments/nearby", {
        lat: center.lat.toFixed(6),
        lng: center.lng.toFixed(6),
        radiusM: Math.ceil(radius),
      });
      if (ticket !== this.#ticket) return;
      this.group.clearLayers();
      for (const segment of data.segments ?? []) {
        const coords = segment.geometry?.coordinates;
        if (!coords || coords.length < 2) continue;
        window.L.polyline(
          coords.map(([lng, lat]) => [lat, lng]),
          { color: speedLimitColor(segment.speedLimit, segment.speedLimitUnit), weight: 5, opacity: 0.9, renderer: this.renderer, interactive: false },
        ).addTo(this.group);
      }
      this.onState({ kind: "ready", count: (data.segments ?? []).length });
    } catch {
      if (ticket === this.#ticket) this.onState({ kind: "error" });
    }
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
