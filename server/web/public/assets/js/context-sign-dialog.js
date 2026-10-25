import { h } from "./dom.js";
import { CATALOG, signByCode, signName, signPictogram } from "./context-signs-data.js";
import { currentLang, currentTranslator, onLangChange } from "./i18n.js";

const HEADINGS = [
  ["N", 0],
  ["NE", 45],
  ["E", 90],
  ["SE", 135],
  ["S", 180],
  ["SW", 225],
  ["W", 270],
  ["NW", 315],
];

/** Maps an API failure to a message key; the node's own text is the fallback. */
function errorText(error, tr) {
  const key = `signs.error.${error?.code}`;
  const known = tr.t(key);
  if (known !== key) return known;
  if (error?.status === 429) return tr.t("signs.error.limited");
  return error?.message ? `${tr.t("signs.error.generic")} ${error.message}` : tr.t("signs.error.generic");
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * The dialog "enter a traffic sign" (docs/context-signs.md): choose the sign, pick where it applies on the map (a start and an end,
 * or one place and a direction for a sign that stands at one place), say in which direction and when, preview what the node makes
 * of it (the stretch on the road, entries that are the same or similar), then send it. Native <dialog>: focus trap, Escape and the
 * backdrop come for free. The dialog closes while a point is picked on the map and comes back with everything kept.
 */
export class ContextSignDialog {
  #state = null;
  #open = false;

  /**
   * `onPickRequested(resolve, cancel, { hintKey })` is the map page's point picker; `onPreview(preview | null)` draws the stretch;
   * `onDone()` is called after a sign was entered or confirmed.
   */
  constructor({ dialog, api, onPickRequested, onPreview, onDone }) {
    this.dialog = dialog;
    this.api = api;
    this.onPickRequested = onPickRequested;
    this.onPreview = onPreview;
    this.onDone = onDone;
    dialog.addEventListener("close", () => {
      this.#open = false;
    });
    onLangChange(() => {
      if (this.#open) this.render();
    });
  }

  open({ center }) {
    this.#state = {
      center,
      query: "",
      sign: null,
      from: null,
      to: null,
      heading: null,
      direction: "along",
      timed: false,
      days: new Set([1, 2, 3, 4, 5]),
      timeFrom: "07:00",
      timeTo: "17:00",
      dated: false,
      dateFrom: todayIso(),
      dateTo: "",
      openEnd: false,
      value: "",
      preview: null,
      choice: "new",
      result: null,
      sending: false,
      resolving: false,
      error: null,
    };
    this.onPreview?.(null);
    this.render();
    this.show();
  }

  show() {
    if (!this.dialog.open) this.dialog.showModal();
    this.#open = true;
  }

  close() {
    this.dialog.close();
    this.onPreview?.(null);
  }

  #invalidate() {
    const s = this.#state;
    s.preview = null;
    s.result = null;
    s.error = null;
    this.onPreview?.(null);
  }

  #pick(which) {
    const s = this.#state;
    this.dialog.close();
    const hintKey = s.sign.pointLike ? "signs.pick.hint.place" : which === "from" ? "signs.pick.hint.from" : "signs.pick.hint.to";
    this.onPickRequested(
      (latlng) => {
        s[which] = { lat: latlng.lat, lng: latlng.lng };
        this.#invalidate();
        this.render();
        this.show();
        this.onPreview?.({ points: [s.from, s.to].filter(Boolean), line: null });
      },
      () => this.show(),
      { hintKey },
    );
  }

  /** The request for POST /v1/context-signs/resolve, or an error key if the form is not complete. */
  #request() {
    const s = this.#state;
    const sign = s.sign;
    if (!sign) return { error: "signs.form.needSign" };
    if (!s.from || (!sign.pointLike && !s.to)) return { error: sign.pointLike ? "signs.form.needPlace" : "signs.form.needPoints" };
    const body = { signType: sign.code, from: s.from, direction: s.direction };
    if (!sign.pointLike) body.to = s.to;
    if (sign.pointLike && s.direction === "along") {
      if (s.heading === null) return { error: "signs.form.needHeading" };
      body.heading = s.heading;
    }
    const validity = {};
    if (s.timed) {
      if (s.days.size === 0) return { error: "signs.form.needDays" };
      if (!s.timeFrom || !s.timeTo || s.timeFrom === s.timeTo) return { error: "signs.form.badTimes" };
      validity.windows = [{ days: [...s.days].sort((a, b) => a - b), from: s.timeFrom, to: s.timeTo }];
    }
    const periodRequired = sign.maxPeriodDays !== null;
    if (s.dated || periodRequired) {
      if (!s.dateFrom) return { error: "signs.form.needDates" };
      if (!s.openEnd && !s.dateTo) return { error: "signs.form.needDates" };
      if (periodRequired && !s.dateTo) return { error: "signs.form.needEnd" };
      validity.period = { from: s.dateFrom, to: s.openEnd && !periodRequired ? null : s.dateTo };
    }
    if (validity.windows || validity.period) body.validity = validity;
    if (sign.value) {
      const raw = s.value.trim().replace(",", ".");
      if (raw === "") {
        if (sign.value.required) return { error: "signs.form.needValue" };
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < sign.value.min || n > sign.value.max) return { error: "signs.form.badValue", params: { min: sign.value.min, max: sign.value.max, unit: sign.value.unit } };
        body.value = n;
        body.unit = sign.value.unit;
      }
    }
    return { body };
  }

  async #resolve() {
    const s = this.#state;
    const tr = currentTranslator();
    const request = this.#request();
    if (request.error) {
      s.error = tr.t(request.error, request.params);
      s.result = null;
      this.render();
      return;
    }
    s.resolving = true;
    s.error = null;
    this.render();
    try {
      const { data } = await this.api.post("/v1/context-signs/resolve", request.body);
      s.preview = data;
      s.choice = data.existing ? "existing" : "new";
      this.onPreview?.({ points: [], line: data.descriptor.geometry });
    } catch (error) {
      s.error = errorText(error, tr);
      this.onPreview?.(null);
    }
    s.resolving = false;
    this.render();
  }

  async #send() {
    const s = this.#state;
    const tr = currentTranslator();
    if (!s.preview || s.sending) return;
    s.sending = true;
    s.error = null;
    this.render();
    try {
      const target = s.choice === "new" ? null : s.choice === "existing" ? s.preview.existing : s.preview.similar[Number(s.choice)]?.entry;
      const { data } =
        target === null || target === undefined
          ? await this.api.post("/v1/context-signs", { descriptor: s.preview.descriptor })
          : await this.api.post(`/v1/context-signs/${target.id}/confirmations`, { kind: "confirm" });
      s.result = { created: data.created, noop: data.noop ?? null, entry: data.entry };
      this.onDone?.();
    } catch (error) {
      s.error = errorText(error, tr);
    }
    s.sending = false;
    this.render();
  }

  render() {
    const s = this.#state;
    if (!s) return;
    const tr = currentTranslator();
    const done = Boolean(s.result);
    const locked = done || s.sending;

    // 1. the sign
    const search = h("input", { id: "sign-search", type: "search", autocomplete: "off", value: s.query, disabled: locked ? true : undefined, "aria-controls": "sign-list" });
    search.addEventListener("input", () => {
      s.query = search.value;
      this.#renderList();
    });
    this.listBox = h("div", { id: "sign-list", class: "sign-list", role: "radiogroup", "aria-label": tr.t("signs.form.sign") });
    const signFieldset = h(
      "fieldset",
      null,
      h("legend", null, tr.t("signs.form.sign")),
      h("label", { class: "visually-hidden", for: "sign-search" }, tr.t("signs.form.search")),
      search,
      this.listBox,
    );

    // 2. where
    const sign = s.sign;
    const fmt = (p) => (p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : tr.t("signs.form.notPicked"));
    const whereChildren = [];
    if (sign) {
      if (sign.pointLike) {
        whereChildren.push(h("p", { role: "status" }, `${tr.t("signs.form.place")}: ${fmt(s.from)}`), h("button", { type: "button", class: "small", disabled: locked ? true : undefined, onclick: () => this.#pick("from") }, tr.t("signs.form.pickPlace")));
      } else {
        whereChildren.push(
          h("p", { role: "status" }, `${tr.t("signs.form.start")}: ${fmt(s.from)}`),
          h("p", { role: "status" }, `${tr.t("signs.form.end")}: ${fmt(s.to)}`),
          h("div", { class: "dialog-actions" }, h("button", { type: "button", class: "small", disabled: locked ? true : undefined, onclick: () => this.#pick("from") }, tr.t("signs.form.pickStart")), h("button", { type: "button", class: "small", disabled: locked ? true : undefined, onclick: () => this.#pick("to") }, tr.t("signs.form.pickEnd"))),
          h("p", { class: "hint" }, tr.t("signs.form.twoPointsHint")),
        );
      }
    }
    const whereFieldset = sign ? h("fieldset", null, h("legend", null, tr.t("signs.form.where")), ...whereChildren) : null;

    // 3. direction
    let directionFieldset = null;
    if (sign) {
      const radio = (value, key) =>
        h("label", null, h("input", { type: "radio", name: "ctx-direction", value, checked: s.direction === value ? true : undefined, disabled: locked ? true : undefined, onchange: () => { s.direction = value; this.#invalidate(); this.render(); } }), h("span", null, tr.t(key)));
      const heading =
        sign.pointLike && s.direction === "along"
          ? h(
              "div",
              { class: "field" },
              h("label", { for: "ctx-heading" }, tr.t("signs.form.heading")),
              h(
                "select",
                { id: "ctx-heading", disabled: locked ? true : undefined, onchange: (event) => { s.heading = event.target.value === "" ? null : Number(event.target.value); this.#invalidate(); } },
                h("option", { value: "" }, tr.t("signs.form.headingChoose")),
                HEADINGS.map(([name, deg]) => h("option", { value: deg, selected: s.heading === deg ? true : undefined }, tr.t(`signs.heading.${name}`))),
              ),
            )
          : null;
      directionFieldset = h("fieldset", null, h("legend", null, tr.t("signs.form.direction")), h("div", { class: "choice-grid" }, radio("along", sign.pointLike ? "signs.form.direction.alongPoint" : "signs.form.direction.along"), radio("both", "signs.form.direction.both")), heading);
    }

    // 4. when
    let whenFieldset = null;
    if (sign) {
      const periodRequired = sign.maxPeriodDays !== null;
      const dayBoxes = [1, 2, 3, 4, 5, 6, 7].map((n) =>
        h("label", { class: "day-box" }, h("input", { type: "checkbox", checked: s.days.has(n) ? true : undefined, disabled: locked ? true : undefined, onchange: (event) => { if (event.target.checked) s.days.add(n); else s.days.delete(n); this.#invalidate(); } }), h("span", null, tr.t(`signs.day.${n}`))),
      );
      const time = (id, key, field) => {
        const input = h("input", { id, type: "time", value: s[field], disabled: locked ? true : undefined });
        input.addEventListener("input", () => { s[field] = input.value; this.#invalidate(); });
        return h("div", { class: "field" }, h("label", { for: id }, tr.t(key)), input);
      };
      const date = (id, key, field) => {
        const input = h("input", { id, type: "date", value: s[field], disabled: locked ? true : undefined });
        input.addEventListener("input", () => { s[field] = input.value; this.#invalidate(); });
        return h("div", { class: "field" }, h("label", { for: id }, tr.t(key)), input);
      };
      const toggle = (field, key, forced = false) =>
        h("label", { class: "toggle-line" }, h("input", { type: "checkbox", checked: s[field] || forced ? true : undefined, disabled: locked || forced ? true : undefined, onchange: (event) => { s[field] = event.target.checked; this.#invalidate(); this.render(); } }), h("span", null, tr.t(key)));
      whenFieldset = h(
        "fieldset",
        null,
        h("legend", null, tr.t("signs.form.when")),
        toggle("timed", "signs.form.timed"),
        s.timed ? h("div", { class: "when-box" }, h("div", { class: "day-row", role: "group", "aria-label": tr.t("signs.form.days") }, dayBoxes), h("div", { class: "field-row" }, time("ctx-time-from", "signs.form.timeFrom", "timeFrom"), time("ctx-time-to", "signs.form.timeTo", "timeTo")), h("p", { class: "hint" }, tr.t("signs.form.timeHint"))) : null,
        toggle("dated", periodRequired ? "signs.form.datedRequired" : "signs.form.dated", periodRequired),
        s.dated || periodRequired
          ? h("div", { class: "when-box" }, h("div", { class: "field-row" }, date("ctx-date-from", "signs.form.dateFrom", "dateFrom"), s.openEnd && !periodRequired ? null : date("ctx-date-to", "signs.form.dateTo", "dateTo")), periodRequired ? h("p", { class: "hint" }, tr.t("signs.form.temporaryHint", { days: sign.maxPeriodDays })) : toggle("openEnd", "signs.form.openEnd"))
          : null,
      );
    }

    // value
    let valueField = null;
    if (sign?.value) {
      const input = h("input", { id: "ctx-value", type: "text", inputmode: "decimal", autocomplete: "off", value: s.value, disabled: locked ? true : undefined });
      input.addEventListener("input", () => { s.value = input.value; this.#invalidate(); });
      valueField = h("fieldset", null, h("legend", null, tr.t("signs.form.value")), h("div", { class: "field" }, h("label", { for: "ctx-value" }, tr.t(sign.value.required ? "signs.form.valueRequired" : "signs.form.valueOptional", { unit: sign.value.unit })), input));
    }

    // preview
    const preview = s.preview ? this.#previewBox(tr, locked) : null;
    const message = s.error ? h("p", { class: "result bad", role: "alert" }, s.error) : null;
    const resultBox = done ? h("p", { class: "result ok", role: "status", "aria-live": "polite" }, tr.t(s.result.noop ? "signs.result.noop" : s.result.created ? "signs.result.created" : "signs.result.confirmed")) : null;

    const form = h(
      "form",
      { method: "dialog", onsubmit: (event) => { event.preventDefault(); void (s.preview ? this.#send() : this.#resolve()); } },
      h("h2", { id: "sign-dialog-title" }, tr.t("signs.form.title")),
      h("p", { class: "hint" }, tr.t("signs.disclaimer")),
      signFieldset,
      whereFieldset,
      directionFieldset,
      whenFieldset,
      valueField,
      preview,
      message,
      resultBox,
      h("p", { class: "hint" }, `${tr.t("signs.form.privacy")} `, h("a", { href: "/privacy", target: "_blank", rel: "noopener" }, tr.t("reportDialog.privacy.link"))),
      h(
        "div",
        { class: "dialog-actions" },
        h("button", { type: "button", onclick: () => this.close() }, done ? tr.t("reportDialog.close") : tr.t("reportDialog.cancel")),
        done
          ? null
          : s.preview
            ? h("button", { type: "submit", class: "primary", disabled: s.sending ? true : undefined }, s.sending ? tr.t("reportDialog.sending") : tr.t(s.choice === "new" ? "signs.form.send" : "signs.form.sendConfirm"))
            : h("button", { type: "submit", class: "primary", disabled: s.resolving || !sign ? true : undefined }, s.resolving ? tr.t("signs.form.checking") : tr.t("signs.form.preview")),
      ),
    );
    this.dialog.setAttribute("aria-labelledby", "sign-dialog-title");
    this.dialog.replaceChildren(form);
    this.#renderList();
  }

  #renderList() {
    const s = this.#state;
    if (!this.listBox) return;
    const tr = currentTranslator();
    const lang = currentLang();
    const locked = Boolean(s.result) || s.sending;
    const query = s.query.trim().toLowerCase();
    const matches = CATALOG.filter((sign) => query === "" || `${sign.vz} ${sign.de} ${sign.en}`.toLowerCase().includes(query));
    if (matches.length === 0) {
      this.listBox.replaceChildren(h("p", { class: "hint", role: "status" }, tr.t("signs.form.noMatch")));
      return;
    }
    this.listBox.replaceChildren(
      ...matches.map((sign) =>
        h(
          "label",
          { class: `sign-choice${s.sign?.code === sign.code ? " selected" : ""}` },
          h("input", {
            type: "radio",
            name: "ctx-sign",
            value: sign.code,
            checked: s.sign?.code === sign.code ? true : undefined,
            disabled: locked ? true : undefined,
            onchange: () => {
              s.sign = signByCode(sign.code);
              s.value = "";
              if (sign.pointLike && s.to) s.to = null;
              this.#invalidate();
              this.render();
              this.dialog.querySelector('input[name="ctx-sign"]:checked')?.focus();
            },
          }),
          signPictogram(sign.code, { size: 34 }),
          h("span", null, `${sign.vz} · ${signName(sign.code, lang)}`),
        ),
      ),
    );
  }

  #previewBox(tr, locked) {
    const s = this.#state;
    const p = s.preview;
    const choices = [];
    const choice = (value, text) =>
      h("label", { class: "toggle-line" }, h("input", { type: "radio", name: "ctx-choice", value, checked: s.choice === value ? true : undefined, disabled: locked ? true : undefined, onchange: () => { s.choice = value; this.render(); } }), h("span", null, text));
    if (p.existing) {
      choices.push(choice("existing", tr.t("signs.preview.existing", { n: p.existing.confirmations })));
    } else {
      choices.push(choice("new", tr.t("signs.preview.new")));
      p.similar.forEach((item, index) => {
        choices.push(choice(String(index), tr.t("signs.preview.similar", { n: item.entry.confirmations, share: Math.round(Math.max(item.overlapOfNew, item.overlapOfEntry) * 100) })));
      });
    }
    return h(
      "fieldset",
      { class: "preview-box" },
      h("legend", null, tr.t("signs.preview.title")),
      h("p", { role: "status" }, tr.t("signs.preview.summary", { length: p.lengthM, road: p.road?.name || p.road?.ref || tr.t("signs.preview.unnamed"), tz: p.timezone })),
      h("p", { class: "hint" }, tr.t("signs.preview.shown")),
      p.similar.length > 0 && !p.existing ? h("p", { class: "hint" }, tr.t("signs.preview.similarHint")) : null,
      h("div", { class: "choice-grid" }, choices),
    );
  }
}
