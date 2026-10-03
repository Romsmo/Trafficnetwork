// Runs conformance/scenarios.json through the WebAssembly binding in a real
// (headless) Chrome — a browser is the one place this binding is meant to
// run, and the only place IndexedDB, `fetch()` and `localStorage` exist:
//
//     MOCK_URL=http://127.0.0.1:18990 CHROME_PATH=/usr/bin/google-chrome \
//         node conformance/run_web.mjs
//
// Needs `wasm-pack build --target web --out-dir pkg` to have run in
// bindings/wasm, and the mock server (mock-server.mjs) to be running. The
// scenario logic is the same file the Node run uses (scenario-runner.mjs).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:18990";
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";

// URL prefix -> directory it is served from.
const MOUNTS = [
  ["/js/", path.join(ROOT, "bindings", "wasm", "js")],
  ["/pkg/", path.join(ROOT, "bindings", "wasm", "pkg")],
  ["/shared/", path.join(ROOT, "bindings", "shared")],
  ["/conformance/", HERE],
];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let file = null;
  if (url.pathname === "/") {
    file = path.join(HERE, "web", "index.html");
  } else {
    for (const [prefix, directory] of MOUNTS) {
      if (url.pathname.startsWith(prefix)) {
        const candidate = path.resolve(directory, url.pathname.slice(prefix.length));
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
const { port } = server.address();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
let exitCode = 1;
try {
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`[browser] ${message.text()}`);
  });
  page.on("pageerror", (error) => console.error(`[browser] ${error}`));
  await page.goto(`http://127.0.0.1:${port}/?mock=${encodeURIComponent(MOCK)}`);
  await page.waitForFunction("window.__result !== undefined", { timeout: 120_000 });
  const { failed, lines } = await page.evaluate("window.__result");
  for (const line of lines) console.log(line);
  exitCode = failed > 0 ? 1 : 0;
} finally {
  await browser.close();
  server.close();
}
process.exit(exitCode);
