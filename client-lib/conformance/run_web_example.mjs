// Drives the minimal browser example from the integration guide
// (bindings/wasm/example/index.html) like a person would — fill in the form,
// press both buttons — against the mock server, and fails unless it really
// connected, synced, read locally and queued/sent a report. What the guide
// tells a reader to build must work, not merely compile.
//
//     MOCK_URL=http://127.0.0.1:18990 node conformance/run_web_example.mjs

import { startStaticServer, withChrome } from "./web-harness.mjs";

const MOCK = process.env.MOCK_URL ?? "http://127.0.0.1:18990";

const created = await (
  await fetch(`${MOCK}/__instances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
).json();

const server = await startStaticServer();
let exitCode = 1;
try {
  exitCode = await withChrome(async (browser) => {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.error(`[browser] ${error}`));
    await page.goto(`http://127.0.0.1:${server.port}/example/`);

    await page.$eval("#server", (input, value) => (input.value = value), created.url);
    await page.type("#clientId", "example-client");
    await page.type("#clientSecret", "example-secret");

    await page.click("#go");
    await page.waitForFunction(
      "document.querySelector('#out').textContent.includes('things within 2 km') || /Error/.test(document.querySelector('#out').textContent)",
      { timeout: 60_000 },
    );
    await page.click("#report");
    await page.waitForFunction(
      "(document.querySelector('#out').textContent.match(/sync ok/g) || []).length >= 2",
      { timeout: 60_000 },
    );

    const text = await page.$eval("#out", (element) => element.textContent);
    console.log(text);
    const expected = ["sync ok: true", "speed limit here:", "things within 2 km", "queued report"];
    const missing = expected.filter((part) => !text.includes(part));
    if (missing.length > 0 || /Error/.test(text)) {
      console.error(`the example did not behave as the guide says; missing: ${JSON.stringify(missing)}`);
      return 1;
    }
    console.log("the browser example works");
    return 0;
  });
} finally {
  server.close();
}
process.exit(exitCode);
