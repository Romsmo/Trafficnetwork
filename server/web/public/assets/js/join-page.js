import { loadWebConfig } from "./config.js";
import { copyText, h } from "./dom.js";
import { applyTranslations, initI18n, onLangChange, t } from "./i18n.js";
import { mountLayout } from "./layout.js";

initI18n();
const config = await loadWebConfig();
mountLayout(config, "join");

/** { available: false } when this node has no public code to show. */
let data;
try {
  const response = await fetch("/join-code.json", { cache: "no-store" });
  data = response.ok ? await response.json() : { available: false };
} catch {
  data = { available: false };
}

/** The QR code comes from this node as SVG text; it is parsed as an image document and never evaluated as HTML. */
function qrElement(svgText) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const svg = doc.documentElement;
  if (!svg || svg.nodeName !== "svg") return null;
  const node = document.importNode(svg, true);
  node.setAttribute("class", "join-qr");
  node.removeAttribute("width");
  node.removeAttribute("height");
  node.setAttribute("aria-label", t("join.qr.label"));
  const title = node.querySelector("title");
  if (title) title.textContent = t("join.qr.label");
  return node;
}

function render() {
  const content = document.getElementById("join-content");
  if (!data.available) {
    content.replaceChildren(h("section", { class: "card" }, h("p", null, t("join.unavailable"))));
    applyTranslations(document);
    return;
  }

  const copyButton = h("button", { type: "button", class: "small", "aria-describedby": "join-code-text" }, t("join.copy"));
  copyButton.addEventListener("click", async () => {
    if (await copyText(data.code)) {
      copyButton.textContent = t("join.copied");
      window.setTimeout(() => {
        copyButton.textContent = t("join.copy");
      }, 1800);
    }
  });

  const qr = qrElement(data.svg);
  content.replaceChildren(
    h(
      "section",
      { class: "card highlight", "aria-labelledby": "join-code-title" },
      h("h2", { id: "join-code-title" }, t("join.code.title")),
      h(
        "div",
        { class: "join-grid" },
        qr ? h("div", { class: "join-qr-box" }, qr) : null,
        h("div", null, h("p", null, t("join.code.text")), h("pre", { class: "code join-code", id: "join-code-text", tabindex: "0" }, h("code", null, data.code), copyButton)),
      ),
      h(
        "dl",
        { class: "facts" },
        h("dt", null, t("join.node")),
        h("dd", null, h("code", null, data.node)),
        h("dt", null, t("join.fingerprint")),
        h("dd", null, data.fingerprint ? h("code", null, data.fingerprint) : t("join.fingerprint.none")),
      ),
      data.fingerprint ? h("p", { class: "hint" }, t("join.fingerprint.hint")) : null,
    ),
    h("section", { class: "card" }, h("h2", null, t("join.steps.title")), h("ol", null, h("li", null, t("join.step1")), h("li", null, t("join.step2")), h("li", null, t("join.step3")))),
    h("section", { class: "card" }, h("h2", null, t("join.purpose.title")), h("p", null, t("join.purpose.body")), h("p", null, t("join.purpose.limits"))),
  );
  applyTranslations(document);
}

render();
onLangChange(render);
