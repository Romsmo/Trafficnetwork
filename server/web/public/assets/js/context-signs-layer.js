import { h } from "./dom.js";
import { describeValidity, signName, signPictogram } from "./context-signs-data.js";
import { currentLang, currentTranslator } from "./i18n.js";

const MIN_ZOOM = 12;
const DEBOUNCE_MS = 300;
const MARGIN = 1.4;
const LIMIT = 500;

const COLORS = { prohibition: "#b71c1c", hazard: "#b26a00" };

function bearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
  const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad) - Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

/** Maps an API failure of a vote to the text the popup shows. */
function failureKey(error) {
  if (error?.status === 429) return "signs.vote.limited";
  if (error?.status === 404) return "signs.vote.gone";
  if (error?.status >= 400 && error?.status < 500) return "signs.vote.rejected";
  return "signs.vote.error";
}

/**
 * Map layer "traffic signs on stretches" (docs/context-signs.md): every entry in view as a line along the road, a small sign at
 * its start, an arrow where it applies one way only. Unconfirmed entries are dashed. Click or Enter on a sign opens its details
 * with the buttons to confirm or object. Only fetched while the layer is on and the view is zoomed in enough.
 * `onState` receives { kind: "off" | "zoom" | "loading" | "ready" | "error", count? }.
 */
export class ContextSignLayer {
  #enabled = false;
  #timer = null;
  #abort = null;
  #entries = [];

  constructor({ map, api, onState }) {
    this.map = map;
    this.api = api;
    this.onState = onState;
    this.group = window.L.layerGroup();
    map.on("moveend", () => this.schedule());
  }

  get enabled() {
    return this.#enabled;
  }

  set enabled(value) {
    this.#enabled = value;
    if (value) {
      this.group.addTo(this.map);
      this.schedule(0);
    } else {
      this.#abort?.abort();
      window.clearTimeout(this.#timer);
      this.group.clearLayers();
      this.group.remove();
      this.#entries = [];
      this.onState({ kind: "off" });
    }
  }

  /** The entries drawn right now (for tests and for the list). */
  get entries() {
    return this.#entries;
  }

  schedule(delay = DEBOUNCE_MS) {
    if (!this.#enabled) return;
    window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => void this.#load(), delay);
  }

  /** Loads again at once (after the visitor entered or voted on a sign). */
  refresh() {
    if (this.#enabled) void this.#load();
  }

  async #load() {
    if (this.map.getZoom() < MIN_ZOOM) {
      this.#abort?.abort();
      this.group.clearLayers();
      this.#entries = [];
      this.onState({ kind: "zoom" });
      return;
    }
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    const bounds = this.map.getBounds().pad(MARGIN - 1);
    const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map((n) => n.toFixed(5)).join(",");
    this.onState({ kind: "loading" });
    try {
      const { data } = await this.api.get("/v1/context-signs", { bbox, limit: LIMIT }, { signal: abort.signal });
      if (abort.signal.aborted) return;
      this.#entries = data.entries ?? [];
      this.#draw();
      this.onState({ kind: "ready", count: this.#entries.length });
    } catch (error) {
      if (abort.signal.aborted || error?.name === "AbortError") return;
      this.onState({ kind: "error" });
    }
  }

  #draw() {
    this.group.clearLayers();
    const L = window.L;
    for (const entry of this.#entries) {
      const kind = entry.signType.startsWith("DE:1") ? "hazard" : "prohibition";
      const latlngs = entry.geometry.map(([lng, lat]) => [lat, lng]);
      L.polyline(latlngs, {
        color: COLORS[kind],
        weight: entry.confirmed ? 6 : 4,
        opacity: entry.confirmed ? 0.85 : 0.65,
        dashArray: entry.confirmed ? undefined : "8 8",
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
        className: `ctx-line ctx-${kind}${entry.confirmed ? "" : " ctx-unconfirmed"}`,
      }).addTo(this.group);

      const lang = currentLang();
      const name = signName(entry.signType, lang);
      const icon = L.divIcon({
        className: "ctx-marker",
        html: signPictogram(entry.signType, { size: 30 }),
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      });
      const marker = L.marker(latlngs[0], { icon, keyboard: true, title: name, alt: name, riseOnHover: true }).addTo(this.group);
      marker.bindPopup(() => this.#popup(entry), { minWidth: 240, maxWidth: 340, autoPanPadding: [30, 60] });

      if (entry.direction === "along" && entry.geometry.length >= 2) {
        const end = entry.geometry.at(-1);
        const before = entry.geometry.at(-2);
        const arrow = h("span", { class: "ctx-arrow", "aria-hidden": "true" }, "▲");
        const angle = bearing(before, end);
        L.marker([end[1], end[0]], { icon: L.divIcon({ className: "ctx-arrow-icon", html: arrow, iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, keyboard: false }).addTo(this.group);
        arrow.style.transform = `rotate(${angle.toFixed(0)}deg)`;
      }
    }
  }

  #popup(entry) {
    const tr = currentTranslator();
    const lang = tr.lang;
    const status = h("p", { class: "ctx-status" });
    const renderStatus = (e) => {
      status.textContent = e.confirmed ? tr.tn("signs.status.confirmed", e.confirmations) : tr.t("signs.status.proposed", { n: e.confirmations });
      if (e.denials > 0) status.textContent += ` ${tr.tn("signs.status.denials", e.denials)}`;
    };
    renderStatus(entry);
    const result = h("p", { class: "hint", role: "status", "aria-live": "polite" });
    const buttons = [];
    const vote = async (kind) => {
      for (const b of buttons) b.disabled = true;
      result.textContent = "";
      try {
        const { data } = await this.api.post(`/v1/context-signs/${entry.id}/confirmations`, { kind });
        if (data.entry) renderStatus(data.entry);
        result.textContent = tr.t(data.noop ? "signs.vote.already" : "signs.vote.thanks");
        this.refresh();
      } catch (error) {
        result.textContent = tr.t(failureKey(error));
        for (const b of buttons) b.disabled = false;
      }
    };
    buttons.push(
      h("button", { type: "button", class: "small", onclick: () => void vote("confirm") }, tr.t("signs.vote.confirm")),
      h("button", { type: "button", class: "small", onclick: () => void vote("deny") }, tr.t("signs.vote.deny")),
    );

    const directionText = entry.direction === "along" ? tr.t("signs.direction.along") : tr.t("signs.direction.both");
    const value = entry.value !== null && entry.value !== undefined ? ` ${String(entry.value).replace(".", lang === "de" ? "," : ".")} ${entry.unit}` : "";
    return h(
      "div",
      { class: "ctx-popup" },
      h("div", { class: "ctx-head" }, signPictogram(entry.signType, { size: 44 }), h("div", null, h("strong", null, signName(entry.signType, lang)), h("span", { class: "hint" }, ` ${entry.signType.replace(/^[A-Z]{2}:/, "")}${value}`))),
      h(
        "dl",
        { class: "facts" },
        h("dt", null, tr.t("signs.detail.when")),
        h("dd", null, describeValidity(entry.validity, tr.t, lang)),
        h("dt", null, tr.t("signs.detail.direction")),
        h("dd", null, directionText),
        h("dt", null, tr.t("signs.detail.length")),
        h("dd", null, `${entry.lengthM} m`),
      ),
      status,
      h("p", { class: "hint" }, tr.t("signs.disclaimer")),
      h("div", { class: "dialog-actions" }, buttons),
      result,
    );
  }
}
