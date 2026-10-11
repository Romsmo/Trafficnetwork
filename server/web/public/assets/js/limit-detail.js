import { h } from "./dom.js";
import { currentTranslator, onLangChange } from "./i18n.js";
import {
  AXES,
  MISSING_REASONS,
  WRONG_REASONS,
  classifyLookup,
  correctionSettings,
  describeCorrectionError,
  describeOrigin,
  describeVoteResult,
  gapProposalsNear,
  openProposals,
  quickValues,
  validateValue,
} from "./limit-info.js";

let counter = 0;
const uid = (prefix) => `${prefix}-${(counter += 1)}`;

/** A small picture of the four road axes: a ring with the line through it, drawn in the direction the choice names. */
function axisPicture(bearingDegrees) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "-20 -20 40 40");
  svg.setAttribute("width", "36");
  svg.setAttribute("height", "36");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "axis-picture");
  const ring = document.createElementNS(NS, "circle");
  ring.setAttribute("r", "17");
  ring.setAttribute("class", "axis-ring");
  const line = document.createElementNS(NS, "path");
  line.setAttribute("d", "M0 -14 L0 14");
  line.setAttribute("class", "axis-line");
  line.setAttribute("transform", `rotate(${bearingDegrees})`);
  const north = document.createElementNS(NS, "path");
  north.setAttribute("d", "M0 -19 L3 -14 L-3 -14 Z");
  north.setAttribute("class", "axis-north");
  svg.append(ring, line, north);
  return svg;
}

/**
 * What the visitor sees after tapping the map: the speed limit there with its origin, open proposals they can confirm or deny, and
 * the two ways to improve the data — "that's wrong?" (an existing road) and "add a speed limit" (a road with none on record).
 *
 * The element is rendered once and kept: the page puts it into a popup (desktop) or the bottom sheet (phone). Every answer is told
 * honestly (new / merged into an existing proposal / nothing changed / refused, and why), and a proposal from this page counts on
 * this node only, which the page says.
 */
export class LimitDetail {
  #state = { phase: "idle" };
  #ticket = 0;
  #focusNext = false;

