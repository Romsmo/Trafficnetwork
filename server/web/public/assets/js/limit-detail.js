import { h } from "./dom.js";
import { currentTranslator, onLangChange } from "./i18n.js";
import {
  DEFECT_REASONS,
  INTERVAL_REASONS,
  MISSING_REASONS,
  WRONG_REASONS,
  classifyLookup,
  correctionSettings,
  defectSettings,
  describeCorrectionError,
  describeDefectResult,
  describeOrigin,
  describeVoteResult,
  gapProposalsNear,
  openProposals,
  quickValues,
  validateValue,
} from "./limit-info.js";

let counter = 0;
const uid = (prefix) => `${prefix}-${(counter += 1)}`;

/**
 * What the visitor sees after tapping the map: the speed limit there with its origin, open proposals they can confirm or deny, and
 * the ways to improve the data: "that's wrong?" (the whole recorded line), a limit for a stretch of road named by two points on it
 * (docs/road-network.md: the node finds the road and its shape; the page only draws what it is told), and "this entry is wrong" marks.
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
   * @param onPreview        ({ line?: [lng,lat][], points?: {lat,lng}[], tone?: "defect" }|null) — draws or clears what the visitor is looking at
   * @param onPickPoint      ({ hintKey, resolve(latlng), cancel() }|null) — asks the page to take the next tap on the map as a picked point
   *                         (null withdraws a pending request)
   * @param onChanged        called after a vote or proposal was accepted (the page redraws its road colours)
   * @param onLayout         called after the content changed size (a popup re-fits itself)
   */
  constructor({ api, getServerConfig, getCells = async () => [], onPreview = () => {}, onPickPoint = () => {}, onChanged = () => {}, onLayout = () => {} }) {
    Object.assign(this, { api, getServerConfig, getCells, onPreview, onPickPoint, onChanged, onLayout });
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

  get defects() {
    return defectSettings(this.getServerConfig());
  }

  /** Looks up the speed limit at `latlng` and renders the answer. `toleranceM` is how far from a road a tap still counts as on it. */
  async show(latlng, toleranceM) {
    const ticket = ++this.#ticket;
    this.#cancelPick();
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
    this.#cancelPick();
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
      case "defects":
        content = this.#renderDefects(tr, s);
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

    if (s.proposals.length > 0) children.push(this.#proposalBox(tr, s, s.proposals));

    const defects = this.defects;
    if (settings || defects) {
      const actions = h("div", { class: "dialog-actions limit-actions" });
      if (settings) {
        if (onRoad) {
          actions.append(h("button", { type: "button", onclick: () => this.#openForm("wrong", { id: lookup.segmentId, speedLimit: lookup.speedLimit, unit: lookup.speedLimitUnit }) }, tr.t("limit.action.wrong")));
        }
        actions.append(h("button", { type: "button", class: onRoad ? undefined : "primary", onclick: () => this.#openForm("interval", null) }, tr.t(onRoad ? "limit.action.interval" : "limit.action.missing")));
      }
      if (defects) actions.append(h("button", { type: "button", onclick: () => void this.#openDefects() }, tr.t("limit.action.defect")));
      children.push(actions);
      if (settings) children.push(h("p", { class: "hint" }, tr.t("limit.localOnly")));
    }
    return h("div", null, ...children);
  }

  /** Open proposals with a "confirm" and "deny" for each (and the rule that makes one count for everybody). */
  #proposalBox(tr, s, proposals) {
    const settings = this.settings;
    const list = h("ul", { class: "proposals" });
    for (const proposal of proposals) {
      list.append(
        h(
          "li",
          null,
          h("div", { class: "proposal-text" }, tr.t("limit.proposed.item", { value: proposal.value, unit: tr.t(`unit.${proposal.unit}`), counts: tr.t("limit.counts", { confirmations: proposal.confirmations ?? 0, denials: proposal.denials ?? 0 }) })),
          this.#voteRow(tr, s, { id: proposal.id, confirm: true, deny: true }),
        ),
      );
    }
    return h("section", { class: "proposals-box" }, h("h4", null, tr.t("limit.proposed.title")), settings ? h("p", { class: "hint" }, tr.t("limit.proposed.rule", { required: settings.required })) : null, list);
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
    if (params.max !== undefined) params.max = Math.round(params.max);
    return { text: tr.t(`limit.error.${described.key}`, params), switchTo: described.switchTo };
  }

  // ---- the form --------------------------------------------------------------------------------------------------

  #openForm(kind, segment, info = null) {
    const settings = this.settings;
    if (!settings) return;
    this.#cancelPick();
    const unit = segment?.unit ?? "kmh";
    const form = { kind, segment, unit, value: "", reason: (kind === "wrong" ? WRONG_REASONS : MISSING_REASONS)[0], error: null, sending: false, info };
    if (kind === "interval") {
      // The spot that was tapped is the first of the two points; the visitor picks the second on the map (docs/road-network.md).
      Object.assign(form, { from: this.#state.latlng, to: null, resolved: null, resolving: false, resolveError: null, resolveTicket: 0, picking: null });
    }
    this.#state = { ...this.#state, phase: "form", form };
    this.#focusNext = true;
    this.#previewForm();
    this.render();
  }

  /** What the map shows for the form: the picked points and, once the node has found the road, the stretch between them in grey. */
  #previewForm() {
    const { form } = this.#state;
    if (form?.kind !== "interval") {
      this.onPreview(null);
      return;
    }
    const points = [form.from, form.to].filter(Boolean);
    this.onPreview({ points, line: form.resolved?.geometry?.coordinates ?? null });
  }

  #cancelPick() {
    const form = this.#state.form;
    if (form?.picking) {
      form.picking = null;
      this.onPickPoint(null);
    }
  }

  /** Asks the page to take the next tap on the map as "from" or "to" of the stretch. */
  #pick(which) {
    const f = this.#state.form;
    if (f?.kind !== "interval" || f.sending) return;
    f.picking = which;
    f.error = null;
    this.onPickPoint({
      hintKey: which === "from" ? "limit.points.picking.from" : "limit.points.picking.to",
      resolve: (latlng) => {
        if (this.#state.form !== f) return;
        f.picking = null;
        f[which] = latlng;
        void this.#resolveStretch();
      },
      cancel: () => {
        if (this.#state.form !== f) return;
        f.picking = null;
        this.#focusNext = false;
        this.render();
      },
    });
    this.#focusNext = false;
    this.render();
  }

  /** Asks the node which stretch of which road the two points name. Nothing is stored by this; the answer is only a preview. */
  async #resolveStretch() {
    const f = this.#state.form;
    if (f?.kind !== "interval") return;
    f.resolved = null;
    f.resolveError = null;
    if (!f.from || !f.to) {
      this.#previewForm();
      this.#focusNext = false;
      this.render();
      return;
    }
    const ticket = (f.resolveTicket += 1);
    f.resolving = true;
    this.#previewForm();
    this.#focusNext = false;
    this.render();
    const round = (p) => ({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) });
    try {
      const { data } = await this.api.post("/v1/roads/resolve", { from: round(f.from), to: round(f.to) });
      if (ticket !== f.resolveTicket || this.#state.form !== f) return;
      f.resolved = data;
      // the unit a stretch already has is the one that is offered first
      const first = (data.covered ?? [])[0];
      if (first && f.value === "") f.unit = first.unit;
      // something is recorded there: the likely reason is that it is wrong, not that it is missing
      if (first && f.reason === "missing") f.reason = "wrong_value";
    } catch (error) {
      if (ticket !== f.resolveTicket || this.#state.form !== f) return;
      f.resolveError = this.#errorText(currentTranslator(), error).text;
    }
    f.resolving = false;
    this.#previewForm();
    this.#focusNext = false;
    this.render();
  }

  #renderForm(tr, s) {
    const settings = this.settings;
    const f = s.form;
    const isGap = f.kind === "interval";
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
      disabled: isGap && !f.resolved ? true : undefined,
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

    const reasons = isGap ? INTERVAL_REASONS : WRONG_REASONS;
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

    const pointsBlock = isGap ? this.#renderPoints(tr, s, f) : null;

    const form = h(
      "form",
      { class: "limit-form", novalidate: true, onsubmit: (event) => void this.#submitForm(event) },
      h("h3", { tabindex: "-1", "data-autofocus": isGap ? "" : undefined }, tr.t(isGap ? "limit.form.title.interval" : "limit.form.title.wrong")),
      f.info ? h("p", { class: "hint", role: "status" }, f.info) : null,
      !isGap ? h("p", null, tr.t("limit.form.current", { value: current, unit: tr.t(`unit.${f.unit}`) })) : null,
      h("p", { class: "limit-safety", role: "note" }, tr.t("limit.form.safety")),
      pointsBlock,
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

  /** Step "which stretch": the two points, what the node found between them, what is on record there and what is proposed. */
  #renderPoints(tr, s, f) {
    const row = (which) => {
      const point = f[which];
      const picking = f.picking === which;
      const label = tr.t(which === "from" ? "limit.points.from" : "limit.points.to");
      const state = picking ? tr.t(which === "from" ? "limit.points.picking.from" : "limit.points.picking.to") : point ? tr.t("limit.points.set") : tr.t("limit.points.unset");
      const action = point ? tr.t(which === "from" ? "limit.points.changeFrom" : "limit.points.changeTo") : tr.t("limit.points.pickTo");
      return h(
        "div",
        { class: "point-row" },
        h("span", { class: "point-label" }, h("strong", null, label), ": ", state),
        h("button", { type: "button", class: point ? "small" : "small primary", disabled: picking || f.sending ? true : undefined, onclick: () => this.#pick(which), "data-autofocus": which === "to" && !point ? "" : undefined }, action),
      );
    };
    const children = [h("legend", null, tr.t("limit.points.title")), h("p", { class: "hint" }, tr.t("limit.points.hint")), row("from"), row("to")];

    if (f.resolving) children.push(h("p", { class: "hint", role: "status" }, tr.t("limit.points.resolving")));
    else if (f.resolveError) children.push(h("p", { class: "result bad", role: "alert" }, f.resolveError));
    else if (f.resolved) {
      const r = f.resolved;
      const road = r.road?.name ?? r.road?.ref ?? tr.t("limit.points.unnamed");
      children.push(h("p", { class: "result ok", role: "status" }, tr.t("limit.points.found", { road, length: r.lengthM })));
      const covered = r.covered ?? [];
      if (covered.length === 0) children.push(h("p", { class: "hint" }, tr.t("limit.points.none")));
      else {
        const items = covered.map((c) => tr.t("limit.points.covered.item", { value: c.speedLimit, unit: tr.t(`unit.${c.unit}`), m: c.coveredMeters }));
        children.push(h("p", { class: "hint" }, tr.t("limit.points.covered", { items: items.join("; ") })));
      }
      const proposals = openProposals(r.proposals);
      if (proposals.length > 0) children.push(this.#proposalBox(tr, s, proposals));
    }
    return h("fieldset", { class: "points-choice" }, ...children);
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
    if (f.kind === "interval" && !f.resolved) {
      f.error = tr.t("limit.form.error.points");
      this.#focusNext = false;
      this.render();
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
        // The two picked points, not the road the node found: the node resolves them again for itself.
        const round = (p) => ({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) });
        response = await this.api.post("/v1/speed-limit-intervals", { from: round(f.from), to: round(f.to), value: checked.value, unit: f.unit, reason: f.reason });
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

  // ---- "this entry is wrong" ---------------------------------------------------------------------------------------

  async #openDefects() {
    const ticket = ++this.#ticket;
    this.#cancelPick();
    const { latlng } = this.#state;
    const defects = { loading: true, items: [], reason: DEFECT_REASONS[0], results: {}, sending: {}, error: false };
    this.#state = { ...this.#state, phase: "defects", defects };
    this.onPreview(null);
    this.#focusNext = true;
    this.render();
    try {
      const { data } = await this.api.get("/v1/data-defects/near", { lat: latlng.lat.toFixed(6), lng: latlng.lng.toFixed(6), radiusM: 40 });
      if (ticket !== this.#ticket) return;
      defects.items = data.items ?? [];
    } catch {
      if (ticket !== this.#ticket) return;
      defects.error = true;
    }
    defects.loading = false;
    this.#focusNext = true;
    this.render();
  }

  #renderDefects(tr, s) {
    const d = s.defects;
    const threshold = this.defects?.threshold ?? 3;
    const reasonId = uid("defect-reason");
    const children = [
      h("h3", { tabindex: "-1", "data-autofocus": "" }, tr.t("defect.title")),
      h("p", { class: "hint" }, tr.t("defect.hint", { threshold })),
    ];
    if (d.loading) children.push(h("p", { class: "hint", role: "status" }, tr.t("limit.loading")));
    else if (d.error) children.push(h("p", { role: "alert" }, tr.t("defect.error")));
    else if (d.items.length === 0) children.push(h("p", { role: "status" }, tr.t("defect.none")));
    else {
      children.push(
        h(
          "div",
          { class: "field" },
          h("label", { for: reasonId }, tr.t("defect.reason")),
          h("select", { id: reasonId, onchange: (event) => (d.reason = event.target.value) }, DEFECT_REASONS.map((r) => h("option", { value: r, selected: d.reason === r ? true : undefined }, tr.t(`defect.reason.${r}`)))),
        ),
      );
      const list = h("ul", { class: "defect-list" });
      for (const item of d.items) {
        const text =
          item.targetType === "speedLimitSegment"
            ? tr.t("defect.item.segment", { value: item.speedLimit, unit: tr.t(`unit.${item.speedLimitUnit}`), m: item.distanceMeters })
            : tr.t("defect.item.sign", { type: item.signType, m: item.distanceMeters });
        const result = d.results[item.targetId];
        const done = result !== undefined && d.sending[item.targetId] !== true;
        list.append(
          h(
            "li",
            null,
            h("div", { class: "proposal-text" }, text, " ", h("span", { class: "hint" }, tr.t("defect.item.reports", { reports: item.reports ?? 0, threshold: item.threshold ?? threshold }))),
            h(
              "div",
              { class: "vote-row" },
              h("button", { type: "button", class: "small", onclick: () => this.#showDefect(item) }, tr.t("defect.show")),
              h("button", { type: "button", class: "small", disabled: d.sending[item.targetId] || done ? true : undefined, onclick: () => void this.#reportDefect(item) }, tr.t("defect.report")),
              h("span", { class: "vote-status", role: "status", "aria-live": "polite" }, result ?? ""),
            ),
          ),
        );
      }
      children.push(list);
    }
    children.push(h("div", { class: "dialog-actions" }, h("button", { type: "button", class: "primary", onclick: () => void this.#reload() }, tr.t("defect.back"))));
    return h("div", { class: "defect-box" }, ...children);
  }

  /** Marks the entry on the map so the visitor can see which one is meant before reporting it. */
  #showDefect(item) {
    if (item.targetType === "speedLimitSegment" && item.geometry?.coordinates) this.onPreview({ line: item.geometry.coordinates, tone: "defect" });
    else if (item.position?.coordinates) this.onPreview({ points: [{ lat: item.position.coordinates[1], lng: item.position.coordinates[0] }], tone: "defect" });
  }

  async #reportDefect(item) {
    const d = this.#state.defects;
    const tr = currentTranslator();
    d.sending[item.targetId] = true;
    d.results[item.targetId] = tr.t("limit.sending");
    this.#focusNext = false;
    this.render();
    try {
      const { data } = await this.api.post("/v1/data-defects", { targetType: item.targetType, targetId: item.targetId, reason: d.reason });
      const outcome = describeDefectResult(data);
      item.reports = outcome.reports;
      d.results[item.targetId] = tr.t(`defect.result.${outcome.kind}`, { reports: outcome.reports, threshold: outcome.threshold });
      if (outcome.kind === "removed") {
        this.onPreview(null);
        this.onChanged();
      }
    } catch (error) {
      d.results[item.targetId] = this.#errorText(tr, error).text;
    }
    d.sending[item.targetId] = false;
    this.#focusNext = false;
    this.render();
  }

  /** The visitor left the detail (closed the popup or the sheet view): forget it and clear the preview line. */
  reset() {
    this.#cancelPick();
    this.#ticket += 1;
    this.#state = { phase: "idle" };
    this.onPreview(null);
    this.element.replaceChildren();
  }

  get active() {
    return this.#state.phase !== "idle";
  }
}
