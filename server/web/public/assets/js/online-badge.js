import { h } from "./dom.js";
import { currentTranslator } from "./i18n.js";

/**
 * The small "N online" display at the bottom right of every page (add-on O-B, work order "addon-online-counter" (kept outside the repo)).
 * It reads the public, unauthenticated GET /v1/stats/online. Numbers only: nothing about a person is ever shown or sent.
 *
 * The contract is the server's (docs/api.md, "GET /v1/stats/online", add-on O-A). The page was first written against the shape
 * proposed in the add-on prompt and checked against the real endpoint afterwards; the reader is deliberately tolerant (see
 * parseOnlineStats) and everything that is not understood simply hides the display.
 */

export const REFRESH_MS = 30_000;

/** Statuses that mean "this node does not offer the counter" (older server, feature switched off): stop asking. */
const OFF_STATUSES = new Set([401, 403, 404, 405, 410]);

const isCount = (value) => Number.isInteger(value) && value >= 0;
const positiveInt = (value) => (Number.isInteger(value) && value > 0 ? value : null);

/** One figure: { exact } or { below }, or null when the part carries no usable number. */
function readFigure(part, threshold) {
  if (!part || typeof part !== "object") return null;
  if (isCount(part.online)) {
    // Never show an exact figure under the threshold, even if a server sent one: "1 online" would describe one person.
    return threshold && part.online < threshold ? { below: threshold } : { exact: part.online };
  }
  if (part.online === null) {
    const below = positiveInt(part.below) ?? threshold;
    return below ? { below } : null;
  }
  return null;
}

/**
 * Normalises the answer of GET /v1/stats/online. Proposed shape:
 *   { node: { online: 12, windowSeconds: 300 }, network: { online: 87, nodes: 4, estimated: true, asOf: "…" }, minDisplayThreshold: 5 }
 * Below the threshold a figure is `online: null` plus `below: 5`. `enabled: false` means "switched off".
 * Returns null when nothing should be shown; otherwise { node, network }. The network figure is always presented as an estimate.
 */
export function parseOnlineStats(payload) {
  if (!payload || typeof payload !== "object" || isSwitchedOff(payload)) return null;
  const threshold = positiveInt(payload.minDisplayThreshold);
  const node = readFigure(payload.node, threshold);
  if (!node) return null;
  const networkFigure = readFigure(payload.network, threshold);
  const network = networkFigure
    ? {
        ...networkFigure,
        nodes: positiveInt(payload.network.nodes),
        asOf: typeof payload.network.asOf === "string" && !Number.isNaN(Date.parse(payload.network.asOf)) ? payload.network.asOf : null,
      }
    : null;
  return { node, network };
}

/** The node says the feature is switched off ({ "enabled": false }). */
export function isSwitchedOff(payload) {
  return Boolean(payload) && typeof payload === "object" && payload.enabled === false;
}

/** Visible text: this node's figure. */
export function summaryText(stats, tr = currentTranslator()) {
  return stats.node.below !== undefined ? tr.t("online.summary.below", { min: stats.node.below }) : tr.t("online.summary.exact", { n: stats.node.exact });
}

/** The lines shown when the display is opened: this node, the network estimate (with its caveat), the privacy note. */
export function detailLines(stats, tr = currentTranslator()) {
  const lines = [stats.node.below !== undefined ? tr.t("online.node.below", { min: stats.node.below }) : tr.t("online.node.exact", { n: stats.node.exact })];
  if (stats.network) {
    const { network } = stats;
    if (network.below !== undefined) lines.push(tr.t("online.network.below", { min: network.below }));
    else lines.push(network.nodes ? tr.t("online.network.exactNodes", { n: network.exact, nodes: network.nodes }) : tr.t("online.network.exact", { n: network.exact }));
    lines.push(tr.t("online.network.note"));
    if (network.asOf) lines.push(tr.t("online.asof", { time: new Date(network.asOf).toLocaleTimeString(tr.lang, { hour: "2-digit", minute: "2-digit" }) }));
  }
  lines.push(tr.t("online.privacy"));
  return lines;
}


