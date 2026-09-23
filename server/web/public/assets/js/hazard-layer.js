import { h } from "./dom.js";
import { filterReports, isCameraType } from "./filter.js";
import { formatAge, formatRemaining, isExpired } from "./format.js";
import { currentTranslator } from "./i18n.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

/** A distinct shape per category (not colour alone), drawn in white on the coloured pin. */
function iconShape(type) {
  const root = svg("svg", { viewBox: "0 0 24 24", width: 18, height: 18, "aria-hidden": "true", focusable: "false" });
  const stroke = { stroke: "#fff", "stroke-width": 2.4, "stroke-linecap": "round", fill: "none" };
  switch (type) {
    case "traffic":
      root.append(svg("path", { ...stroke, d: "M4 7h16M4 12h16M4 17h16" }));
      break;
    case "ice":
      root.append(svg("path", { ...stroke, d: "M12 3v18M4 7.5l16 9M4 16.5l16-9" }));
      break;
    case "accident":
      root.append(svg("path", { ...stroke, d: "M12 4v11" }), svg("circle", { cx: 12, cy: 19.5, r: 1.6, fill: "#fff" }));
      break;
    case "construction":
      root.append(svg("path", { ...stroke, d: "M12 4 21 20H3Z", "stroke-linejoin": "round" }));
      break;
    case "breakdown":
      root.append(svg("circle", { ...stroke, cx: 12, cy: 12, r: 6.5 }), svg("circle", { cx: 12, cy: 12, r: 2, fill: "#fff" }));
      break;
    case "obstacle":
      root.append(svg("path", { ...stroke, d: "M6 6l12 12M18 6 6 18" }));
      break;
    default: // camera categories
      root.append(svg("circle", { ...stroke, cx: 12, cy: 12, r: 8 }), svg("circle", { cx: 12, cy: 12, r: 3, fill: "#fff" }));
  }
  return root;
}

export function reportLatLng(report) {
  const coords = report.position?.coordinates;
  return coords ? [coords[1], coords[0]] : null;
}

/**
 * Hazard markers on the map. Keeps the full set of known reports and shows those the filter allows; a report
 * disappears when it is removed by a live event or when its own expiry time has passed.
 */
export class HazardLayer {
  #reports = new Map();
  #markers = new Map();
  #enabled = new Set();
  #cameraEnabled = false;

  constructor({ map, onVote, onChange = () => {} }) {
    this.map = map;
    this.onVote = onVote;
    this.onChange = onChange;
    this.group = window.L.layerGroup().addTo(map);
    this.timer = window.setInterval(() => this.pruneExpired(), 30_000);
  }

  setFilter(enabledTypes, cameraEnabled) {
    this.#enabled = new Set(enabledTypes);
    this.#cameraEnabled = cameraEnabled;
    this.render();
  }

  replaceAll(reports) {
    this.#reports = new Map(reports.map((report) => [report.id, report]));
    this.render();
  }

  upsert(report) {
    if (report.status && report.status !== "active") {
      this.remove(report.id);
      return;
    }
    const previous = this.#reports.get(report.id);
    this.#reports.set(report.id, { ...previous, ...report });
    this.render();
  }

  remove(id) {
    if (this.#reports.delete(id)) this.render();
  }

  pruneExpired(now = Date.now()) {
    let changed = false;
    for (const [id, report] of this.#reports) {
      if (isExpired(report.expiresAt, now)) {
        this.#reports.delete(id);
        changed = true;
      }
    }
    if (changed) this.render();
  }

  get visible() {
    return filterReports([...this.#reports.values()], this.#enabled, this.#cameraEnabled);
  }

  focus(id) {
    const marker = this.#markers.get(id);
    if (!marker) return;
    this.map.setView(marker.getLatLng(), Math.max(this.map.getZoom(), 15));
    marker.openPopup();
  }

  render() {
    const visible = this.visible;
    const wanted = new Set(visible.map((report) => report.id));
    for (const [id, marker] of this.#markers) {
      if (!wanted.has(id)) {
        this.group.removeLayer(marker);
        this.#markers.delete(id);
      }
    }
    for (const report of visible) {
      const latlng = reportLatLng(report);
      if (!latlng) continue;
      let marker = this.#markers.get(report.id);
      if (!marker) {
        marker = this.#createMarker(report, latlng);
        this.#markers.set(report.id, marker);
        this.group.addLayer(marker);
      } else {
        marker.setLatLng(latlng);
      }
      marker.reportId = report.id;
    }
    this.onChange();
  }

  #createMarker(report, latlng) {
    const tr = currentTranslator();
    const label = tr.t(`type.${report.type}`);
    const pin = h("span", { class: "pin" });
    pin.append(iconShape(report.type));
    const icon = window.L.divIcon({
      className: `hz-icon type-${report.type}${isCameraType(report.type) ? " camera" : ""}`,
      html: pin,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
      popupAnchor: [0, -16],
    });
    const marker = window.L.marker(latlng, { icon, title: label, alt: label, keyboard: true, riseOnHover: true });
    marker.bindPopup(() => this.buildPopup(marker.reportId ?? report.id), { autoPanPadding: [30, 60] });
    return marker;
  }

  /** Popup body for one report, built fresh on every open so times and counters are current. */
  buildPopup(id) {
    const report = this.#reports.get(id);
    const tr = currentTranslator();
    if (!report) return h("p", null, tr.t("report.expired"));
    const now = Date.now();
    const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
    const vote = async (kind) => {
      for (const button of buttons) button.disabled = true;
      status.textContent = await this.onVote(report.id, kind);
      for (const button of buttons) button.disabled = false;
    };
    const buttons = [
      h("button", { type: "button", class: "small primary", onclick: () => vote("stillThere") }, tr.t("report.stillThere")),
      h("button", { type: "button", class: "small", onclick: () => vote("gone") }, tr.t("report.gone")),
    ];
    return h(
      "div",
      null,
      h("h3", null, tr.t(`type.${report.type}`)),
      h("div", null, formatAge(report.reportedAt, now, tr)),
      h("div", null, formatRemaining(report.expiresAt, now, tr)),
      h("div", null, `${tr.t("report.confirmations", { n: report.confirmCount ?? 0 })} · ${tr.t("report.denials", { n: report.denyCount ?? 0 })}`),
      report.speedKmh ? h("div", null, tr.t("report.speed", { kmh: report.speedKmh })) : null,
      // Fixed cameras are confirmed/removed through a different endpoint that web sessions do not get.
      report.type === "fixedSpeedCamera" ? null : h("div", { class: "row" }, buttons),
      status,
    );
  }

  dispose() {
    window.clearInterval(this.timer);
    this.group.remove();
  }
}
