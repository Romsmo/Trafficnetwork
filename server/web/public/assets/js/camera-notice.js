import { h } from "./dom.js";
import { currentTranslator, onLangChange } from "./i18n.js";

/**
 * The notice on speed-camera reports, shown once when a visitor switches a camera category on. It informs; it is not a consent
 * dialog: the category is already on behind it, there is no "I agree", and the only button closes it. The same wording stands
 * permanently on the About page.
 */
export class CameraNotice {
  #open = false;

  constructor({ dialog }) {
    this.dialog = dialog;
    dialog.addEventListener("close", () => {
      this.#open = false;
    });
    onLangChange(() => {
      if (this.#open) this.render();
    });
  }

  show() {
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    this.#open = true;
  }

  close() {
    this.dialog.close();
  }

  render() {
    const tr = currentTranslator();
    this.dialog.setAttribute("aria-labelledby", "camera-notice-title");
    this.dialog.replaceChildren(
      h(
        "div",
        { class: "notice-box" },
        h("h2", { id: "camera-notice-title" }, tr.t("cameraNotice.title")),
        h("p", null, tr.t("cameraNotice.body")),
        h("p", null, tr.t("cameraNotice.region")),
        h("div", { class: "dialog-actions" }, h("button", { type: "button", class: "primary", onclick: () => this.close() }, tr.t("cameraNotice.close"))),
      ),
    );
  }
}
