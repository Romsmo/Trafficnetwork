import { h } from "./dom.js";
import { currentTranslator, onLangChange } from "./i18n.js";

/** Maps an API failure to the visitor-facing result the dialog shows. */
export function describeSubmitFailure(error) {
  if (error?.status === 429) {
    const scope = error.details?.scope ?? "";
    const key = scope.startsWith("session") ? "session" : scope.startsWith("node") ? "node" : scope.startsWith("network") ? "network" : "unknown";
    return { kind: "rateLimited", scope: key, minutes: Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60)) };
  }
  if (error?.status >= 400 && error?.status < 500) return { kind: "rejected", reason: error.message };
  return { kind: "error" };
}

/**
 * The "report a hazard" dialog (native <dialog>, so focus trapping, Escape and the backdrop come for free).
 * The position is one of: the map centre, a spot picked on the map, or the visitor's location — the latter only
 * after they press its button (the browser then asks for permission); it is used once and never kept.
 */
export class ReportDialog {
  #state = null;
  #open = false;

  constructor({ dialog, onSubmit, onPickRequested }) {
    this.dialog = dialog;
    this.onSubmit = onSubmit;
    this.onPickRequested = onPickRequested;
    dialog.addEventListener("close", () => {
      this.#open = false;
    });
    onLangChange(() => {
      if (this.#open) this.render();
    });
  }

  open({ types, center }) {
    this.#state = { types, type: null, position: { lat: center.lat, lng: center.lng, source: "center" }, center, result: null, sending: false, locating: false };
    this.render();
    this.show();
  }

  /** Re-opens after the visitor picked a spot on the map. */
  resumeWithPosition(latlng) {
    if (!this.#state) return;
    this.#state.position = { lat: latlng.lat, lng: latlng.lng, source: "pick" };
    this.render();
    this.show();
  }

  show() {
    if (!this.dialog.open) this.dialog.showModal();
    this.#open = true;
  }

  close() {
    this.dialog.close();
  }

  render() {
    const s = this.#state;
    if (!s) return;
    const tr = currentTranslator();
    const succeeded = s.result && (s.result.kind === "created" || s.result.kind === "merged" || s.result.kind === "accepted");

    const typeChoices = s.types.map((type, index) =>
      h(
        "label",
        null,
        h("input", { type: "radio", name: "type", value: type, required: index === 0 ? true : undefined, checked: s.type === type ? true : undefined, disabled: succeeded || s.sending ? true : undefined, onchange: () => (s.type = type) }),
        h("span", null, tr.t(`type.${type}`)),
      ),
    );

    const positionText = tr.t("reportDialog.position.selected", { lat: s.position.lat.toFixed(5), lng: s.position.lng.toFixed(5) });
    const positionButtons = [
      h("button", { type: "button", class: "small", disabled: succeeded || s.sending ? true : undefined, onclick: () => this.#setPosition({ ...s.center, source: "center" }) }, tr.t("reportDialog.position.center")),
      h("button", { type: "button", class: "small", disabled: succeeded || s.sending ? true : undefined, onclick: () => this.#pick() }, tr.t("reportDialog.position.pick")),
      h("button", { type: "button", class: "small", disabled: succeeded || s.sending || s.locating ? true : undefined, onclick: () => this.#locate() }, tr.t("reportDialog.position.locate")),
    ];

    const form = h(
      "form",
      { method: "dialog", onsubmit: (event) => void this.#submit(event) },
      h("h2", { id: "report-dialog-title" }, tr.t("reportDialog.title")),
      h("p", { class: "hint" }, tr.t("reportDialog.safety")),
      h("fieldset", null, h("legend", null, tr.t("reportDialog.type")), h("div", { class: "choice-grid" }, typeChoices)),
      h(
        "fieldset",
        null,
        h("legend", null, tr.t("reportDialog.position")),
        h("p", { id: "report-position", role: "status" }, positionText),
        h("div", { class: "dialog-actions" }, positionButtons),
      ),
      h("p", { class: "hint" }, tr.t("reportDialog.privacy")),
      s.result ? this.#resultBox(s.result, tr) : null,
      h(
        "div",
        { class: "dialog-actions" },
        h("button", { type: "button", onclick: () => this.close() }, succeeded ? tr.t("reportDialog.close") : tr.t("reportDialog.cancel")),
        succeeded ? null : h("button", { type: "submit", class: "primary", disabled: s.sending ? true : undefined }, s.sending ? tr.t("reportDialog.sending") : tr.t("reportDialog.submit")),
      ),
    );
    this.dialog.setAttribute("aria-labelledby", "report-dialog-title");
    this.dialog.replaceChildren(form);
  }

  #resultBox(result, tr) {
    let text;
    let ok = false;
    switch (result.kind) {
      case "created":
        text = tr.t("reportDialog.result.created");
        ok = true;
        break;
      case "merged":
        text = tr.t("reportDialog.result.merged");
        ok = true;
        break;
      case "accepted":
        // A speed-camera report the node does not show as a single spot (it shows areas, or nothing, for that country).
        text = tr.t(result.zone ? "reportDialog.result.acceptedZone" : "reportDialog.result.acceptedHidden");
        ok = true;
        break;
      case "rateLimited":
        text = tr.t("reportDialog.result.rateLimited", { scope: tr.t(`scope.${result.scope}`), minutes: result.minutes });
        break;
      case "rejected":
        text = tr.t("reportDialog.result.rejected", { reason: result.reason });
        break;
      case "locateDenied":
        text = tr.t("map.locate.denied");
        break;
      default:
        text = tr.t("reportDialog.result.error");
    }
    // A report in a category the visitor has switched off would be invisible to them: say how to see it.
    if (ok && result.filterOffType) text = `${text} ${tr.t("reportDialog.result.filterOff", { type: tr.t(`type.${result.filterOffType}`) })}`;
    return h("p", { class: `result ${ok ? "ok" : "bad"}`, role: "status", "aria-live": "polite" }, text);
  }

  #setPosition(position) {
    this.#state.position = position;
    this.#state.result = null;
    this.render();
  }

  #pick() {
    this.close();
    this.onPickRequested((latlng) => this.resumeWithPosition(latlng), () => this.show());
  }

  #locate() {
    const s = this.#state;
    if (!("geolocation" in navigator)) {
      s.result = { kind: "locateDenied" };
      this.render();
      return;
    }
    s.locating = true;
    this.render();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        s.locating = false;
        s.position = { lat: pos.coords.latitude, lng: pos.coords.longitude, source: "locate" };
        s.result = null;
        this.render();
      },
      () => {
        s.locating = false;
        s.result = { kind: "locateDenied" };
        this.render();
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  }

  async #submit(event) {
    event.preventDefault();
    const s = this.#state;
    if (!s.type || s.sending) return;
    s.sending = true;
    s.result = null;
    this.render();
    s.result = await this.onSubmit({ type: s.type, lat: s.position.lat, lng: s.position.lng });
    s.sending = false;
    this.render();
  }
}
