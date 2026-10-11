/**
 * The bottom sheet of the map page (phone portrait): rests at three heights ("small", "half", "full"), is moved by dragging its
 * handle or with the keyboard (Enter/Space cycles, arrow keys step, Home/End jump, Escape collapses), and on wide screens or a
 * phone held sideways it is simply the side panel (mode "panel": no detents, nothing inert).
 *
 * The handle is a real <button> with aria-expanded, so a screen reader announces it and "activate" works without any gesture.
 * While the sheet rests at "small" the content below the header is `inert` — it is not in the tab order or the accessibility tree
 * and cannot be focused behind the map; activating the handle opens it.
 */

/** Phone layout: the sheet. Everything wider, and a phone on its side (little height), uses the side panel. */
export const SHEET_MEDIA = "(max-width: 899px) and (not ((orientation: landscape) and (max-height: 500px)))";
export const DETENTS = ["small", "half", "full"];

const FULL_GAP_PX = 56; // the map's top edge stays visible above a full sheet
const MIN_HALF_EXTRA_PX = 140; // "half" shows at least this much more than "small"
const DRAG_CLICK_SLOP_PX = 6;

/** The detent a release at `height` should settle in, given the fling velocity (px/ms, negative = upwards). */
export function settleDetent(height, heights, velocity = 0) {
  const biased = height + velocity * -120; // an upward fling (negative velocity) counts as a bit higher than it is
  let best = "small";
  let bestDistance = Infinity;
  for (const name of DETENTS) {
    const distance = Math.abs(heights[name] - biased);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

/** The detent after "activate": small -> half -> full -> small. */
export function nextDetent(current) {
  return DETENTS[(DETENTS.indexOf(current) + 1) % DETENTS.length];
}

export function stepDetent(current, direction) {
  const index = DETENTS.indexOf(current) + direction;
  return DETENTS[Math.max(0, Math.min(DETENTS.length - 1, index))];
}

export class BottomSheet {
  #detent = "small";
  #mode = "panel";
  #drag = null;
  #suppressClick = false;

  /**
   * @param root      the <aside>
   * @param handle    the grab <button> (inside `top`)
   * @param top       the always-visible part: handle + header
   * @param body      the scrolling content below it
   * @param container the element whose height the sheet's detents are fractions of (the map area)
   * @param onChange  called with (detent, mode) after every change
   */
  constructor({ root, handle, top, body, container, onChange = () => {} }) {
    Object.assign(this, { root, handle, top, body, container, onChange });
    this.query = window.matchMedia(SHEET_MEDIA);
    this.query.addEventListener("change", () => this.#applyMode());
    new ResizeObserver(() => this.#apply()).observe(container);

    handle.addEventListener("click", () => {
      if (this.#suppressClick) {
        this.#suppressClick = false;
        return;
      }
      this.setDetent(nextDetent(this.#detent));
    });
    handle.addEventListener("keydown", (event) => {
      const moves = { ArrowUp: () => stepDetent(this.#detent, 1), ArrowDown: () => stepDetent(this.#detent, -1), Home: () => "small", End: () => "full" };
      const move = moves[event.key];
      if (!move) return;
      event.preventDefault();
      this.setDetent(move());
    });
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || this.#mode !== "sheet" || this.#detent === "small" || event.defaultPrevented) return;
      // Escape inside an open dialog or popup belongs to that; this one is for the sheet itself.
      if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
      event.preventDefault();
      this.setDetent("small");
      handle.focus();
    });

    // One set of listeners on the top part: events of the handle (and of the empty parts of the header) bubble up to it.
    top.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const interactive = target.closest("button, a, input, select, textarea");
      if (interactive && interactive !== handle) return;
      this.#dragStart(event);
    });
    top.addEventListener("pointermove", (event) => this.#dragMove(event));
    top.addEventListener("pointerup", (event) => this.#dragEnd(event));
    top.addEventListener("pointercancel", (event) => this.#dragEnd(event, true));

    this.#applyMode();
  }

  get detent() {
    return this.#detent;
  }

  get mode() {
    return this.#mode;
  }

  /** Heights in px of the three resting places for the current container. */
  heights() {
    const style = getComputedStyle(this.root);
    const small = Math.ceil(this.top.getBoundingClientRect().height + (parseFloat(style.paddingBottom) || 0));
    const available = this.container.clientHeight;
    const full = Math.max(small + MIN_HALF_EXTRA_PX * 2, available - FULL_GAP_PX);
    const half = Math.min(full - 60, Math.max(small + MIN_HALF_EXTRA_PX, Math.round(available * 0.5)));
    return { small, half, full };
  }

  setDetent(name, { announce = true } = {}) {
    if (!DETENTS.includes(name)) return;
    this.#detent = name;
    this.#apply();
    if (announce) this.onChange(this.#detent, this.#mode);
  }

  #applyMode() {
    this.#mode = this.query.matches ? "sheet" : "panel";
    this.root.dataset.mode = this.#mode;
    this.#apply();
    this.onChange(this.#detent, this.#mode);
  }

  #apply(heightOverride = null) {
    const parent = this.root.parentElement;
    this.root.dataset.detent = this.#detent;
    if (this.#mode === "panel") {
      this.root.style.removeProperty("--sheet-h");
      parent?.style.removeProperty("--sheet-offset");
      this.body.inert = false;
      this.handle.setAttribute("aria-expanded", "true");
      return;
    }
    const heights = this.heights();
    const height = heightOverride ?? heights[this.#detent];
    this.root.style.setProperty("--sheet-h", `${Math.round(height)}px`);
    // The map's own controls (attribution, legend) stay above the sheet.
    parent?.style.setProperty("--sheet-offset", `${Math.round(Math.min(height, heights.full))}px`);
    this.body.inert = this.#detent === "small" && heightOverride === null;
    this.handle.setAttribute("aria-expanded", String(this.#detent !== "small"));
  }

  #dragStart(event) {
    if (this.#mode !== "sheet" || (event.pointerType === "mouse" && event.button !== 0)) return;
    const heights = this.heights();
    this.#drag = { id: event.pointerId, startY: event.clientY, startHeight: heights[this.#detent], heights, last: { y: event.clientY, t: event.timeStamp }, velocity: 0, moved: false };
  }

  #dragMove(event) {
    const drag = this.#drag;
    if (!drag || drag.id !== event.pointerId) return;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < DRAG_CLICK_SLOP_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      this.root.classList.add("dragging");
      // Captured only once it is a drag: a plain tap must still arrive as a click on the handle.
      this.top.setPointerCapture?.(event.pointerId);
    }
    const dt = Math.max(1, event.timeStamp - drag.last.t);
    drag.velocity = (event.clientY - drag.last.y) / dt;
    drag.last = { y: event.clientY, t: event.timeStamp };
    const height = Math.max(drag.heights.small, Math.min(drag.heights.full, drag.startHeight - dy));
    this.#apply(height);
  }

  #dragEnd(event, cancelled = false) {
    const drag = this.#drag;
    if (!drag || drag.id !== event.pointerId) return;
    this.#drag = null;
    this.root.classList.remove("dragging");
    if (!drag.moved) return; // a plain tap: the click handler cycles
    this.#suppressClick = true;
    window.setTimeout(() => {
      this.#suppressClick = false;
    }, 0);
    const current = parseFloat(this.root.style.getPropertyValue("--sheet-h")) || drag.startHeight;
    this.setDetent(cancelled ? this.#detent : settleDetent(current, drag.heights, drag.velocity));
  }
}
