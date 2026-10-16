import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openMap, watchTraffic } from "./helpers.js";
import { instanceUrl } from "./instances.js";

const node = instanceUrl("main");

const POSTAU = { id: "r4711", name: "Postau", label: "Postau, Landkreis Landshut, Bayern, Deutschland", lat: 48.5961, lng: 12.1923, kind: "administrative", bbox: [12.15, 48.55, 12.25, 48.64] };
const BAHNHOF = { id: "n9", name: "Postau Bahnhof", label: "Postau Bahnhof, Postau, Bayern, Deutschland", lat: 48.6, lng: 12.2, kind: "station", bbox: null };

/** The node's place search is answered here: the e2e nodes ask nobody (their PLACE_SEARCH_URL is a closed local port). */
async function answerWith(page: Page, places: unknown[], status = 200): Promise<{ urls: string[] }> {
  const seen = { urls: [] as string[] };
  await page.route("**/v1/places/search**", (route) => {
    seen.urls.push(route.request().url());
    return route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(status === 200 ? { places } : { error: { code: "PLACE_SEARCH_UNAVAILABLE", message: "down" } }),
    });
  });
  return seen;
}

test.describe("place search on the map", () => {
  test("a search bar like a navigation app has: type, press Enter, pick a hit - the map goes there and marks it", async ({ page }) => {
    const traffic = await watchTraffic(page, node);
    const seen = await answerWith(page, [POSTAU, BAHNHOF]);
    await openMap(page, node);

    const input = page.getByRole("searchbox", { name: "Ort suchen" });
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute("placeholder", "Ort oder Adresse suchen");
    await input.fill("Postau");
    // nothing is asked while typing
    expect(seen.urls).toHaveLength(0);
    await input.press("Enter");

    const results = page.locator("[data-place-results] button");
    await expect(results).toHaveCount(2);
    await expect(page.locator("[data-place-status]")).toHaveText("2 Treffer – bitte einen auswählen");
    await expect(results.first()).toContainText("Postau");
    await expect(results.first()).toContainText("Landkreis Landshut, Bayern, Deutschland");
    // the node is asked with the term, the language and the rounded centre of the map - never more
    const asked = new URL(seen.urls[0]!);
    expect(asked.pathname).toBe("/v1/places/search");
    expect(asked.searchParams.get("q")).toBe("Postau");
    expect(asked.searchParams.get("lang")).toBe("de");
    expect(asked.searchParams.get("lat")).toMatch(/^-?\d+\.\d$/);
    expect(asked.searchParams.get("lng")).toMatch(/^-?\d+\.\d$/);

    await results.first().click();
    await expect(page.locator("[data-place-panel]")).toBeHidden();
    await expect(input).toHaveValue("Postau");
    await expect(page.locator(".place-pin")).toHaveCount(1);
    await expect(page.locator(".place-label")).toHaveText("Postau");
    await expect(page.locator("#map-status")).toHaveText("Die Karte zeigt: Postau");
    // the page itself only ever talked to its node (and the tile server)
    expect(traffic.external).toEqual([]);
    expect(await traffic.cspViolations()).toEqual([]);
  });

  test("the keyboard does it all: Enter searches, the arrow keys walk the hits, Enter chooses, Escape puts the list away", async ({ page }) => {
    await watchTraffic(page, node);
    await answerWith(page, [POSTAU, BAHNHOF]);
    await openMap(page, node);
    const input = page.getByRole("searchbox", { name: "Ort suchen" });
    await input.fill("Postau");
    await input.press("Enter");
    await expect(page.locator("[data-place-results] button")).toHaveCount(2);

    await input.press("ArrowDown");
    await expect(page.locator("[data-place-results] button").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("[data-place-results] button").nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(input).toBeFocused();

    await input.press("Escape");
    await expect(page.locator("[data-place-panel]")).toBeHidden();
    await expect(page.locator(".place-pin")).toHaveCount(0);

    await input.press("Enter");
    await expect(page.locator("[data-place-results] button")).toHaveCount(2);
    await input.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter"); // a button: Enter presses it
    await expect(input).toHaveValue("Postau Bahnhof");
    await expect(page.locator(".place-pin")).toHaveCount(1);
  });

  test("says in words when there is nothing, when the term is too short, and when the service is down", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    const input = page.getByRole("searchbox", { name: "Ort suchen" });
    const status = page.locator("[data-place-status]");

    await input.fill("a");
    await input.press("Enter");
    await expect(status).toHaveText("Bitte mindestens 2 Zeichen eingeben.");

    await answerWith(page, []);
    await input.fill("Nirgendwo");
    await input.press("Enter");
    await expect(status).toContainText("Nichts gefunden.");
    await expect(page.locator("[data-place-results] button")).toHaveCount(0);

    await page.unroute("**/v1/places/search**");
    await answerWith(page, [], 502);
    await input.fill("Postau");
    await input.press("Enter");
    await expect(status).toContainText("Die Ortssuche ist gerade nicht erreichbar.");

    await page.unroute("**/v1/places/search**");
    await answerWith(page, [], 429);
    await input.press("Enter");
    await expect(status).toContainText("Zu viele Suchanfragen.");
  });

  test("the clear button empties the box and takes the pin away; the text follows the language", async ({ page }) => {
    await watchTraffic(page, node);
    await answerWith(page, [POSTAU]);
    await openMap(page, node);
    const input = page.getByRole("searchbox", { name: "Ort suchen" });
    const clear = page.getByRole("button", { name: "Suche leeren" });
    await expect(clear).toBeHidden();
    await input.fill("Postau");
    await expect(clear).toBeVisible();
    await input.press("Enter");
    await page.locator("[data-place-results] button").first().click();
    await expect(page.locator(".place-pin")).toHaveCount(1);
    await clear.click();
    await expect(input).toHaveValue("");
    await expect(page.locator(".place-pin")).toHaveCount(0);
    await expect(input).toBeFocused();

    await page.getByRole("button", { name: /English/ }).click();
    await expect(page.getByRole("searchbox", { name: "Search for a place" })).toHaveAttribute("placeholder", "Search for a place or address");
  });

  test("a tap on the map puts the list away and leaves the text alone", async ({ page }) => {
    await watchTraffic(page, node);
    await answerWith(page, [POSTAU, BAHNHOF]);
    await openMap(page, node);
    const input = page.getByRole("searchbox", { name: "Ort suchen" });
    await input.fill("Postau");
    await input.press("Enter");
    await expect(page.locator("[data-place-results] button")).toHaveCount(2);
    const box = (await page.locator("#map").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height - 60);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator("[data-place-panel]")).toBeHidden();
    await expect(input).toHaveValue("Postau");
  });

  test("a node without a place service shows no search bar", async ({ page }) => {
    await watchTraffic(page, instanceUrl("notiles"));
    await page.goto(`${instanceUrl("notiles")}/`);
    await expect(page.locator("#map")).toBeVisible();
    await expect(page.locator("#place-search")).toBeHidden();
    await expect(page.getByRole("searchbox")).toHaveCount(0);
  });

  test("no accessibility violations with the list open (light and dark)", async ({ page }) => {
    await watchTraffic(page, node);
    await answerWith(page, [POSTAU, BAHNHOF]);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openMap(page, node);
      const input = page.getByRole("searchbox", { name: "Ort suchen" });
      await input.fill("Postau");
      await input.press("Enter");
      await expect(page.locator("[data-place-results] button")).toHaveCount(2);
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), scheme).toEqual([]);
    }
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("the bar and the list fit the screen, and choosing a hit marks it on the map", async ({ page }) => {
      await watchTraffic(page, node);
      await answerWith(page, [POSTAU, BAHNHOF]);
      await openMap(page, node);
      const input = page.getByRole("searchbox", { name: "Ort suchen" });
      const bar = (await page.locator("#place-search").boundingBox())!;
      expect(bar.x).toBeGreaterThanOrEqual(0);
      expect(bar.x + bar.width).toBeLessThanOrEqual(390 - 60); // the round controls keep their place at the right edge
      expect(bar.height).toBeGreaterThanOrEqual(44);
      await input.fill("Postau");
      await input.press("Enter");
      const panel = (await page.locator("[data-place-panel]").boundingBox())!;
      expect(panel.x).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width).toBeLessThanOrEqual(390);
      await page.locator("[data-place-results] button").first().tap();
      await expect(page.locator(".place-pin")).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
});
