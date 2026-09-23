import { expect, test } from "@playwright/test";
import { countGeolocationCalls, openMap, reportViaApi, submitReportDialog, TILE_ORIGIN, watchTraffic } from "./helpers.js";
import { instanceUrl } from "./instances.js";
import { nearCenter } from "./seed.js";

const node = instanceUrl("main");

test.describe("map page", () => {
  test("loads with the node's own files and map tiles only — nothing else leaves the browser — and without errors", async ({ page }) => {
    const traffic = await watchTraffic(page, node);
    await openMap(page, node);
    await expect.poll(() => traffic.tiles.length).toBeGreaterThan(0);

    expect(traffic.external).toEqual([]);
    expect(traffic.tiles.every((url) => url.startsWith(`${TILE_ORIGIN}/`))).toBe(true);
    expect(traffic.sockets).toEqual([`ws://127.0.0.1:${new URL(node).port}/v1/ws`]);
    expect(await traffic.cspViolations()).toEqual([]);
    expect(traffic.consoleErrors).toEqual([]);

    // The map opened on the region the node has data for (the seeded Munich streets), with the attribution the tile provider requires.
    await expect(page.locator(".leaflet-control-attribution")).toContainText("OpenStreetMap");
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(page.locator("#safety-banner")).toContainText("Nicht während der Fahrt");
  });

  test("works without location permission, and only asks the browser for the position when the visitor presses a button", async ({ page }) => {
    const geolocationCalls = await countGeolocationCalls(page);
    await watchTraffic(page, node);
    await openMap(page, node);

    // Reporting at the map centre needs no location at all.
    await submitReportDialog(page, "Hindernis");
    await expect(page.locator("#report-dialog .result.ok")).toContainText("auf der Karte");
    expect(await geolocationCalls()).toBe(0);

    // "My location" is the visitor's explicit action; without permission the page says so and stays usable.
    await page.locator("#report-dialog").getByRole("button", { name: "Schließen" }).click();
    await page.locator("#locate").click();
    await expect(page.locator("#map-status")).toContainText("nicht verfügbar oder wurde nicht freigegeben");
    expect(await geolocationCalls()).toBe(1);
    await expect(page.locator("#report-open")).toBeEnabled();
  });

  test("uses the visitor's location for a report only after they press 'Meinen Standort verwenden'", async ({ browser }) => {
    const context = await browser.newContext({ geolocation: { latitude: 48.1402, longitude: 11.5821 }, permissions: ["geolocation"] });
    const page = await context.newPage();
    const geolocationCalls = await countGeolocationCalls(page);
    await watchTraffic(page, node);
    await openMap(page, node);
    expect(await geolocationCalls()).toBe(0);

    await page.locator("#report-open").click();
    const dialog = page.locator("#report-dialog");
    await expect(dialog).toContainText(/Gewählte Stelle: 48\.137\d\d, 11\.575\d\d/);
    await dialog.getByRole("button", { name: "Meinen Standort verwenden" }).click();
    await expect(dialog).toContainText("Gewählte Stelle: 48.14020, 11.58210");
    expect(await geolocationCalls()).toBe(1);
    await context.close();
  });

  test("a report shows up on the map and in the list, and the reporter's own confirmation is honestly not counted", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await submitReportDialog(page, "Stau");
    await expect(page.locator("#report-dialog .result.ok")).toContainText("Danke! Deine Meldung ist jetzt auf der Karte.");
    await page.locator("#report-dialog").getByRole("button", { name: "Schließen" }).click();

    await expect(page.locator(".hz-icon.type-traffic")).toHaveCount(1);
    await expect(page.locator("#report-list")).toContainText("Stau");

    await page.locator(".hz-icon.type-traffic").click();
    const popup = page.locator(".leaflet-popup-content");
    await expect(popup).toContainText("0 × bestätigt");
    await popup.getByRole("button", { name: "Ist noch da" }).click();
    await expect(popup.locator(".status")).toContainText("nicht gezählt");
  });

  test("another visitor sees a new report live, and their confirmation counts", async ({ page, browser, request }) => {
    const other = await (await browser.newContext({ locale: "de-DE" })).newPage();
    await watchTraffic(page, node);
    await watchTraffic(other, node);
    await openMap(page, node);
    await openMap(other, node);
    await expect(other.locator(".hz-icon.type-ice")).toHaveCount(0);

    await submitReportDialog(page, "Glätte");
    await expect(page.locator("#report-dialog .result.ok")).toBeVisible();
    await page.locator("#report-dialog").getByRole("button", { name: "Schließen" }).click();

    // No reload on the other side: the node pushes it over the WebSocket.
    await expect(other.locator(".hz-icon.type-ice")).toHaveCount(1);
    await other.locator(".hz-icon.type-ice").click();
    const popup = other.locator(".leaflet-popup-content");
    await popup.getByRole("button", { name: "Ist noch da" }).click();
    await expect(popup.locator(".status")).toContainText("deine Rückmeldung wurde gezählt");
    await expect(popup).toContainText("1 × bestätigt");

    // ... and it reaches the first visitor's marker too.
    await page.locator(".hz-icon.type-ice").click();
    await expect(page.locator(".leaflet-popup-content")).toContainText("1 × bestätigt");

    // Someone else reporting the same hazard a few metres away is merged into the existing report, not duplicated.
    const again = await reportViaApi(request, node, { type: "ice", ...nearCenter(0.0004, 0.0004) });
    expect(again.merged).toBe(true);
    await expect(page.locator(".hz-icon.type-ice")).toHaveCount(1);
    await other.context().close();
  });

  test("clicking the map tells the speed limit of the road there", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    // Hide the hazard markers other tests left in the middle of the map, so the click reaches the map itself.
    for (const box of await page.locator("#filters input[type=checkbox]").all()) await box.uncheck();
    await page.locator("#map").click(); // the middle of the map is the seeded 50 km/h street
    await expect(page.locator(".leaflet-popup-content")).toContainText("Tempolimit hier: 50 km/h");
  });

  test("the speed-limit layer explains when to zoom, then colours the roads", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#layer-limits").check();
    await expect(page.locator("#limits-hint")).toContainText(/Näher heranzoomen|Straßenabschnitt/);

    for (let i = 0; i < 3 && !(await page.locator("#limits-hint").innerText()).match(/Straßenabschnitt/); i += 1) {
      await page.locator(".leaflet-control-zoom-in").click();
      await page.waitForTimeout(900);
    }
    await expect(page.locator("#limits-hint")).toContainText(/\d+ Straßenabschnitte? im Ausschnitt/);
    await expect(page.locator(".legend")).toBeVisible();
    await page.locator("#layer-limits").uncheck();
    await expect(page.locator(".legend")).toHaveCount(0);
  });

  test("category filters hide and show markers", async ({ page, request }) => {
    await reportViaApi(request, node, { type: "breakdown", ...nearCenter(-0.002, 0.002) });
    await watchTraffic(page, node);
    await openMap(page, node);
    await expect(page.locator(".hz-icon.type-breakdown")).toHaveCount(1);

    const filter = page.locator("#filters").getByRole("checkbox", { name: "Panne" });
    await filter.uncheck();
    await expect(page.locator(".hz-icon.type-breakdown")).toHaveCount(0);
    await expect(page.locator("#report-list")).not.toContainText("Panne");
    await filter.check();
    await expect(page.locator(".hz-icon.type-breakdown")).toHaveCount(1);
  });

  test("the visitor can pick the spot on the map instead of using the centre", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#report-open").click();
    const dialog = page.locator("#report-dialog");
    await dialog.getByRole("button", { name: "Auf der Karte auswählen" }).click();
    await expect(page.locator("#pick-chip")).toBeVisible();
    const box = (await page.locator("#map").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40);
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText(/Gewählte Stelle: 48\.137\d\d, 11\.575\d\d/);
    await expect(dialog).toContainText(/Gewählte Stelle: 48\.\d{5}, 11\.\d{5}/);
  });

  test("switches between German and English and remembers the choice on the other pages", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.getByRole("button", { name: /English/ }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("#report-open")).toHaveText("Report a hazard");
    await expect(page.locator(".site-nav")).toContainText("Connect");

    await page.goto(`${node}/about`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("About the project");
    await page.getByRole("button", { name: /Deutsch/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Über das Projekt");
  });
});
