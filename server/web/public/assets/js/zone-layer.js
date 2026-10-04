import { h } from "./dom.js";
import { filterZones, zoneLatLngs, zoneTypes } from "./filter.js";
import { currentTranslator } from "./i18n.js";

/**
 * Speed-camera areas on the map. Where the node shows cameras only as areas (level `zones`), it delivers a coarse cell instead of
 * single spots — so the page draws an AREA, dashed and translucent, and says in its popup that the exact place is not known.
 * Never a pin: a pin would suggest an accuracy that is not there.
 */
const STYLE = { className: "cam-zone", color: "#7c2d12", weight: 2, dashArray: "6 4", fillColor: "#f97316", fillOpacity: 0.22 };

function typesText(zone, enabledTypes, tr) {
  return zoneTypes(zone, enabledTypes)
    .map((type) => tr.t(`type.${type}`))
    .join(", ");
}

export class ZoneLayer {
  #zones = new Map();
  #layers = new Map();
  #enabled = new Set();
  #available = false;

  constructor({ map, onChange = () => {} }) {
    this.map = map;
    this.onChange = onChange;
    this.group = window.L.layerGroup().addTo(map);
  }

  setFilter(enabledTypes, available) {
    this.#enabled = new Set(enabledTypes);
    this.#available = available;
    this.render();
  }

  replaceAll(zones) {
    this.#zones = new Map(zones.map((zone) => [zone.id, zone]));
    this.render();
  }

  /** A live update: the zone as it is now, or — when no camera is left in the cell — its removal. */
  upsert(zone) {
    if (!zone?.id) return;
    if (zone.status === "removed") {
      this.remove(zone.id);
      return;
    }
    this.#zones.set(zone.id, zone);
    this.render();
  }

  remove(id) {
    if (this.#zones.delete(id)) this.render();
  }

  get visible() {
    return filterZones([...this.#zones.values()], this.#enabled, this.#available);
  }

  /** The text for a zone: which kinds are in it, as the filter currently shows them. */
  describe(zone) {
    return typesText(zone, this.#enabled, currentTranslator());
  }

  focus(id) {
    const layer = this.#layers.get(id);
    if (!layer) return;
    this.map.fitBounds(layer.getBounds(), { maxZoom: 14, padding: [30, 30] });
    layer.openPopup();
  }

  render() {
    const visible = this.visible;
    const wanted = new Set(visible.map((zone) => zone.id));
    for (const [id, layer] of this.#layers) {
      if (!wanted.has(id)) {
        this.group.removeLayer(layer);
        this.#layers.delete(id);
      }
    }
    for (const zone of visible) {
      const latlngs = zoneLatLngs(zone);
      if (!latlngs) continue;
      let layer = this.#layers.get(zone.id);
      if (layer) {
        layer.setLatLngs(latlngs);
      } else {
        layer = window.L.polygon(latlngs, STYLE);
        layer.zoneId = zone.id;
        layer.bindPopup(() => this.#popup(layer.zoneId), { autoPanPadding: [30, 60] });
        layer.on("add", () => this.#makeKeyboardReachable(layer));
        this.#layers.set(zone.id, layer);
        this.group.addLayer(layer);
      }
    }
    this.onChange();
  }

  /** An SVG path is not focusable by itself; the list next to the map offers the same areas for keyboard users, and this makes the shape itself reachable too. */
  #makeKeyboardReachable(layer) {
    const element = layer.getElement?.();
    if (!element) return;
    element.setAttribute("tabindex", "0");
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", currentTranslator().t("zone.title"));
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        layer.openPopup();
      }
    });
  }

  #popup(id) {
    const zone = this.#zones.get(id);
    const tr = currentTranslator();
    if (!zone) return h("p", null, tr.t("report.expired"));
    return h("div", null, h("h3", null, tr.t("zone.title")), h("p", null, tr.t("zone.body", { types: typesText(zone, this.#enabled, tr) })));
  }

  dispose() {
    this.group.remove();
  }
}
