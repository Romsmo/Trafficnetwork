import { loadWebConfig, tileHost } from "./config.js";
import { externalLink, h } from "./dom.js";
import { applyTranslations, initI18n, onLangChange, t } from "./i18n.js";
import { mountLayout } from "./layout.js";

initI18n();
const config = await loadWebConfig();
mountLayout(config, "about");

const host = tileHost(config);

function render() {
  const content = document.getElementById("about-content");
  content.replaceChildren(
    // The project link comes first and stands out: this page is where visitors find where the project lives.
    h(
      "section",
      { class: "card highlight" },
      h("h2", null, t("about.github.title")),
      h("p", null, t("about.github.body")),
      h("p", null, h("span", { class: "repo-cta" }, externalLink(config.repoUrl, t("about.github.button"), { class: "button primary" }))),
      h("p", { class: "hint" }, t("about.github.note")),
    ),
    h("section", { class: "card" }, h("h2", null, t("about.how.title")), h("p", null, t("about.how.body"))),
    h(
      "section",
      { class: "card" },
      h("h2", null, t("about.open.title")),
      h("p", null, t("about.open.body")),
      h("p", null, externalLink(`${config.repoUrl.replace(/\/+$/, "")}/blob/main/LICENSE`, t("about.license"))),
    ),
    h("section", { class: "card" }, h("h2", null, t("about.data.title")), h("p", null, t("about.data.body"))),
    h("section", { class: "card" }, h("h2", null, t("about.safety.title")), h("p", null, t("about.safety.body"))),
    h(
      "section",
      { class: "card", id: "privacy" },
      h("h2", null, t("about.privacy.title")),
      h(
        "ul",
        null,
        h("li", null, t("about.privacy.noAccount")),
        h("li", null, t("about.privacy.session")),
        h("li", null, t("about.privacy.location")),
        h("li", null, t("about.privacy.ip")),
        h("li", null, config.privacyLogging === false ? t("about.privacy.logs.off") : t("about.privacy.logs.on")),
        h("li", null, host ? t("about.privacy.tiles", { host }) : t("about.privacy.tiles.none")),
      ),
      h("p", null, t("about.privacy.more"), " ", externalLink(`${config.repoUrl.replace(/\/+$/, "")}/blob/main/docs/privacy.md`, t("about.privacy.link"))),
    ),
  );
  applyTranslations(document);
}

onLangChange(render);
