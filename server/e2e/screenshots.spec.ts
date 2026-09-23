import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { openMap, reportViaApi, watchTraffic } from "./helpers.js";
import { instanceUrl } from "./instances.js";
import { nearCenter } from "./seed.js";

/**
 * Regenerates the images shown in docs/web-ui.md (and the pull request): `npm run e2e:screenshots`.
 * Unlike the e2e suite this one uses the real tile server (OpenStreetMap) so the pictures show a real map;
 * it therefore needs internet access and is not part of CI.
 */
const node = instanceUrl("main");
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "web-ui");
const photo = (name: string) => ({ path: path.join(outDir, `${name}.jpg`), type: "jpeg" as const, quality: 82 }); // maps compress far better as JPEG
const shot = (name: string) => ({ path: path.join(outDir, `${name}.png`) });

async function tilesLoaded(page: Page): Promise<void> {
  await expect(page.locator("img.leaflet-tile-loaded").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".leaflet-tile-loading")).toHaveCount(0, { timeout: 20_000 });
  await page.waitForTimeout(400);
}

test.beforeAll(async ({ request }) => {
  const spots: Array<[string, number, number]> = [
    ["traffic", 0.004, -0.006],
    ["accident", -0.003, 0.004],
    ["ice", 0.008, 0.002],
    ["construction", -0.007, -0.004],
    ["breakdown", 0.001, 0.009],
    ["obstacle", -0.001, -0.01],
  ];
  for (const [type, dLat, dLng] of spots) await reportViaApi(request, node, { type, ...nearCenter(dLat, dLng) });
});

test.use({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });

test("map with reports and a popup", async ({ page }) => {
  await watchTraffic(page, node, { fakeTiles: false });
  await openMap(page, node);
  await expect(page.locator(".hz-icon")).toHaveCount(6);
  await tilesLoaded(page);
  await page.locator(".hz-icon.type-accident").click();
  await expect(page.locator(".leaflet-popup-content")).toContainText("Unfall");
  await page.waitForTimeout(500);
  await page.screenshot(photo("map-desktop"));
});

test("map, dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await watchTraffic(page, node, { fakeTiles: false });
  await openMap(page, node);
  await expect(page.locator(".hz-icon")).toHaveCount(6);
  await tilesLoaded(page);
  await page.screenshot(photo("map-dark"));
});

test("speed limit on click and the speed-limit layer", async ({ page }) => {
  await watchTraffic(page, node, { fakeTiles: false });
  await openMap(page, node);
  await page.locator("#layer-limits").check();
  // Zoom in until the view is small enough for the layer (the node only serves small radii).
  for (let i = 0; i < 4 && !/Straßenabschnitt/.test(await page.locator("#limits-hint").innerText()); i += 1) {
    await page.locator(".leaflet-control-zoom-in").click();
    await page.waitForTimeout(900);
  }
  await expect(page.locator("#limits-hint")).toContainText(/Straßenabschnitt/);
  await tilesLoaded(page);
  for (const box of await page.locator("#filters input[type=checkbox]").all()) await box.uncheck();
  const box = (await page.locator("#map").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".leaflet-popup-content")).toContainText("Tempolimit hier");
  await page.waitForTimeout(500);
  await page.screenshot(photo("map-speed-limits"));
});

test("report dialog", async ({ page }) => {
  await watchTraffic(page, node, { fakeTiles: false });
  await openMap(page, node);
  await tilesLoaded(page);
  await page.locator("#report-open").click();
  await page.locator("#report-dialog").getByRole("radio", { name: "Stau", exact: true }).check();
  await page.waitForTimeout(300);
  await page.screenshot(photo("report-dialog"));
});

test("connect page", async ({ page }) => {
  await watchTraffic(page, node);
  await page.goto(`${node}/connect`);
  await expect(page.locator("main")).toContainText("Knoten-ID");
  await page.screenshot({ ...shot("connect"), fullPage: true });
});

test("about page", async ({ page }) => {
  await watchTraffic(page, node);
  await page.goto(`${node}/about`);
  await expect(page.locator("main .repo-cta a")).toBeVisible();
  await page.screenshot({ ...shot("about"), fullPage: true });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test("map on a phone", async ({ page }) => {
    await watchTraffic(page, node, { fakeTiles: false });
    await openMap(page, node);
    await tilesLoaded(page);
    await page.screenshot(photo("map-mobile"));
  });
});
