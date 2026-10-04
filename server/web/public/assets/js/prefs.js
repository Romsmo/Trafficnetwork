import { defaultEnabled } from "./filter.js";

/**
 * What the page remembers in the browser (localStorage — no cookie, nothing is sent anywhere): which categories the visitor
 * switched on or off, and whether they have already seen the notice on speed-camera reports. Both are per browser and harmless;
 * if the browser refuses storage (private mode, blocked) the page simply starts from its defaults every time.
 */
const FILTERS_KEY = "tn.filters.v1";
const NOTICE_KEY = "tn.cameraNotice.v1";

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // accessing localStorage itself can throw
  }
}

/** The visitor's explicit choices: { [type]: true | false }. Types they never touched are absent and follow the default. */
export function loadFilterPrefs(store = storage()) {
  try {
    const parsed = JSON.parse(store?.getItem(FILTERS_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const prefs = {};
    for (const [type, value] of Object.entries(parsed)) if (typeof value === "boolean") prefs[type] = value;
    return prefs;
  } catch {
    return {};
  }
}

export function saveFilterPref(type, enabled, store = storage()) {
  try {
    const prefs = loadFilterPrefs(store);
    prefs[type] = enabled;
    store?.setItem(FILTERS_KEY, JSON.stringify(prefs));
  } catch {
    // nothing to do: the choice just is not remembered
  }
}

/**
 * Which of `types` are switched on: what the visitor chose, otherwise the default — the general categories on, the speed-camera
 * categories off until the visitor ticks them themselves.
 */
export function initialSelection(types, prefs = {}) {
  return new Set(types.filter((type) => prefs[type] ?? defaultEnabled(type)));
}

/** Has the visitor already been shown the notice (this wording, or a newer one)? */
export function noticeSeen(version, store = storage()) {
  try {
    return Number(store?.getItem(NOTICE_KEY)) >= version;
  } catch {
    return false;
  }
}

export function markNoticeSeen(version, store = storage()) {
  try {
    store?.setItem(NOTICE_KEY, String(version));
  } catch {
    // shown again next time — better than the opposite
  }
}
