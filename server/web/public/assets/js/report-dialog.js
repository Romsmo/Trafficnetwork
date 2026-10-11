import { h } from "./dom.js";
import { AMOUNT_UNITS, expiryRefusal, expiryRuleFor, formatEndDate, formatExactDuration, parseAmount, quickChoices, splitSeconds } from "./duration.js";
import { normalizeTimestamp } from "./format.js";
import { currentLang, currentTranslator, onLangChange } from "./i18n.js";

/** Maps an API failure to the visitor-facing result the dialog shows. */
export function describeSubmitFailure(error) {
  if (error?.status === 429) {
    const scope = error.details?.scope ?? "";
    const key = scope.startsWith("session") ? "session" : scope.startsWith("node") ? "node" : scope.startsWith("network") ? "network" : "unknown";
    return { kind: "rateLimited", scope: key, minutes: Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60)) };
  }
  // The node refuses a duration outside the bounds of the category (never clamps it) and says which bounds apply.
  const refusal = expiryRefusal(error);
  if (refusal) return { kind: "expiryRefused", ...refusal };
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

  /** `expiry`: the node's `reportExpiry` (bounds per category), or null when it has none — then there is no choice of duration. */
  open({ types, center, expiry = null }) {
    this.#state = {
      types,
      type: null,
      position: { lat: center.lat, lng: center.lng, source: "center" },
      center,
      expiry,
      duration: { mode: "default", amount: "", unit: "hours", error: null },
      result: null,
      sending: false,
      locating: false,
    };
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
        h("input", { type: "radio", name: "type", value: type, required: index === 0 ? true : undefined, checked: s.type === type ? true : undefined, disabled: succeeded || s.sending ? true : undefined, onchange: () => {
          s.type = type;
          s.result = null;
          this.#renderDuration();
        } }),
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
      (this.durationBox = h("div", { class: "duration-box" })),
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
    this.#renderDuration();
  }

  /**
   * "How long should the report stay": the category's default, or a duration of the visitor's own inside the bounds the node
   * publishes. Not shown for a category without bounds (fixed cameras never expire; an older node has no choice to offer).
   */
  #renderDuration() {
    const s = this.#state;
    const box = this.durationBox;
    if (!s || !box) return;
    const rule = s.type ? expiryRuleFor(s.expiry, s.type) : null;
    if (!rule) {
      box.replaceChildren();
      return;
    }
    const tr = currentTranslator();
    const d = s.duration;
    const locked = Boolean(s.result && (s.result.kind === "created" || s.result.kind === "merged" || s.result.kind === "accepted")) || s.sending;
    const custom = d.mode === "custom";
    const amountId = "report-duration-amount";
    const unitId = "report-duration-unit";
    const errorId = "report-duration-error";

    const apply = () => {
      d.error = null;
      this.#renderDuration();
    };
    const quick = h(
      "div",
      { class: "chip-row", role: "group", "aria-label": tr.t("reportDialog.duration.quick") },
      quickChoices(rule).map((seconds) => {
        const split = splitSeconds(seconds);
        const pressed = custom && d.amount === String(split.amount) && d.unit === split.unit;
        return h(
          "button",
          {
            type: "button",
            class: "chip-button",
            "aria-pressed": String(pressed),
            disabled: locked ? true : undefined,
            onclick: () => {
              d.amount = String(split.amount);
              d.unit = split.unit;
              apply();
            },
          },
          formatExactDuration(seconds, tr),
        );
      }),
    );
    const amount = h("input", {
      id: amountId,
      type: "text",
      inputmode: "numeric",
      autocomplete: "off",
      value: d.amount,
      disabled: locked ? true : undefined,
      "aria-describedby": d.error ? errorId : "report-duration-range",
      "aria-invalid": d.error ? "true" : undefined,
    });
    amount.addEventListener("input", () => {
      d.amount = amount.value;
      d.error = null;
      for (const chip of quick.querySelectorAll("button")) chip.setAttribute("aria-pressed", "false");
    });
    const unit = h(
      "select",
      { id: unitId, disabled: locked ? true : undefined, onchange: (event) => (d.unit = event.target.value) },
      AMOUNT_UNITS.map((u) => h("option", { value: u.id, selected: d.unit === u.id ? true : undefined }, tr.t(`duration.${u.id}.unit`))),
    );

    box.replaceChildren(
      h(
        "fieldset",
        { class: "duration" },
        h("legend", null, tr.t("reportDialog.duration.legend")),
        h(
          "div",
          { class: "choice-grid" },
          h(
            "label",
            null,
            h("input", { type: "radio", name: "duration", value: "default", checked: !custom ? true : undefined, disabled: locked ? true : undefined, onchange: () => { d.mode = "default"; apply(); } }),
            h("span", null, tr.t("reportDialog.duration.default", { duration: formatExactDuration(rule.defaultSeconds, tr) })),
          ),
          h(
            "label",
            null,
            h("input", { type: "radio", name: "duration", value: "custom", checked: custom ? true : undefined, disabled: locked ? true : undefined, onchange: () => { d.mode = "custom"; apply(); } }),
            h("span", null, tr.t("reportDialog.duration.custom")),
          ),
        ),
        ...(custom
          ? [
              h(
                "div",
                { class: "duration-custom" },
                quick,
                h(
                  "div",
                  { class: "field-row" },
                  h("div", { class: "field" }, h("label", { for: amountId }, tr.t("reportDialog.duration.amount")), amount),
                  h("div", { class: "field" }, h("label", { for: unitId }, tr.t("reportDialog.duration.unit")), unit),
                ),
                h("p", { id: "report-duration-range", class: "hint" }, tr.t("reportDialog.duration.range", { min: formatExactDuration(rule.minSeconds, tr), max: formatExactDuration(rule.maxSeconds, tr) })),
                d.error ? h("p", { id: errorId, class: "result bad", role: "alert" }, d.error) : null,
              ),
            ]
          : []),
      ),
    );
  }

  /** The duration to send: undefined for "the category's default", a number of seconds for a valid own choice, or null (invalid, message shown). */
  #chosenDuration() {
    const s = this.#state;
    const rule = s.type ? expiryRuleFor(s.expiry, s.type) : null;
    if (!rule || s.duration.mode !== "custom") return undefined;
    const tr = currentTranslator();
    const parsed = parseAmount(s.duration.amount, s.duration.unit, rule);
    if (parsed.ok) return parsed.seconds;
    const bounds = { min: formatExactDuration(rule.minSeconds, tr), max: formatExactDuration(rule.maxSeconds, tr) };
    s.duration.error = tr.t(`reportDialog.duration.error.${parsed.reason}`, bounds);
    this.#renderDuration();
    this.dialog.querySelector("#report-duration-amount")?.focus();
    return null;
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
      case "expiryRefused":
        text = tr.t("reportDialog.result.expiryRefused", { min: formatExactDuration(result.minSeconds, tr), max: formatExactDuration(result.maxSeconds, tr) });
        break;
      case "locateDenied":
        text = tr.t("map.locate.denied");
        break;
      default:
        text = tr.t("reportDialog.result.error");
    }
    // The end of the report as the node set it (it may differ from the request when the report was merged into an existing one).
    if (ok && result.expiresAt) {
      const until = formatEndDate(result.expiresAt, currentLang(), normalizeTimestamp);
      if (until) text = `${text} ${tr.t("reportDialog.result.until", { date: until })}`;
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
    const expiresInSeconds = this.#chosenDuration();
    if (expiresInSeconds === null) return;
    s.sending = true;
    s.result = null;
    this.render();
    s.result = await this.onSubmit({ type: s.type, lat: s.position.lat, lng: s.position.lng, ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}) });
    s.sending = false;
    this.render();
  }
}
