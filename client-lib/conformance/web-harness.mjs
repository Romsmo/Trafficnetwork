// Shared by the browser runs (run_web.mjs, run_web_example.mjs): a tiny static
// server that mounts the pieces of the repository a page imports, and a
// headless Chrome to open them in.
//
// URL prefix -> directory:  /js → bindings/wasm/js,  /pkg → bindings/wasm/pkg
// (wasm-pack output),  /shared → bindings/shared,  /example → bindings/wasm/example,
// /conformance → this directory.  A page imports "../js/index.js" and "../pkg/…"
// exactly as the integration guide shows, just from different base URLs.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const MOUNTS = [
  ["/js/", path.join(ROOT, "bindings", "wasm", "js")],
  ["/pkg/", path.join(ROOT, "bindings", "wasm", "pkg")],
  ["/shared/", path.join(ROOT, "bindings", "shared")],
  ["/example/", path.join(ROOT, "bindings", "wasm", "example")],
  ["/conformance/", HERE],
];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

export const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";

/** Serves the mounts above (and `/` → web/index.html); resolves with `{ port, close }`. */
export async function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let file = null;
    if (url.pathname === "/") {
      file = path.join(HERE, "web", "index.html");
    } else {
      for (const [prefix, directory] of MOUNTS) {
        if (url.pathname.startsWith(prefix)) {
          let relative = url.pathname.slice(prefix.length);
          if (relative === "" || relative.endsWith("/")) relative += "index.html";
          const candidate = path.resolve(directory, relative);
          if (candidate.startsWith(directory + path.sep)) file = candidate;
          break;
        }
      }
    }
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end(`not found: ${url.pathname}`);
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}

/** Launches headless Chrome, runs `fn(browser)`, always closes it. */
export async function withChrome(fn) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}
