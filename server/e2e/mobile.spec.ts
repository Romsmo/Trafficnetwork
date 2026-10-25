import { expect, test, type Page } from "@playwright/test";
import { openMap, watchTraffic } from "./helpers.js";
import { instanceUrl } from "./instances.js";

const node = instanceUrl("main");

/** A fake `navigator.geolocation` the test drives: `window.__fix({ latitude, longitude, accuracy, heading, speed })` delivers one position. */
async function fakeGeolocation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let deliver: ((position: unknown) => void) | null = null;
    const api = {
      watchPosition(success: (position: unknown) => void) {
        deliver = success;
        return 7;
      },
      clearWatch() {
        deliver = null;
      },
      getCurrentPosition(success: (position: unknown) => void) {
        success({ coords: { latitude: 48.1375, longitude: 11.5755, accuracy: 30, heading: null, speed: null }, timestamp: Date.now() });
      },
    };
    Object.defineProperty(navigator, "geolocation", { value: api, configurable: true });
    (window as unknown as { __fix: (coords: Record<string, unknown>) => void }).__fix = (coords) => deliver?.({ coords, timestamp: Date.now() });
  });
}

const fix = (page: Page, coords: Record<string, unknown>) => page.evaluate((c) => (window as unknown as { __fix: (c: unknown) => void }).__fix(c), coords);

