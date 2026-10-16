import { h } from "./dom.js";
import { currentLang, currentTranslator, onLangChange } from "./i18n.js";

const MIN_CHARS = 2;

/** "Postau, Landkreis Landshut, Bayern" with the name "Postau" -> "Landkreis Landshut, Bayern". */
export function labelRest(place) {
  const label = String(place.label ?? "");
  const name = String(place.name ?? "");
  if (name && label.startsWith(`${name}, `)) return label.slice(name.length + 2);
  if (label === name) return "";
  return label;
}

/**
 * The search box of the map page: type a place, press Enter (or the magnifier), pick a hit, the map goes there.
 *
 * It asks this node (`GET /v1/places/search`), never a third party directly - the node talks to the place service, so the page needs no
 * new connection and the service never sees the visitor (docs/place-search.md). It searches when asked, not while typing: the
 * public service forbids search-as-you-type, and a half-typed address is nobody's business.
 */
export class PlaceSearch {
  /**
   * @param api         the page's ApiClient
   * @param form        the <form>; contains `input[name=q]`, the clear button, the panel with a status line and the result list
   * @param getNear     () => {lat, lng} the map centre, so places around it rank first (rounded before it is sent)
   * @param onSelect    (place) => void - the visitor chose a hit
   * @param onClear     () => void - the visitor emptied the box (the page removes its marker)
   */
  constructor({ api, form, getNear, onSelect, onClear = () => {} }) {
    Object.assign(this, { api, form, getNear, onSelect, onClear });
    this.input = form.querySelector("input[name=q]");
    this.clearButton = form.querySelector("[data-place-clear]");
    this.panel = form.querySelector("[data-place-panel]");
    this.status = form.querySelector("[data-place-status]");
    this.list = form.querySelector("[data-place-results]");
    this.ticket = 0;
    this.places = [];

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.search();
    });
    this.input.addEventListener("input", () => {
      this.clearButton.hidden = this.input.value === "";
      // what was shown belongs to the old text
      if (!this.panel.hidden) this.closePanel();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && this.firstButton()) {
        event.preventDefault();
        this.firstButton().focus();
      } else if (event.key === "Escape") {
        if (!this.panel.hidden) {
          event.preventDefault();
          this.closePanel();
        }
      }
    });
    this.list.addEventListener("keydown", (event) => this.onListKey(event));
    this.clearButton.addEventListener("click", () => {
      this.clear();
      this.input.focus();
    });
    // a tap or click outside the box puts the list away; a tap on the map is still a tap on the map
    document.addEventListener("pointerdown", (event) => {
      if (!this.panel.hidden && !form.contains(event.target)) this.closePanel();
    });
    onLangChange(() => this.renderStatusAgain());
  }

  firstButton() {
    return this.list.querySelector("button");
  }

  onListKey(event) {
    const buttons = [...this.list.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[Math.min(buttons.length - 1, index + 1)].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) this.input.focus();
      else buttons[index - 1].focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.closePanel();
      this.input.focus();
    }
  }

  setStatus(kind, params = {}) {
    this.statusState = { kind, params };
    this.renderStatusAgain();
  }

  renderStatusAgain() {
    if (!this.statusState) return;
    const tr = currentTranslator();
    const { kind, params } = this.statusState;
    this.status.textContent = kind === "found" ? tr.tn("place.found", params.count) : tr.t(`place.${kind}`, params);
    this.status.classList.toggle("bad", kind === "error" || kind === "rateLimited" || kind === "short");
  }

  openPanel() {
    this.panel.hidden = false;
  }

  closePanel() {
    this.panel.hidden = true;
  }

  clear() {
    this.ticket += 1;
    this.input.value = "";
    this.clearButton.hidden = true;
    this.places = [];
    this.list.replaceChildren();
    this.closePanel();
    this.onClear();
  }

  async search() {
    const q = this.input.value.trim().replace(/\s+/g, " ");
    this.list.replaceChildren();
    this.openPanel();
    if (q.length < MIN_CHARS) {
      this.setStatus("short");
      return;
    }
    const ticket = ++this.ticket;
    this.setStatus("searching");
    const query = { q, lang: currentLang() === "en" ? "en" : "de" };
    const near = this.getNear();
    // about 10 km: enough to prefer what is around the map, too little to say where somebody is
    if (near) Object.assign(query, { lat: near.lat.toFixed(1), lng: near.lng.toFixed(1) });
    try {
      const { data } = await this.api.get("/v1/places/search", query);
      if (ticket !== this.ticket) return;
      this.places = Array.isArray(data?.places) ? data.places : [];
    } catch (error) {
      if (ticket !== this.ticket) return;
      this.places = [];
      this.setStatus(error?.status === 429 ? "rateLimited" : "error");
      return;
    }
    if (this.places.length === 0) {
      this.setStatus("none");
      return;
    }
    this.setStatus("found", { count: this.places.length });
    for (const place of this.places) {
      const rest = labelRest(place);
      this.list.append(
        h(
          "li",
          null,
          h(
            "button",
            { type: "button", class: "place-result", onclick: () => this.choose(place) },
            h("span", { class: "place-name" }, place.name),
            rest ? h("span", { class: "place-rest" }, rest) : null,
          ),
        ),
      );
    }
  }

  choose(place) {
    this.input.value = place.name;
    this.clearButton.hidden = false;
    this.closePanel();
    this.onSelect(place);
  }
}
