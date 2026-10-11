/**
 * The reporter's own duration (server 1.1.0: `expiresInSeconds` on POST /v1/hazard-reports, bounds per type in
 * GET /v1/config -> reportExpiry). Pure helpers: which quick choices a type offers, how a typed amount becomes seconds, what is
 * refused before sending, and how a duration reads in the visitor's language. Nothing here touches the page.
 */

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/** Quick choices, shortest first. A type shows those that lie inside its own bounds (at most MAX_QUICK of them, spread evenly). */
const QUICK_SECONDS = [10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 60 * DAY, 90 * DAY];
const MAX_QUICK = 6;

export const AMOUNT_UNITS = [
  { id: "minutes", seconds: MINUTE },
  { id: "hours", seconds: HOUR },
  { id: "days", seconds: DAY },
];

/**
 * The rule for one type from the node's config, or null when the node has none (an older server without `reportExpiry`, or a
 * type that never expires): then the page offers no choice and the default of the node applies.
 */
export function expiryRuleFor(reportExpiry, type) {
  const rule = reportExpiry && typeof reportExpiry === "object" ? reportExpiry[type] : null;
  if (!rule || typeof rule !== "object") return null;
  const { defaultSeconds, minSeconds, maxSeconds } = rule;
  const whole = (n) => Number.isInteger(n) && n > 0;
  if (!whole(defaultSeconds) || !whole(minSeconds) || !whole(maxSeconds) || minSeconds > maxSeconds) return null;
  return { defaultSeconds, minSeconds, maxSeconds };
}

/** The quick choices (in seconds) a type offers: inside [min, max], spread over at most six steps, shortest first. */
export function quickChoices(rule) {
  const inside = QUICK_SECONDS.filter((seconds) => seconds >= rule.minSeconds && seconds <= rule.maxSeconds);
  if (inside.length <= MAX_QUICK) return inside;
  const picked = [];
  for (let i = 0; i < MAX_QUICK; i += 1) picked.push(inside[Math.round((i * (inside.length - 1)) / (MAX_QUICK - 1))]);
  return [...new Set(picked)];
}

/**
 * Typed amount and unit -> { ok: true, seconds } or { ok: false, reason }.
 * `reason`: "empty" (nothing typed yet), "invalid" (not a positive whole number), "tooShort", "tooLong".
 */
export function parseAmount(amountText, unitId, rule) {
  const text = String(amountText ?? "").trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (!/^\d+$/.test(text)) return { ok: false, reason: "invalid" };
  const unit = AMOUNT_UNITS.find((u) => u.id === unitId);
  const amount = Number(text);
  if (!unit || !Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: "invalid" };
  const seconds = amount * unit.seconds;
  if (seconds < rule.minSeconds) return { ok: false, reason: "tooShort" };
  if (seconds > rule.maxSeconds) return { ok: false, reason: "tooLong" };
  return { ok: true, seconds };
}

/** Splits a number of seconds into the largest unit that holds it exactly, e.g. 5400 -> { amount: 90, unit: "minutes" }. */
export function splitSeconds(seconds) {
  for (const unit of [...AMOUNT_UNITS].reverse()) {
    if (seconds % unit.seconds === 0) return { amount: seconds / unit.seconds, unit: unit.id };
  }
  return { amount: Math.round(seconds / MINUTE), unit: "minutes" };
}

/**
 * "3 Stunden", "14 Tage", "90 Minuten": exact, never rounded (a bound of 10 minutes must not read as "0 hours"). `tr` is a
 * translator from i18n.js; the keys are `duration.minutes_one/_other`, `duration.hours_*`, `duration.days_*`.
 */
export function formatExactDuration(seconds, tr) {
  const { amount, unit } = splitSeconds(seconds);
  return tr.tn(`duration.${unit}`, amount);
}

/** The server's refusal (400 EXPIRY_OUT_OF_RANGE) as the numbers the page can quote, or null when it is some other error. */
export function expiryRefusal(error) {
  if (error?.status !== 400 || error?.code !== "EXPIRY_OUT_OF_RANGE") return null;
  const d = error.details ?? {};
  const ok = ["minSeconds", "maxSeconds"].every((key) => Number.isInteger(d[key]));
  return ok ? { minSeconds: d.minSeconds, maxSeconds: d.maxSeconds, defaultSeconds: d.defaultSeconds } : null;
}

/** "Do., 11.10.2026, 15:30" in the visitor's language and time zone. Empty for something that is not a date. */
export function formatEndDate(isoOrPostgres, lang, normalize = (v) => v) {
  const ms = Date.parse(normalize(isoOrPostgres));
  if (Number.isNaN(ms)) return "";
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}