test.describe("phone: the map is the screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the map fills the screen, the controls float on it at the right edge and every touch target is at least 44 px", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await expect(page.locator("#sheet")).toHaveAttribute("data-mode", "sheet");

    const map = (await page.locator("#map").boundingBox())!;
    expect(map.width).toBe(390);
    expect(map.height).toBeGreaterThanOrEqual(600);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    for (const selector of ["#locate", "#layers-open", ".leaflet-control-zoom-in", ".leaflet-control-zoom-out", "#sheet-handle", "#report-open"]) {
      const box = (await page.locator(selector).first().boundingBox())!;
      expect(box.width, `${selector} width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(44);
    }
    // The floating buttons sit in the right part of the map, within a thumb's reach.
    for (const selector of ["#locate", "#layers-open"]) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.x + box.width, selector).toBeLessThanOrEqual(390);
      expect(box.x, selector).toBeGreaterThan(390 / 2);
    }
    // Names for the screen reader, not only icons.
    await expect(page.locator("#locate")).toHaveAccessibleName("Auf mich zentrieren");
    await expect(page.locator("#layers-open")).toHaveAccessibleName("Kategorien und Ebenen");
    await expect(page.locator(".leaflet-control-zoom-in")).toHaveAccessibleName("Vergrößern");
  });

  test("the bottom sheet rests at three heights: by tap, by keyboard and by dragging the handle", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    const sheet = page.locator("#sheet");
    const handle = page.locator("#sheet-handle");
    const body = page.locator("#sheet-body");
    const height = async () => (await sheet.boundingBox())!.height;

    await expect(sheet).toHaveAttribute("data-detent", "small");
    // Closed, the content below the header is not reachable (neither by Tab nor by a screen reader).
    expect(await body.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
    await expect(handle).toHaveAttribute("aria-expanded", "false");
    const small = await height();

    await handle.click();
    await expect(sheet).toHaveAttribute("data-detent", "half");
    expect(await body.evaluate((element) => (element as HTMLElement).inert)).toBe(false);
    await expect(handle).toHaveAttribute("aria-expanded", "true");
    // (the sheet's height eases to its new resting place)
    await expect.poll(height).toBeGreaterThan(small + 100);
    const half = await height();

    await handle.click();
    await expect(sheet).toHaveAttribute("data-detent", "full");
    await expect.poll(height).toBeGreaterThan(half + 50);

    // Keyboard: arrows step, Home/End jump, Escape collapses and keeps the focus on the handle.
    await handle.focus();
    await page.keyboard.press("ArrowDown");
    await expect(sheet).toHaveAttribute("data-detent", "half");
    await page.keyboard.press("ArrowUp");
    await expect(sheet).toHaveAttribute("data-detent", "full");
    await page.keyboard.press("Home");
    await expect(sheet).toHaveAttribute("data-detent", "small");
    await page.keyboard.press("End");
    await expect(sheet).toHaveAttribute("data-detent", "full");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveAttribute("data-detent", "small");
    await expect(handle).toBeFocused();

    // The handle's name says where the sheet is.
    await expect(handle).toHaveAccessibleName(/Detailfenster, klein/);

    // Dragging the handle upwards settles at a higher resting place (first let the sheet finish easing down).
    await expect.poll(height).toBeLessThan(small + 2);
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 160, { steps: 8 });
    await page.mouse.move(x, y - 320, { steps: 8 });
    await page.mouse.up();
    await expect(sheet).not.toHaveAttribute("data-detent", "small");
  });

  test("a tapped road is shown in the sheet, with a way back to the overview", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    // Hide the hazard markers other tests left in the middle of the map (the filters sit in the closed sheet: set them directly).
    await page.locator("#filters input[type=checkbox]").evaluateAll((boxes) =>
      boxes.forEach((box) => {
        (box as HTMLInputElement).checked = false;
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }),
    );
    await page.locator("#map").click(); // the middle of the map is the seeded 50 km/h street
    await expect(page.locator("#sheet")).not.toHaveAttribute("data-detent", "small");
    await expect(page.locator("#sheet-detail")).toBeVisible();
    await expect(page.locator("#detail-content")).toContainText("Tempolimit hier: 50 km/h");
    await expect(page.locator("#detail-content")).toContainText("Herkunft: aus den Kartendaten dieses Knotens (importiert).");
    await expect(page.locator("#detail-content").getByRole("button", { name: "Stimmt nicht?" })).toBeVisible();
    await page.locator("#detail-back").click();
    await expect(page.locator("#sheet-browse")).toBeVisible();
    await expect(page.locator("#sheet-detail")).toBeHidden();
  });

  test("a stretch of road: the sheet makes room while the end is tapped, then comes back with the road drawn grey", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#filters input[type=checkbox]").evaluateAll((boxes) =>
      boxes.forEach((box) => {
        (box as HTMLInputElement).checked = false;
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }),
    );
    await page.route("**/v1/roads/resolve", (route) => {
      const body = route.request().postDataJSON() as { from: { lat: number; lng: number }; to: { lat: number; lng: number } };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ref: "ivl:1,1:2,2",
          segmentKey: "k".repeat(32),
          geometry: { type: "LineString", coordinates: [[body.from.lng, body.from.lat], [body.to.lng, body.to.lat]] },
          lengthM: 260,
          road: { name: "Teststraße", ref: null, class: "residential" },
          covered: [{ segmentId: "s", segmentKey: "k", speedLimit: 50, unit: "kmh", source: "seed", coveredMeters: 255 }],
          proposals: [],
        }),
      });
    });
    await page.locator("#map").click();
    const detail = page.locator("#detail-content");
    await detail.getByRole("button", { name: "Tempolimit für ein Stück ändern" }).click();
    await expect(detail.getByRole("heading", { name: "Tempolimit für ein Stück Straße" })).toBeVisible();
    await detail.getByRole("button", { name: "Ende auf der Karte wählen" }).click();
    // the sheet rests at its small height while the end is picked, and the chip says what to tap
    await expect(page.locator("#sheet")).toHaveAttribute("data-detent", "small");
    await expect(page.locator("#pick-chip")).toContainText("Tippe auf der Karte das Ende des Stücks an.");
    const box = (await page.locator("#map").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2 + 90, box.y + box.height / 2 - 60);
    await expect(page.locator("#sheet")).not.toHaveAttribute("data-detent", "small");
    await expect(detail).toContainText("Gefunden: Teststraße, etwa 260 m.");
    await expect(detail).toContainText("50 km/h auf 255 m");
    await expect(page.locator("path.interval-preview")).toHaveCount(1);
  });
});

test.describe("the location arrow", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("points where the visitor is heading, with an accuracy circle, and the button has three states", async ({ page }) => {
    await fakeGeolocation(page);
    await watchTraffic(page, node);
    await openMap(page, node);
    const button = page.locator("#locate");
    await expect(button).toHaveAttribute("data-state", "off");
    await expect(page.locator(".me-arrow")).toHaveCount(0);

    await button.click();
    await expect(button).toHaveAttribute("data-state", "centered");
    await fix(page, { latitude: 48.1375, longitude: 11.5755, accuracy: 25, heading: 90, speed: 9 });
    const arrow = page.locator(".me-arrow");
    await expect(arrow).toHaveCount(1);
    await expect(arrow).toHaveAttribute("data-heading", "90");
    await expect(arrow).toHaveCSS("transform", /matrix\(0, 1, -1, 0/); // rotated 90 degrees
    await expect(arrow).toHaveAttribute("aria-label", "Dein Standort, Blickrichtung O, auf etwa 25 m genau");
    await expect(page.locator("path.me-accuracy")).toHaveCount(1);
    await expect(page.locator(".me-arrow .me-head")).toBeVisible();

    // Moving on with a new direction turns it (smoothly: it does not jump the long way round).
    for (let i = 0; i < 6; i += 1) await fix(page, { latitude: 48.1376, longitude: 11.5756, accuracy: 20, heading: 180, speed: 9 });
    const turned = Number(await arrow.getAttribute("data-heading"));
    expect(turned).toBeGreaterThan(170);
    expect(turned).toBeLessThanOrEqual(180);
    await expect(arrow).toHaveAttribute("aria-label", /Blickrichtung S,/);

    await button.click();
    await expect(button).toHaveAttribute("data-state", "following");
    await expect(page.locator("#map-status")).toContainText("folgt deinem Standort");
    await button.click();
    await expect(button).toHaveAttribute("data-state", "off");
    await expect(page.locator(".me-arrow")).toHaveCount(0);
  });

  test("shows a plain dot, not an arrow, while no direction is known", async ({ page }) => {
    await fakeGeolocation(page);
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#locate").click();
    await fix(page, { latitude: 48.1375, longitude: 11.5755, accuracy: 40, heading: null, speed: null });
    const arrow = page.locator(".me-arrow");
    await expect(arrow).toHaveClass(/no-heading/);
    await expect(arrow).toHaveAttribute("aria-label", "Dein Standort, auf etwa 40 m genau");
    await expect(page.locator(".me-arrow .me-head")).toBeHidden();
  });

  test("the arrow is outlined so it reads on light and dark maps", async ({ page }) => {
    await fakeGeolocation(page);
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#locate").click();
    await fix(page, { latitude: 48.1375, longitude: 11.5755, accuracy: 20, heading: 45, speed: 5 });
    const head = page.locator(".me-arrow .me-head");
    await expect(head).toBeVisible();
    const stroke = await head.evaluate((element) => getComputedStyle(element).stroke);
    const fill = await head.evaluate((element) => getComputedStyle(element).fill);
    expect(stroke).not.toBe("none");
    expect(stroke).not.toBe(fill);
  });
});

test.describe("the road-colour text", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("says exactly what the operator asked for, in German and in English", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#sheet-handle").click();
    // Zoom out so the hint is the "zoom in" one whatever the node's region is.
    for (let i = 0; i < 6; i += 1) await page.locator(".leaflet-control-zoom-out").click();
    await expect(page.locator("label.layer-toggle", { has: page.locator("#layer-limits") })).toHaveText("Tempolimits als Straßenfarben zeigen");
    await page.locator("#layer-limits").check();
    // The level is the one this screen needs to stay inside the node's area limit (14 at the least; a bigger screen needs more).
    await expect(page.locator("#limits-hint")).toHaveText(/^Näher heranzoomen \(ab Stufe 1[4-9]\), um Tempolimits als Farben zu sehen\.$/);
    await expect(page.locator("#limits-note")).toHaveText(
      "Eingefärbt sind nur Straßen, für die ein Tempolimit erfasst ist. Straßen ohne Farbe haben keinen Eintrag – dort gilt die allgemeine gesetzliche Regelung",
    );
    expect(await page.locator("body").innerText()).not.toMatch(/maxspeed/i);
    // The map's own credit stays.
    await expect(page.locator(".leaflet-control-attribution")).toContainText("OpenStreetMap");
  });

  test("English version carries the same meaning", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("tn-lang", "en"));
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#sheet-handle").click();
    for (let i = 0; i < 6; i += 1) await page.locator(".leaflet-control-zoom-out").click();
    await page.locator("#layer-limits").check();
    await expect(page.locator("label.layer-toggle", { has: page.locator("#layer-limits") })).toHaveText("Show speed limits as road colours");
    await expect(page.locator("#limits-hint")).toHaveText(/^Zoom in closer \(from level 1[4-9]\) to see speed limits as colours\.$/);
    await expect(page.locator("#limits-note")).toHaveText("Only roads with a recorded speed limit are coloured. Roads without a colour have no entry – the general legal rule applies there");
    expect(await page.locator("body").innerText()).not.toMatch(/maxspeed/i);
  });
});
