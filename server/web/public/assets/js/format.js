/** Human-readable duration ("5 Minuten", "2 hours"); `tr` is a translator from i18n.js (createTranslator). */
export function formatDuration(ms, tr) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return tr.t("time.lessThanMinute");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return tr.tn("time.minutes", minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return tr.tn("time.hours", hours);
  return tr.tn("time.days", Math.round(hours / 24));
}

/** "reported 5 minutes ago". */
export function formatAge(reportedAtIso, nowMs, tr) {
  const reported = Date.parse(normalizeTimestamp(reportedAtIso));
  if (Number.isNaN(reported)) return "";
  return tr.t("report.age", { duration: formatDuration(nowMs - reported, tr) });
}

/** "expires in 20 minutes", or "expired". */
export function formatRemaining(expiresAtIso, nowMs, tr) {
  const expires = Date.parse(normalizeTimestamp(expiresAtIso));
  if (Number.isNaN(expires)) return "";
  const left = expires - nowMs;
  if (left <= 0) return tr.t("report.expired");
  return tr.t("report.remaining", { duration: formatDuration(left, tr) });
}

/** Postgres returns "2026-09-23 19:04:18.119+00"; make that a valid ISO string for Date.parse in every browser. */
export function normalizeTimestamp(value) {
  if (typeof value !== "string") return value;
  return value.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
}

export function isExpired(expiresAt, nowMs) {
  const t = Date.parse(normalizeTimestamp(expiresAt));
  return Number.isNaN(t) ? false : t <= nowMs;
}

/** Kilometres, without a needless decimal ("25", "1.5"). */
export function formatKm(meters) {
  const km = meters / 1000;
  return Number.isInteger(km) ? String(km) : km.toFixed(1);
}

/** Colour for a speed limit, matching the legend. Thresholds are in the segment's own unit. */
export function speedLimitColor(limit, unit) {
  const kmh = unit === "mph" ? limit * 1.609344 : limit;
  if (kmh <= 30) return "#0f8a5f";
  if (kmh <= 50) return "#c26a00";
  if (kmh <= 70) return "#b5177a";
  if (kmh <= 100) return "#1d5fd0";
  return "#6b3fd4";
}
