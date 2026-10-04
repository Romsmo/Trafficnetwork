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

import { startStaticServer, withChrome } from "./web-harness.mjs";

const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:18990";

const server = await startStaticServer();
let exitCode = 1;
try {
  exitCode = await withChrome(async (browser) => {
    const page = await browser.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") console.error(`[browser] ${message.text()}`);
    });
    page.on("pageerror", (error) => console.error(`[browser] ${error}`));
    await page.goto(`http://127.0.0.1:${server.port}/?mock=${encodeURIComponent(MOCK)}`);
    await page.waitForFunction("window.__result !== undefined", { timeout: 120_000 });
    const { failed, lines } = await page.evaluate("window.__result");
    for (const line of lines) console.log(line);
    return failed > 0 ? 1 : 0;
  });
} finally {
  server.close();
}
process.exit(exitCode);
