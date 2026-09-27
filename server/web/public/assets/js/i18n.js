import de from "../i18n/de.js";
import en from "../i18n/en.js";

/** German and English; the browser language decides, a visible switch overrides it (kept in localStorage — no cookie). */
export const DICTIONARIES = { de, en };
export const SUPPORTED = Object.keys(DICTIONARIES);
const STORAGE_KEY = "tn-lang";

/** "de-AT" -> "de"; anything unsupported -> null. */
export function normalizeLang(tag) {
  if (typeof tag !== "string") return null;
  const base = tag.toLowerCase().split("-")[0];
  return SUPPORTED.includes(base) ? base : null;
}

/** Stored choice first, then the browser's preference order, then German. */
export function detectLang(navigatorLanguages, stored) {
  const fromStore = normalizeLang(stored);
  if (fromStore) return fromStore;
  for (const tag of navigatorLanguages ?? []) {
    const lang = normalizeLang(tag);
    if (lang) return lang;
  }
  return "de";
}

export function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/** Translator bound to one language; falls back to German, then to the key itself, so a gap is visible but never fatal. */
export function createTranslator(lang) {
  const dict = DICTIONARIES[lang] ?? DICTIONARIES.de;
  const t = (key, params) => interpolate(dict[key] ?? DICTIONARIES.de[key] ?? key, params);
  /** Plural by count: uses "<base>_one" for 1, "<base>_other" otherwise. */
  const tn = (base, n, params) => t(`${base}_${n === 1 ? "one" : "other"}`, { n, ...params });
  return { lang, t, tn };
}

let current = createTranslator("de");
const listeners = new Set();

function readStored() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function initI18n() {
  const lang = detectLang(globalThis.navigator?.languages ?? [globalThis.navigator?.language], readStored());
  current = createTranslator(lang);
  applyDocumentLang();
  return current;
}

function applyDocumentLang() {
  if (globalThis.document) globalThis.document.documentElement.lang = current.lang;
}

export function setLang(lang) {
  if (!SUPPORTED.includes(lang)) return;
  current = createTranslator(lang);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang);
  } catch {
    // storage unavailable (private mode): the choice simply lasts until the page is closed
  }
  applyDocumentLang();
  for (const listener of listeners) listener(current);
}

export function otherLang() {
  return current.lang === "de" ? "en" : "de";
}

export const t = (key, params) => current.t(key, params);
export const tn = (base, n, params) => current.tn(base, n, params);
export const currentLang = () => current.lang;
export const currentTranslator = () => current;

/** Runs `callback` now and after every language switch. */
export function onLangChange(callback) {
  listeners.add(callback);
  callback(current);
  return () => listeners.delete(callback);
}

/** Fills elements marked with data-i18n (text) and data-i18n-attr ("attr:key;attr:key"). */
export function applyTranslations(root = globalThis.document) {
  if (!root) return;
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.getAttribute("data-i18n"));
  for (const el of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of el.getAttribute("data-i18n-attr").split(";")) {
      const [attr, key] = pair.split(":").map((part) => part.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
}