/**
 * Asks the node for the numbers now and then and reports what happened through `onState(state, stats)`:
 *   "ready"       – a usable answer (stats given)
 *   "unavailable" – a passing failure (network, server error, rate limit, unusable answer): keep asking
 *   "off"         – the node has no counter or switched it off (401/403/404/405/410 or { enabled: false }): stop asking
 * Lives apart from the DOM so the behaviour can be tested with a fake fetch and fake timers.
 */
export class OnlineStatsPoller {
  #timer = null;
  #stopped = true;
  #inFlight = null;
  #hasStats = false;

  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), setTimeoutImpl = globalThis.setTimeout.bind(globalThis), clearTimeoutImpl = globalThis.clearTimeout.bind(globalThis), isVisible = () => globalThis.document?.visibilityState !== "hidden", url = "/v1/stats/online", onState }) {
    this.fetchImpl = fetchImpl;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.isVisible = isVisible;
    this.url = url;
    this.onState = onState;
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.refresh();
  }

  stop() {
    this.#stopped = true;
    this.clearTimeoutImpl(this.#timer);
  }

  /** One read (a read that is already running is shared). Never throws. */
  refresh() {
    if (this.#stopped) return Promise.resolve();
    this.#inFlight ??= this.#read().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  #schedule() {
    this.clearTimeoutImpl(this.#timer);
    if (!this.#stopped) this.#timer = this.setTimeoutImpl(() => void this.refresh(), REFRESH_MS);
  }

  async #read() {
    // Nothing to update in a background tab: skip the request, keep the timer going.
    if (!this.isVisible() && this.#hasStats) {
      this.#schedule();
      return;
    }
    let next = null;
    let off = false;
    try {
      // No credentials, no token: the endpoint is public, and this keeps the web session out of it.
      const response = await this.fetchImpl(this.url, { cache: "no-store", credentials: "omit" });
      if (OFF_STATUSES.has(response.status)) {
        off = true;
      } else if (response.ok) {
        const body = await response.json();
        if (isSwitchedOff(body)) off = true;
        else next = parseOnlineStats(body);
      }
    } catch {
      // network hiccup or unreadable answer: treated like "no number right now"
    }
    if (this.#stopped) return;

    if (off) {
      this.#hasStats = false;
      this.stop(); // this node has no counter (or it is switched off): do not keep asking
      this.onState("off", null);
      return;
    }
    this.#hasStats = Boolean(next);
    this.onState(next ? "ready" : "unavailable", next);
    this.#schedule();
  }
}

/**
 * The display element. `element` is a <details> that stays in the page for good (created once by the layout): it is
 * reserved-but-invisible until the first answer, hidden without a trace when the node has no counter, and afterwards only
 * its text changes — so neither the first answer nor a changing number moves anything.
 */
export class OnlineBadge {
  #stats = null;

  constructor(pollerOptions = {}) {
    this.summary = h("summary", { class: "online-summary" });
    this.detail = h("div", { class: "online-detail" });
    this.element = h("details", { class: "online-badge", "data-state": "pending" }, this.summary, this.detail);
    this.poller = new OnlineStatsPoller({ ...pollerOptions, onState: (state, stats) => this.#show(state, stats) });
    // Opened by choice, closed by Escape or a click elsewhere (a <details> alone would stay open over the map).
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.element.open) {
        this.element.open = false;
        this.summary.focus();
      }
    });
    document.addEventListener("click", (event) => {
      if (this.element.open && !this.element.contains(event.target)) this.element.open = false;
    });
  }

  get state() {
    return this.element.getAttribute("data-state");
  }

  start() {
    this.poller.start();
  }

  refresh() {
    return this.poller.refresh();
  }

  #show(state, stats) {
    this.#stats = stats;
    if (state === "ready") this.render();
    this.element.setAttribute("data-state", state);
    this.element.hidden = state === "off";
    if (state !== "ready") this.element.open = false;
  }

  /** Re-renders the texts (after a language switch). */
  render() {
    if (!this.#stats) return;
    const tr = currentTranslator();
    this.summary.replaceChildren(h("span", { class: "dot", "aria-hidden": "true" }), summaryText(this.#stats, tr));
    this.detail.replaceChildren(...detailLines(this.#stats, tr).map((line) => h("p", null, line)));
  }
}
