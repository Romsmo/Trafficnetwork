import { applyTranslations, currentLang, onLangChange, otherLang, setLang, t } from "./i18n.js";
import { externalLink, h } from "./dom.js";

const PAGES = [
  { id: "map", href: "/", key: "nav.map" },
  { id: "connect", href: "/connect", key: "nav.connect" },
  { id: "about", href: "/about", key: "nav.about" },
];

/** Header (brand, navigation, language switch), safety notice and footer (GitHub, license, version, privacy) for every page. */
export function mountLayout(config, pageId) {
  const header = document.getElementById("site-header");
  const footer = document.getElementById("site-footer");

  const render = () => {
    document.title = t(`page.${pageId}.title`);

    header.className = "site-header";
    header.replaceChildren(
      h("a", { class: "brand", href: "/" }, t("site.name")),
      h(
        "nav",
        { class: "site-nav", "aria-label": t("nav.label") },
        PAGES.map((page) => h("a", { href: page.href, "aria-current": page.id === pageId ? "page" : undefined }, t(page.key))),
      ),
      h(
        "div",
        { class: "header-tools" },
        h(
          "button",
          {
            type: "button",
            class: "small",
            lang: otherLang(),
            title: t("lang.switch.title"),
            "aria-label": t("lang.switch.title"),
            onclick: () => setLang(otherLang()),
          },
          t("lang.other"),
        ),
      ),
    );

    let banner = document.getElementById("safety-banner");
    if (!banner) {
      banner = h("div", { id: "safety-banner", class: "safety-banner", role: "note" });
      header.after(banner);
    }
    banner.textContent = `⚠ ${t("safety.banner")}`;

    footer.className = "site-footer";
    footer.replaceChildren(
      externalLink(config.repoUrl, t("footer.github")),
      externalLink(`${config.repoUrl}/blob/main/LICENSE`, t("footer.license")),
      h("span", null, t("footer.version", { version: config.version })),
      externalLink(`${config.repoUrl}/blob/main/docs/privacy.md`, t("footer.privacy")),
      h("a", { href: "/about" }, t("nav.about")),
    );

    applyTranslations(document);
    document.documentElement.lang = currentLang();
  };

  onLangChange(render);
}
