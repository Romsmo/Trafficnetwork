/** Tiny element builder: h("a", { href: "/x", class: "y" }, "text", childNode). Text is always set as text, never as HTML. */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "class") el.className = value;
    else if (name.startsWith("on") && typeof value === "function") el.addEventListener(name.slice(2), value);
    else el.setAttribute(name, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  el.replaceChildren();
}

/** External links open in a new tab without leaking this node's address as Referer. */
export function externalLink(href, text, attrs = {}) {
  return h("a", { href, target: "_blank", rel: "noopener noreferrer", ...attrs }, text);
}

/** Copies text to the clipboard; resolves false when the browser refuses (no permission, insecure context). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
