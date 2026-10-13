import { loadWebConfig, tileHost } from "./config.js";
import { initI18n } from "./i18n.js";
import { mountLayout } from "./layout.js";

/**
 * The legal pages (privacy notice, terms of use, imprint) are written in HTML, once per language; this fills in the few facts that
 * depend on the node - who runs it, which tile server, how long a session lasts - and shows or hides the parts that apply.
 * Nothing here is invented: an empty operator field stays empty and the page says so (docs/web-ui.md, "Legal pages").
 */
initI18n();
const config = await loadWebConfig();
const pageId = document.body.dataset.legal ?? "privacy";
mountLayout(config, pageId);

const operator = config.operator ?? { complete: false, address: [] };
const host = tileHost(config);

const values = {
  "operator.name": operator.name ?? "",
  "operator.address": (operator.address ?? []).join(", "),
  "operator.email": operator.email ?? "",
  "operator.phone": operator.phone ?? "",
  "operator.representative": operator.representative ?? "",
  "operator.register": operator.register ?? "",
  "operator.vatId": operator.vatId ?? "",
  "tiles.host": host ?? "",
  "roads.host": config.roadLookupHost ?? "",
  "session.minutes": String(Math.max(1, Math.round((config.sessionTtlSeconds ?? 900) / 60))),
  "retention.days": String(config.retentionDays ?? 3),
  repo: config.repoUrl ?? "",
};

const conditions = {
  "operator.complete": Boolean(operator.complete),
  "operator.missing": !operator.complete,
  "operator.representative": Boolean(operator.representative),
  "operator.phone": Boolean(operator.phone),
  "operator.register": Boolean(operator.register),
  "operator.vatId": Boolean(operator.vatId),
  tiles: Boolean(host),
  "no-tiles": !host,
  roads: Boolean(config.roadLookupHost),
  "no-roads": !config.roadLookupHost,
  "logging.privacy": config.privacyLogging !== false,
  "logging.full": config.privacyLogging === false,
};

for (const el of document.querySelectorAll("[data-fill]")) {
  const key = el.getAttribute("data-fill");
  el.textContent = values[key] ?? "";
}
for (const el of document.querySelectorAll("[data-href]")) {
  const key = el.getAttribute("data-href");
  if (key === "operator.email.mailto") {
    if (operator.email) el.setAttribute("href", `mailto:${operator.email}`);
  } else if (values[key]) {
    el.setAttribute("href", values[key]);
  }
}
for (const el of document.querySelectorAll("[data-if]")) {
  const key = el.getAttribute("data-if");
  el.hidden = !(conditions[key] ?? false);
}
