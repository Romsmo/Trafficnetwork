import { expect, test } from "@playwright/test";
import { openMap, reportViaApi, submitReportDialog, watchTraffic } from "./helpers.js";
import { instanceUrl } from "./instances.js";
import { nearCenter } from "./seed.js";

const CAMERA_LABELS = ["Feste Blitzer", "Mobile Kontrolle", "Anhänger-Kontrolle", "Rotlicht-Kontrolle", "Abstandskontrolle"];

test.describe("speed-camera categories follow the node's flag", () => {
  test("flag off: no camera category anywhere in the UI, and the API refuses them for web visitors", async ({ page, request }) => {
    const node = instanceUrl("main");
    await watchTraffic(page, node);
    await openMap(page, node);

    const filters = page.locator("#filters");
    await expect(filters.getByRole("checkbox")).toHaveCount(6);
    await page.locator("#report-open").click();
    const dialog = page.locator("#report-dialog");
    await expect(dialog.getByRole("radio")).toHaveCount(6);
    for (const label of CAMERA_LABELS) {
      await expect(filters).not.toContainText(label);
      await expect(dialog).not.toContainText(label);
    }
    await expect(page.locator("body")).not.toContainText(/Blitzer|Kontrolle/);

    const session = await request.post(`${node}/v1/web/session`, { headers: { "sec-fetch-site": "same-origin" } });
    const { accessToken } = (await session.json()) as { accessToken: string };
    const attempt = await request.post(`${node}/v1/hazard-reports`, { headers: { authorization: `Bearer ${accessToken}` }, data: { type: "mobileSpeedCamera", ...nearCenter() } });
    expect(attempt.status()).toBeGreaterThanOrEqual(400);
    expect(attempt.status()).toBeLessThan(500);
    const config = (await (await request.get(`${node}/v1/config`, { headers: { authorization: `Bearer ${accessToken}` } })).json()) as { speedCameraNamespaceEnabled: boolean };
    expect(config.speedCameraNamespaceEnabled).toBe(false);
  });

  test("flag on: the categories appear, can be reported, and show up as camera markers", async ({ page }) => {
    const node = instanceUrl("cameras");
    await watchTraffic(page, node);
    await openMap(page, node);

    const filters = page.locator("#filters");
    await expect(filters.getByRole("checkbox")).toHaveCount(11);
    for (const label of CAMERA_LABELS) await expect(filters).toContainText(label);

    await submitReportDialog(page, "Mobile Kontrolle");
    await expect(page.locator("#report-dialog .result.ok")).toBeVisible();
    await page.locator("#report-dialog").getByRole("button", { name: "Schließen" }).click();
    await expect(page.locator(".hz-icon.camera")).toHaveCount(1);
  });

  test("flag off: a camera report made on a node where it is on stays invisible (REST and live)", async ({ page, request }) => {
    // Same database, two nodes: the operator of "main" did not release the camera namespace, so its UI must not learn about it.
    await reportViaApi(request, instanceUrl("cameras"), { type: "trailerCamera", ...nearCenter(0.001, 0.001) });
    const node = instanceUrl("main");
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.waitForTimeout(500);
    await expect(page.locator(".hz-icon.camera")).toHaveCount(0);
  });
});

test.describe("limits are answered honestly", () => {
  test("when the node's report limit for a session is reached, the visitor is told which limit and when to retry", async ({ page }) => {
    const node = instanceUrl("limited");
    await watchTraffic(page, node);
    await openMap(page, node);

    await submitReportDialog(page, "Unfall");
    const result = page.locator("#report-dialog .result");
    await expect(result).toContainText("Danke! Deine Meldung ist jetzt auf der Karte.");
    await page.locator("#report-dialog").getByRole("button", { name: "Schließen" }).click();

    await submitReportDialog(page, "Baustelle");
    await expect(page.locator("#report-dialog .result.bad")).toContainText(/Begrenzung für Meldungen ist erreicht \(diese Sitzung\)\. Bitte in etwa \d+ Min\. erneut versuchen\./);
    // The first report is still there; nothing was silently lost or duplicated.
    await page.locator("#report-dialog").getByRole("button", { name: /Schließen|Abbrechen/ }).first().click();
    await expect(page.locator(".hz-icon.type-accident")).toHaveCount(1);
    await expect(page.locator(".hz-icon.type-construction")).toHaveCount(0);
  });
});

test.describe("web UI switched off", () => {
  const node = instanceUrl("disabled");

  for (const path of ["/", "/connect", "/about", "/web-config.json", "/web/js/map-page.js", "/web/css/app.css", "/web/vendor/leaflet/leaflet.js", "/web/vendor/h3/h3-js.es.js", "/web/i18n/de.js"]) {
    test(`${path} serves nothing`, async ({ request }) => {
      const response = await request.get(`${node}${path}`);
      expect(response.status()).toBe(404);
      const body = await response.text();
      expect(body).not.toContain("Trafficnetwork");
    });
  }

  test("the session endpoint does not exist, while the API is unaffected", async ({ request }) => {
    expect((await request.post(`${node}/v1/web/session`, { headers: { "sec-fetch-site": "same-origin" } })).status()).toBe(404);
    const health = await request.get(`${node}/v1/health`);
    expect(health.ok()).toBe(true);
    expect((await health.json()) as { status: string }).toMatchObject({ status: "ok" });
    expect((await request.get(`${node}/v1/network/node-info`)).ok()).toBe(true);
    expect((await request.get(`${node}/v1/speed-limit?lat=48.1&lng=11.5`)).status()).toBe(401);
  });

  test("a browser gets the plain 404 and no page", async ({ page }) => {
    const response = await page.goto(`${node}/`);
    expect(response?.status()).toBe(404);
    await expect(page.locator("#map")).toHaveCount(0);
  });
});
