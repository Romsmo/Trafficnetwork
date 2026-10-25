import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { openMap, watchTraffic } from "./helpers.js";
import { instanceUrl } from "./instances.js";
import { MAP_CENTER } from "./seed.js";

const node = instanceUrl("main");

/** The seeded 50 km/h street runs north-south through the middle of the map; it is the road these tests put signs on. */
async function seedSign(request: APIRequestContext, body: Record<string, unknown>): Promise<{ id: string }> {
  const session = await request.post(`${node}/v1/web/session`, { headers: { "sec-fetch-site": "same-origin" } });
  const headers = { authorization: `Bearer ${(await session.json()).accessToken as string}` };
  const resolved = await request.post(`${node}/v1/context-signs/resolve`, { headers, data: body });
  expect(resolved.ok(), await resolved.text()).toBe(true);
  const { descriptor, entryKey } = await resolved.json();
  const proposed = await request.post(`${node}/v1/context-signs`, { headers, data: { descriptor } });
  expect(proposed.ok(), await proposed.text()).toBe(true);
  return { id: entryKey as string };
}

const street = (south: number, north: number) => ({ from: { lat: south, lng: MAP_CENTER.lng }, to: { lat: north, lng: MAP_CENTER.lng } });

async function clearMarkers(page: Page): Promise<void> {
  await page.locator("#filters input[type=checkbox]").evaluateAll((boxes) =>
    boxes.forEach((box) => {
      (box as HTMLInputElement).checked = false;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }),
  );
}

test.describe("traffic signs on stretches (context signs)", () => {
  test("a node without any entry shows the layer switch, says so, and breaks nothing", async ({ page }) => {
    const traffic = await watchTraffic(page, node);
    await openMap(page, node);
    const layer = page.getByRole("checkbox", { name: "Verkehrszeichen auf Strecken zeigen" });
    await expect(layer).toBeVisible();
    await layer.check();
    await expect(page.locator("#signs-hint")).toContainText("noch kein Verkehrszeichen eingetragen");
    expect(traffic.external).toEqual([]);
    expect(await traffic.cspViolations()).toEqual([]);
    expect(traffic.consoleErrors).toEqual([]);
  });

  test("an entered sign appears on the map with its details, and a visitor can confirm it", async ({ page, request }) => {
    await seedSign(request, { signType: "DE:142-10", direction: "both", ...street(48.13, 48.133) });
    const traffic = await watchTraffic(page, node);
    await openMap(page, node);
    await clearMarkers(page);
    await page.getByRole("checkbox", { name: "Verkehrszeichen auf Strecken zeigen" }).check();
    await expect(page.locator("#signs-hint")).toContainText("Verkehrszeichen in diesem Ausschnitt");

    const marker = page.locator('.ctx-marker[title="Wildwechsel"]').first();
    await expect(marker).toBeVisible();
    // reachable by keyboard: it takes focus, and Enter opens the details
    await marker.focus();
    await page.keyboard.press("Enter");
    const popup = page.locator(".ctx-popup");
    await expect(popup).toContainText("Wildwechsel");
    await expect(popup).toContainText("immer");
    await expect(popup).toContainText("in beiden Richtungen");
    await expect(popup).toContainText("Noch nicht bestätigt");
    await expect(popup).toContainText("Hilfe, keine Verkehrsregelung");
    await popup.getByRole("button", { name: "Stimmt", exact: true }).click();
    await expect(popup).toContainText(/Danke|schon so abgestimmt/);
    expect(traffic.external).toEqual([]);
    expect(await traffic.cspViolations()).toEqual([]);
    expect(traffic.consoleErrors).toEqual([]);
  });

  test("a visitor enters a no-overtaking sign: choose, pick start and end, preview, send", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await clearMarkers(page);
    await page.locator("#sign-add").click();
    const dialog = page.locator("#sign-dialog");
    await expect(dialog.getByRole("heading", { name: "Verkehrszeichen eintragen" })).toBeVisible();

    await dialog.getByRole("searchbox", { name: /Zeichen suchen/ }).fill("276");
    await dialog.getByRole("radio", { name: /276 · Überholverbot für Kraftfahrzeuge aller Art/ }).check();
    const box = (await page.locator("#map").boundingBox())!;
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    await dialog.getByRole("button", { name: "Anfang antippen" }).click();
    await expect(page.locator("#pick-chip")).toContainText("Anfang der Strecke");
    await page.mouse.click(centre.x, centre.y + 40);
    await dialog.getByRole("button", { name: "Ende antippen" }).click();
    await expect(page.locator("#pick-chip")).toContainText("Ende der Strecke");
    await page.mouse.click(centre.x, centre.y - 60);

    await expect(dialog.getByText(/Anfang: \d/)).toBeVisible();
    await expect(dialog.getByText(/Ende: \d/)).toBeVisible();
    await dialog.getByRole("button", { name: "Prüfen und Vorschau" }).click();
    await expect(dialog.getByText(/Die Strecke ist \d+ m lang/)).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Neu eintragen" })).toBeChecked();
    await dialog.getByRole("button", { name: "Eintragen", exact: true }).click();
    await expect(dialog.getByText(/Eingetragen\. Es zählt als bestätigt/)).toBeVisible();
    await dialog.getByRole("button", { name: "Schließen" }).click();

    // the layer was switched on to show it
    await expect(page.getByRole("checkbox", { name: "Verkehrszeichen auf Strecken zeigen" })).toBeChecked();
    await expect(page.locator('.ctx-marker[title^="Überholverbot"]').first()).toBeVisible();
  });

  test("the form says what is missing and what the node refuses", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await clearMarkers(page);
    await page.locator("#sign-add").click();
    const dialog = page.locator("#sign-dialog");
    await dialog.getByRole("searchbox").fill("höhe");
    await dialog.getByRole("radio", { name: /265-3/ }).check();
    await dialog.getByRole("button", { name: "Prüfen und Vorschau" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Bitte wähle Anfang und Ende");
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    await expect(dialog).not.toBeVisible();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`the entry dialog has no accessibility violations (axe, ${scheme} mode)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await watchTraffic(page, node);
      await openMap(page, node);
      await page.locator("#sign-add").click();
      const dialog = page.locator("#sign-dialog");
      await dialog.getByRole("radio", { name: /142-10/ }).check();
      const results = await new AxeBuilder({ page }).include("#sign-dialog").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    });
  }

  test("the entry dialog fits a phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#layers-open").click(); // the sheet comes up
    await page.locator("#sign-add").scrollIntoViewIfNeeded();
    await page.locator("#sign-add").click();
    const dialog = page.locator("#sign-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: /142-10/ }).check();
    const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