  /**
   * @param api            the page's ApiClient
   * @param getServerConfig  () => the node's GET /v1/config answer (or null while unknown)
   * @param getCells         (latlng) => Promise<string[]> H3 cells around a point, for discovering open "no limit" proposals
   * @param onPreview        ({lat,lng}|null, bearing?) — draws or clears the line that shows the chosen road axis on the map
   * @param onChanged        called after a vote or proposal was accepted (the page redraws its road colours)
   * @param onLayout         called after the content changed size (a popup re-fits itself)
   */
  constructor({ api, getServerConfig, getCells = async () => [], onPreview = () => {}, onChanged = () => {}, onLayout = () => {} }) {
    Object.assign(this, { api, getServerConfig, getCells, onPreview, onChanged, onLayout });
    this.element = h("div", { class: "limit-detail" });
    // The element lives in a map popup on wide screens. A button that re-renders its own content has left the DOM by the time the click
    // reaches the map, which then takes it for a tap on the map and looks up the road under the button. Stop it here, where it still has a home.
    this.element.addEventListener("click", (event) => event.stopPropagation());
    onLangChange(() => {
      if (this.#state.phase !== "idle") this.render();
    });
  }

  get settings() {
    return correctionSettings(this.getServerConfig());
  }

  /** Looks up the speed limit at `latlng` and renders the answer. `toleranceM` is how far from a road a tap still counts as on it. */
  async show(latlng, toleranceM) {
    const ticket = ++this.#ticket;
    this.#state = { phase: "loading", latlng, toleranceM, votes: {} };
    this.onPreview(null);
    this.#focusNext = true;
    this.render();
    try {
      let lookup = null;
      try {
        const { data } = await this.api.get("/v1/speed-limit", { lat: latlng.lat.toFixed(6), lng: latlng.lng.toFixed(6) });
        lookup = data;
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
      const classification = classifyLookup(lookup, toleranceM);
      const proposals = await this.#loadProposals(latlng, classification, lookup);
      if (ticket !== this.#ticket) return;
      this.#state = { ...this.#state, phase: "view", lookup, classification, proposals };
    } catch (error) {
      if (ticket !== this.#ticket) return;
      this.#state = { ...this.#state, phase: "error", error };
    }
    this.#focusNext = true;
    this.render();
  }

  /** Open proposals for the road under the tap, or — where no road is recorded — for a missing limit near it. Never blocks the answer. */
  async #loadProposals(latlng, classification, lookup) {
    if (!this.settings) return [];
    try {
      if (classification.kind === "road" && lookup?.segmentId) {
        const { data } = await this.api.get(`/v1/speed-limit-segments/${encodeURIComponent(lookup.segmentId)}/corrections`, { status: "proposed" });
        return openProposals(data.corrections);
      }
      const cells = await this.getCells(latlng);
      if (cells.length === 0) return [];
      const { data } = await this.api.get("/v1/speed-limit-corrections", { tiles: cells.join(","), status: "proposed" });
      return gapProposalsNear(data.corrections, latlng);
    } catch {
      return [];
    }
  }

  /** Back from the form or result to the answer (looks it up again, so new counts show). */
  #reload() {
    const { latlng, toleranceM } = this.#state;
    this.onPreview(null);
    return this.show(latlng, toleranceM);
  }

  render() {
    const tr = currentTranslator();
    const s = this.#state;
    let content;
    switch (s.phase) {
      case "loading":
        content = h("p", { class: "hint", role: "status" }, tr.t("limit.loading"));
        break;
      case "error":
        content = this.#renderError(tr, s);
        break;
      case "form":
        content = this.#renderForm(tr, s);
        break;
      case "result":
        content = this.#renderResult(tr, s);
        break;
      case "view":
        content = this.#renderView(tr, s);
        break;
      default:
        content = null;
    }
    this.element.replaceChildren(...(content ? [content] : []));
    if (this.#focusNext) {
      this.#focusNext = false;
      this.element.querySelector("[data-autofocus]")?.focus({ preventScroll: false });
    }
    this.onLayout();
  }

  #renderError(tr, s) {
    const text = s.error?.status === 429 ? tr.t("limit.rateLimited") : tr.t("limit.error");
    return h("div", null, h("p", { role: "alert" }, text), h("button", { type: "button", class: "small", onclick: () => void this.#reload() }, tr.t("limit.retry")));
  }

  #renderView(tr, s) {
    const settings = this.settings;
    const { lookup, classification } = s;
    const children = [];
    const onRoad = classification.kind === "road";
    const unitText = (unit) => tr.t(`unit.${unit}`);

    if (onRoad) {
      children.push(h("h3", { class: "limit-title", tabindex: "-1", "data-autofocus": "" }, tr.t("limit.here", { value: lookup.speedLimit, unit: unitText(lookup.speedLimitUnit) })));
      const origin = describeOrigin(lookup);
      const counts = (o) => tr.t("limit.counts", { confirmations: o.confirmations, denials: o.denials });
      if (origin.kind === "imported") children.push(h("p", { class: "limit-origin" }, tr.t("limit.origin.imported")));
      else if (origin.kind === "corrected") {
        children.push(h("p", { class: "limit-origin" }, tr.t("limit.origin.corrected", { counts: counts(origin) })));
        children.push(h("p", { class: "hint" }, tr.t("limit.imported.was", { value: origin.imported, unit: unitText(lookup.speedLimitUnit) })));
      } else children.push(h("p", { class: "limit-origin" }, tr.t("limit.origin.added", { counts: counts(origin) })));
      if (origin.needsReview) children.push(h("p", { class: "limit-warning", role: "note" }, tr.t("limit.needsReview")));
      // An applied community value can be confirmed by one more visitor, like any proposal.
      if (settings && origin.correctionId) children.push(this.#voteRow(tr, s, { id: origin.correctionId, confirm: true, deny: false }));
    } else {
      children.push(h("h3", { class: "limit-title", tabindex: "-1", "data-autofocus": "" }, tr.t("limit.none")));
      if (classification.kind === "nearby" && classification.distance !== null) {
        children.push(h("p", { class: "hint" }, tr.t("limit.nearest", { m: classification.distance, value: lookup.speedLimit, unit: unitText(lookup.speedLimitUnit) })));
      }
    }

    if (s.proposals.length > 0) {
      const list = h("ul", { class: "proposals" });
      for (const proposal of s.proposals) {
        list.append(
          h(
            "li",
            null,
            h("div", { class: "proposal-text" }, tr.t("limit.proposed.item", { value: proposal.value, unit: unitText(proposal.unit), counts: tr.t("limit.counts", { confirmations: proposal.confirmations ?? 0, denials: proposal.denials ?? 0 }) })),
            this.#voteRow(tr, s, { id: proposal.id, confirm: true, deny: true }),
          ),
        );
      }
      children.push(h("section", { class: "proposals-box" }, h("h4", null, tr.t("limit.proposed.title")), settings ? h("p", { class: "hint" }, tr.t("limit.proposed.rule", { required: settings.required })) : null, list));
    }

    if (settings) {
      const actions = h("div", { class: "dialog-actions limit-actions" });
      if (onRoad) {
        actions.append(h("button", { type: "button", onclick: () => this.#openForm("wrong", { id: lookup.segmentId, speedLimit: lookup.speedLimit, unit: lookup.speedLimitUnit }) }, tr.t("limit.action.wrong")));
      } else {
        actions.append(h("button", { type: "button", class: "primary", onclick: () => this.#openForm("gap", null) }, tr.t("limit.action.missing")));
      }
      children.push(actions);
      children.push(h("p", { class: "hint" }, tr.t("limit.localOnly")));
    }
    return h("div", null, ...children);
  }

  /** "Stimmt" / "Stimmt nicht" for one proposal (or applied correction), with the node's honest answer next to it. */
  #voteRow(tr, s, { id, confirm, deny }) {
    const status = h("span", { class: "vote-status", role: "status", "aria-live": "polite" }, s.votes[id] ?? "");
    const buttons = [];
    const cast = async (kind, event) => {
      for (const b of buttons) b.disabled = true;
      status.textContent = tr.t("limit.sending");
      const message = await this.#vote(id, kind);
      s.votes[id] = message;
      status.textContent = message;
      for (const b of buttons) b.disabled = false;
      this.onLayout();
      event.target?.focus?.();
    };
    if (confirm) buttons.push(h("button", { type: "button", class: "small", onclick: (event) => void cast("confirm", event) }, tr.t("limit.vote.confirm")));
    if (deny) buttons.push(h("button", { type: "button", class: "small", onclick: (event) => void cast("deny", event) }, tr.t("limit.vote.deny")));
    return h("div", { class: "vote-row" }, ...buttons, status);
  }

  async #vote(id, kind) {
    const tr = currentTranslator();
    try {
      const { data } = await this.api.post(`/v1/speed-limit-corrections/${encodeURIComponent(id)}/confirmations`, { kind });
      const outcome = describeVoteResult(data, this.settings?.required ?? 3);
      this.onChanged();
      if (outcome.kind === "unchanged") return tr.t("limit.vote.unchanged");
      if (outcome.applied) return tr.t("limit.vote.applied", { value: outcome.value, unit: tr.t(`unit.${outcome.unit}`) });
      return tr.t(kind === "confirm" ? "limit.vote.counted.confirm" : "limit.vote.counted.deny", { confirmations: outcome.confirmations, denials: outcome.denials });
    } catch (error) {
      return this.#errorText(tr, error).text;
    }
  }

  #errorText(tr, error) {
    const described = describeCorrectionError(error, this.settings);
    const params = { ...described.params };
    if (params.unit) params.unit = tr.t(`unit.${params.unit}`);
    return { text: tr.t(`limit.error.${described.key}`, params), switchTo: described.switchTo };
  }

  // ---- the form --------------------------------------------------------------------------------------------------

  #openForm(kind, segment, info = null) {
    const settings = this.settings;
    if (!settings) return;
    const unit = segment?.unit ?? "kmh";
    this.#state = {
      ...this.#state,
      phase: "form",
      form: { kind, segment, unit, value: "", reason: (kind === "wrong" ? WRONG_REASONS : MISSING_REASONS)[0], axis: null, error: null, sending: false, info },
    };
    this.#focusNext = true;
    this.#previewAxis();
    this.render();
  }

  #previewAxis() {
    const { form, latlng } = this.#state;
    if (form?.kind === "gap" && form.axis !== null) this.onPreview(latlng, form.axis);
    else this.onPreview(null);
  }

  #renderForm(tr, s) {
    const settings = this.settings;
    const f = s.form;
    const isGap = f.kind === "gap";
    const current = f.segment ? f.segment.speedLimit : null;
    const valueId = uid("limit-value");
    const errorId = uid("limit-error");
    const rerender = () => this.render();

    const chips = h("div", { class: "chip-row", role: "group", "aria-label": tr.t("limit.form.quick") });
    for (const value of quickValues(f.unit, settings, current)) {
      chips.append(
        h(
          "button",
          {
            type: "button",
            class: "chip-button",
            "aria-pressed": String(String(value) === f.value),
            onclick: () => {
              f.value = String(value);
              f.error = null;
              rerender();
              this.element.querySelector(`#${valueId}`)?.focus();
            },
          },
          String(value),
        ),
      );
    }

    const input = h("input", {
      id: valueId,
      type: "text",
      inputmode: "numeric",
      autocomplete: "off",
      value: f.value,
      required: true,
      "aria-describedby": f.error ? errorId : undefined,
      "aria-invalid": f.error ? "true" : undefined,
      "data-autofocus": isGap ? undefined : "",
    });
    input.addEventListener("input", () => {
      f.value = input.value;
      for (const chip of chips.querySelectorAll("button")) chip.setAttribute("aria-pressed", String(chip.textContent === f.value));
    });

    const unitBlock = isGap
      ? h(
          "fieldset",
          { class: "inline-choice" },
          h("legend", null, tr.t("limit.form.unit")),
          ...["kmh", "mph"].map((unit) =>
            h(
              "label",
              null,
              h("input", {
                type: "radio",
                name: "limit-unit",
                value: unit,
                checked: f.unit === unit ? true : undefined,
                onchange: () => {
                  f.unit = unit;
                  f.value = "";
                  f.error = null;
                  rerender();
                },
              }),
              h("span", null, tr.t(`unit.${unit}`)),
            ),
          ),
        )
      : h("p", { class: "hint" }, tr.t("limit.form.unitFixed", { unit: tr.t(`unit.${f.unit}`) }));

    const reasons = isGap ? MISSING_REASONS : WRONG_REASONS;
    const reasonId = uid("limit-reason");
    const reason = h(
      "div",
      { class: "field" },
      h("label", { for: reasonId }, tr.t("limit.form.reason")),
      h(
        "select",
        { id: reasonId, onchange: (event) => (f.reason = event.target.value) },
        reasons.map((r) => h("option", { value: r, selected: f.reason === r ? true : undefined }, tr.t(`limit.reason.${r}`))),
      ),
    );

    let axisBlock = null;
    if (isGap) {
      axisBlock = h(
        "fieldset",
        { class: "axis-choice" },
        h("legend", null, tr.t("limit.form.axis")),
        h("p", { class: "hint" }, tr.t("limit.form.axis.hint")),
        h(
          "div",
          { class: "axis-grid" },
          AXES.map((axis) =>
            h(
              "label",
              { class: "axis-option" },
              h("input", {
                type: "radio",
                name: "limit-axis",
                value: axis.id,
                checked: f.axis === axis.bearingDegrees ? true : undefined,
                onchange: () => {
                  f.axis = axis.bearingDegrees;
                  f.error = null;
                  this.#previewAxis();
                },
              }),
              axisPicture(axis.bearingDegrees),
              h("span", null, tr.t(`limit.axis.${axis.id}`)),
            ),
          ),
        ),
      );
    }

    const form = h(
      "form",
      { class: "limit-form", novalidate: true, onsubmit: (event) => void this.#submitForm(event) },
      h("h3", { tabindex: "-1", "data-autofocus": isGap ? "" : undefined }, tr.t(isGap ? "limit.form.title.gap" : "limit.form.title.wrong")),
      f.info ? h("p", { class: "hint", role: "status" }, f.info) : null,
      !isGap ? h("p", null, tr.t("limit.form.current", { value: current, unit: tr.t(`unit.${f.unit}`) })) : null,
      h("p", { class: "limit-safety", role: "note" }, tr.t("limit.form.safety")),
      axisBlock,
      unitBlock,
      h("fieldset", { class: "value-choice" }, h("legend", null, tr.t("limit.form.value", { unit: tr.t(`unit.${f.unit}`) })), chips, h("div", { class: "field" }, h("label", { for: valueId }, tr.t("limit.form.other", { step: settings.step })), input)),
      reason,
      f.error ? h("p", { id: errorId, class: "result bad", role: "alert" }, f.error) : null,
      h("p", { class: "hint" }, tr.t("limit.localOnly")),
      h(
        "div",
        { class: "dialog-actions" },
        h("button", { type: "button", onclick: () => void this.#reload() }, tr.t("limit.form.cancel")),
        h("button", { type: "submit", class: "primary", disabled: f.sending ? true : undefined }, f.sending ? tr.t("limit.sending") : tr.t("limit.form.submit")),
      ),
    );
    return form;
  }

  async #submitForm(event) {
    event.preventDefault();
    const tr = currentTranslator();
    const s = this.#state;
    const f = s.form;
    const settings = this.settings;
    if (!settings || f.sending) return;

    const current = f.segment ? f.segment.speedLimit : null;
    const checked = validateValue(f.value, f.unit, settings, current);
    if (!checked.ok) {
      f.error = tr.t(`limit.form.error.${checked.reason}`, { min: checked.min, max: checked.max, step: checked.step, unit: tr.t(`unit.${f.unit}`) });
      this.#focusNext = false;
      this.render();
      this.element.querySelector("input[type=text]")?.focus();
      return;
    }
    if (f.kind === "gap" && f.axis === null) {
      f.error = tr.t("limit.form.error.axis");
      this.render();
      this.element.querySelector("input[name=limit-axis]")?.focus();
      return;
    }

    f.sending = true;
    f.error = null;
    this.render();
    try {
      let response;
      if (f.kind === "wrong") {
        response = await this.api.post(`/v1/speed-limit-segments/${encodeURIComponent(f.segment.id)}/corrections`, { value: checked.value, unit: f.unit, reason: f.reason });
      } else {
        response = await this.api.post("/v1/speed-limit-gaps", { lat: Number(s.latlng.lat.toFixed(6)), lng: Number(s.latlng.lng.toFixed(6)), bearingDegrees: f.axis, value: checked.value, unit: f.unit, reason: f.reason });
      }
      const outcome = describeVoteResult(response.data, settings.required);
      this.onPreview(null);
      this.onChanged();
      this.#state = { ...s, phase: "result", result: { ...outcome, value: checked.value, unit: f.unit, kind: outcome.kind } };
      this.#focusNext = true;
      this.render();
    } catch (error) {
      f.sending = false;
      const described = this.#errorText(tr, error);
      if (described.switchTo?.segmentId) {
        // The node has a recorded road right here: the proposal belongs on that road, so go there instead of refusing.
        const { segmentId, speedLimit, unit } = described.switchTo;
        this.#openForm("wrong", { id: segmentId, speedLimit, unit }, tr.t("limit.error.roadAlreadyHasLimit"));
        return;
      }
      f.error = described.text;
      this.#focusNext = false;
      this.render();
    }
  }

  #renderResult(tr, s) {
    const r = s.result;
    const settings = this.settings;
    const unit = tr.t(`unit.${r.unit}`);
    const lines = [];
    if (r.kind === "unchanged") lines.push(tr.t("limit.result.unchanged"));
    else if (r.kind === "merged") lines.push(tr.t("limit.result.merged", { confirmations: r.confirmations, required: settings?.required ?? r.required }));
    else lines.push(tr.t("limit.result.new", { value: r.value, unit, required: settings?.required ?? r.required, confirmations: r.confirmations }));
    if (r.applied) lines.push(tr.t("limit.result.applied", { value: r.value, unit }));
    return h(
      "div",
      null,
      h("h3", { tabindex: "-1", "data-autofocus": "" }, tr.t("limit.result.title")),
      h("p", { class: "result ok", role: "status" }, lines.join(" ")),
      h("p", { class: "hint" }, tr.t("limit.localOnly")),
      h("div", { class: "dialog-actions" }, h("button", { type: "button", class: "primary", onclick: () => void this.#reload() }, tr.t("limit.result.back"))),
    );
  }

  /** The visitor left the detail (closed the popup or the sheet view): forget it and clear the preview line. */
  reset() {
    this.#ticket += 1;
    this.#state = { phase: "idle" };
    this.onPreview(null);
    this.element.replaceChildren();
  }

  get active() {
    return this.#state.phase !== "idle";
  }
}
