import { expect, test, type Page } from "@playwright/test";
import { openMap, reportViaApi, watchTraffic } from "./helpers.js";
import { instanceUrl } from "./instances.js";

/** Zoom level as drawn: the tile level of a loaded tile plus how much the tile is scaled on screen (measured at rest). */
async function drawnZoom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const tile = document.querySelector<HTMLImageElement>("img.leaflet-tile-loaded");
    if (!tile) return Number.NaN;
    const level = Number(new URL(tile.src).pathname.split("/")[1]);
    return level + Math.log2(tile.getBoundingClientRect().width / 256);
  });
}

test.describe("loading", () => {
  const node = instanceUrl("notiles");

  test("the page talks to nobody but this node when no tile server is configured", async ({ page }) => {
    const origins = new Set<string>();
    page.on("request", (request) => origins.add(new URL(request.url()).origin));
    await page.goto(`${node}/`);
    await expect(page.locator("#live-chip.ok")).toBeVisible();
    await page.goto(`${node}/about`);
    await expect(page.locator("main")).toContainText("Diese Seite lädt keine Karten von Drittanbietern.");
    expect([...origins]).toEqual([node]);
  });

  test("reads the config once (the preload is used), and a repeat visit takes the app's files from the browser cache", async ({ page }) => {
    const configRequests: string[] = [];
    const warnings: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/web-config.json")) configRequests.push(request.url());
    });
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });

    await page.goto(`${node}/`);
    await expect(page.locator("#live-chip.ok")).toBeVisible();
    await page.waitForTimeout(1500); // the browser warns about an unused preload a few seconds after load
    expect(configRequests).toHaveLength(1);
    expect(warnings.filter((text) => /preload/i.test(text))).toEqual([]);

    await page.goto(`${node}/`);
    await expect(page.locator("#live-chip.ok")).toBeVisible();
    const files = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry as PerformanceResourceTiming)
        .filter((entry) => entry.name.includes("/web/") && entry.name.includes("?v="))
        .map((entry) => ({ name: entry.name, transferred: entry.transferSize })),
    );
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((file) => file.transferred > 0).map((file) => file.name)).toEqual([]);
  });

  test("the map exists before the node's settings have arrived (it only needs the web config)", async ({ page }) => {
    // Hold back the settings and the first reports: the map, its controls and the report button must already be there.
    await page.route("**/v1/config", () => new Promise(() => undefined));
    await page.route("**/v1/hazard-reports/nearby**", () => new Promise(() => undefined));
    await page.goto(`${node}/`);
    await expect(page.locator("#map.leaflet-container")).toBeVisible();
    await expect(page.locator(".leaflet-control-zoom-in")).toBeVisible();
    await expect(page.locator("#report-open")).toBeEnabled();
  });
});

test.describe("zooming and panning", () => {
  const node = instanceUrl("main");

  test("one wheel notch zooms by a moderate amount (on Linux it used to jump two whole levels)", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await expect.poll(() => drawnZoom(page)).not.toBeNaN();
    await page.waitForTimeout(600);
    const before = await drawnZoom(page);

    const box = (await page.locator("#map").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(1200);
    const after = await drawnZoom(page);

    // Leaflet halves Chrome-on-Windows wheel deltas: about 0.7 levels there, about 1.3 elsewhere — never the 2 of the old setup
    expect(after - before).toBeGreaterThan(0.4);
    expect(after - before).toBeLessThan(1.6);
  });

  test("zooming stays continuous: the map does not snap to whole levels", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await expect.poll(() => drawnZoom(page)).not.toBeNaN();
    await page.waitForTimeout(600);
    const box = (await page.locator("#map").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -20);
    await page.waitForTimeout(1000);
    const first = await drawnZoom(page);
    await page.mouse.wheel(0, -20);
    await page.waitForTimeout(1000);
    const second = await drawnZoom(page);
    const step = second - first;
    // a small gesture moves the map a small amount (Leaflet's defaults would round every step up to a whole level)
    expect(step).toBeGreaterThan(0.05);
    expect(step).toBeLessThan(0.5);
  });

  test("the speed-limit layer reuses what it has drawn when the visitor zooms in, instead of loading again", async ({ page }) => {
    await watchTraffic(page, node);
    const segmentRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/v1/speed-limit-segments/nearby")) segmentRequests.push(request.url());
    });
    await openMap(page, node);
    await page.locator("#layer-limits").check();
    for (let i = 0; i < 4 && !/Straßenabschnitt/.test(await page.locator("#limits-hint").innerText()); i += 1) {
      await page.locator(".leaflet-control-zoom-in").click();
      await page.waitForTimeout(900);
    }
    await expect(page.locator("#limits-hint")).toContainText(/\d+ Straßenabschnitte? im Ausschnitt/);
    const loads = segmentRequests.length;
    expect(loads).toBeGreaterThan(0);

    await page.locator(".leaflet-control-zoom-in").click();
    await page.waitForTimeout(1200);
    expect(segmentRequests).toHaveLength(loads);
    await expect(page.locator("#limits-hint")).toContainText(/\d+ Straßenabschnitte? im Ausschnitt/);
  });

  test("the speed-limit layer says that roads without a recorded limit stay uncoloured", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await expect(page.locator("#limits-note")).toBeHidden();
    await page.locator("#layer-limits").check();
    await expect(page.locator("#limits-note")).toContainText("Straßen ohne Farbe haben keinen Eintrag");
    for (let i = 0; i < 4 && (await page.locator(".legend").count()) === 0; i += 1) await page.waitForTimeout(300);
    await expect(page.locator(".legend")).toContainText("kein Limit erfasst");
    await page.locator("#layer-limits").uncheck();
    await expect(page.locator("#limits-note")).toBeHidden();
  });

  test("the map does not change size while the report list changes (that made it jump on phones)", async ({ browser, request }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "de-DE" });
    const page = await context.newPage();
    await watchTraffic(page, node);
    await openMap(page, node);
    const size = async () => (await page.locator("#map-panel").boundingBox())!.height;
    const before = await size();
    // fill the list with reports: the side panel scrolls, the map keeps its height
    for (const [type, dLat] of [["traffic", 0.0011], ["ice", 0.0012], ["obstacle", 0.0013]] as const) {
      await reportViaApi(request, node, { type, lat: 48.1375 + dLat, lng: 11.5755 });
    }
    await page.reload();
    await expect(page.locator("#live-chip.ok")).toBeVisible();
    await expect(page.locator("#report-list li").first()).toBeVisible();
    expect(await size()).toBe(before);
    await context.close();
  });
});
