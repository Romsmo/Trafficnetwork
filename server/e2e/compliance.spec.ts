import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openMap, watchTraffic } from "./helpers.js";
import { instanceUrl } from "./instances.js";

/**
 * What docs/web-compliance.md claims, as tests: the footer on every page, legal pages that say only true things and show the
 * operator's own details, nobody but the node (and the tile server) is ever contacted, nothing is stored beyond the three
 * documented keys, WCAG 2.2 AA by axe in light and dark mode on every page and on the new states, keyboard-only use, reflow.
 */
const node = instanceUrl("main");
const PAGES = ["/", "/connect", "/about", "/privacy", "/terms", "/imprint"] as const;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function audit(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

test.describe("footer on every page", () => {
  for (const path of PAGES) {
    test(`${path}: privacy, terms, imprint, GitHub and license are linked`, async ({ page }) => {
      await watchTraffic(page, node);
      await page.goto(`${node}${path}`);
      const footer = page.locator("#site-footer");
      await expect(footer.getByRole("link", { name: "Datenschutz", exact: true })).toHaveAttribute("href", "/privacy");
      await expect(footer.getByRole("link", { name: "Nutzungsbedingungen" })).toHaveAttribute("href", "/terms");
      await expect(footer.getByRole("link", { name: "Impressum" })).toHaveAttribute("href", "/imprint");
      await expect(footer.getByRole("link", { name: "GitHub-Projekt" })).toBeVisible();
      await expect(footer.getByRole("link", { name: "Apache-2.0-Lizenz" })).toBeVisible();
    });
  }
});

test.describe("legal pages", () => {
  test("the imprint shows exactly the operator's configured details", async ({ page }) => {
    await watchTraffic(page, node);
    await page.goto(`${node}/imprint`);
    const main = page.locator("main .lang-block[lang=de]");
    await expect(main.getByRole("heading", { name: "Impressum" })).toBeVisible();
    await expect(main).toContainText("Beispiel-Betreiber (Testdaten)");
    await expect(main).toContainText("Teststraße 1, 12345 Teststadt, Deutschland");
    await expect(main.getByRole("link", { name: "betreiber@example.org" })).toHaveAttribute("href", "mailto:betreiber@example.org");
    await expect(main).toContainText("+49 30 0000000");
    // Nothing that the operator did not give: no register, no VAT id, no representative.
    await expect(main.getByRole("heading", { name: "Umsatzsteuer-Identifikationsnummer" })).toHaveCount(0);
    await expect(main.getByRole("heading", { name: "Register" })).toHaveCount(0);
    await expect(main.getByRole("heading", { name: "Angaben des Betreibers fehlen" })).toHaveCount(0);
  });

  test("a node whose operator has not entered anything says so instead of inventing a provider", async ({ page }) => {
    const bare = instanceUrl("limited");
    await watchTraffic(page, bare);
    await page.goto(`${bare}/imprint`);
    const main = page.locator("main .lang-block[lang=de]");
    await expect(main).toContainText("Angaben des Betreibers fehlen");
    await expect(main).not.toContainText("example.org");
    await page.goto(`${bare}/privacy`);
    await expect(page.locator("main .lang-block[lang=de]")).toContainText("noch nicht hinterlegt");
  });

  test("only the page's own language is shown, and the privacy notice names this node's real facts", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("tn-lang", "en"));
    await watchTraffic(page, node);
    await page.goto(`${node}/privacy`);
    const english = page.locator("main .lang-block[lang=en]");
    await expect(english.getByRole("heading", { name: "Privacy notice", level: 1 })).toBeVisible();
    await expect(page.locator("main .lang-block[lang=de]")).toBeHidden();
    await expect(english).toContainText("no cookies");
    await expect(english).toContainText("tile.openstreetmap.org"); // the tile host of this node
    await expect(english).toContainText("about 15 minutes"); // WEB_SESSION_TTL_SECONDS=900
    await expect(english).toContainText("neither the query string nor your IP address"); // LOG_PRIVACY_MODE on
    await expect(english).toContainText("3 days");
    // this node's e2e setup has the road lookup off: it says it asks nobody for road data
    await expect(english).toContainText("asks no service for road data");
    await expect(english.locator("[data-fill]").first()).not.toBeEmpty();
  });

  test("a node without a tile server says that nobody else is contacted", async ({ page }) => {
    const none = instanceUrl("notiles");
    await watchTraffic(page, none);
    await page.goto(`${none}/privacy`);
    await expect(page.locator("main .lang-block[lang=de]")).toContainText("keinen Kartenhintergrund");
    await expect(page.locator("main .lang-block[lang=de]")).not.toContainText("tile.openstreetmap.org");
    // this one has a road service: the notice names it, says the node (not the browser) asks, and what it receives
    const german = page.locator("main .lang-block[lang=de]");
    await expect(german).toContainText("127.0.0.1:9");
    await expect(german).toContainText("fragt der Knoten selbst");
    await expect(german).toContainText("nicht deine IP-Adresse");
  });

  test("the terms say what the draft status is and do not promise anything the service does not do", async ({ page }) => {
    await watchTraffic(page, node);
    await page.goto(`${node}/terms`);
    const main = page.locator("main .lang-block[lang=de]");
    await expect(main).toContainText("Entwurf");
    await expect(main).toContainText("nicht rechtlich geprüft");
    await expect(main).toContainText("keine Rückerstattung");
    await expect(main.getByRole("link", { name: "Datenschutzhinweisen" })).toHaveAttribute("href", "/privacy");
  });

  test("the report form tells what is sent before it is sent, and links the privacy notice", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#report-open").click();
    const dialog = page.locator("#report-dialog");
    await expect(dialog).toContainText("Gesendet werden: die gewählte Stelle");
    await expect(dialog).toContainText("zufällige, anonyme Sitzungskennung");
    await expect(dialog.getByRole("link", { name: "Datenschutzhinweise" })).toHaveAttribute("href", "/privacy");
  });
});

test.describe("nobody but the node is contacted, and almost nothing is stored", () => {
  for (const path of PAGES) {
    test(`${path}: no external request except map tiles, no CSP violation, no console error`, async ({ page }) => {
      const traffic = await watchTraffic(page, node);
      await page.goto(`${node}${path}`);
      await expect(page.locator("#site-footer a").first()).toBeVisible();
      if (path === "/") await expect(page.locator("#map.leaflet-container")).toBeVisible();
      expect(traffic.external).toEqual([]);
      expect(await traffic.cspViolations()).toEqual([]);
      expect(traffic.consoleErrors).toEqual([]);
    });
  }

  test("storage inventory: no cookie, no sessionStorage, no IndexedDB, and in localStorage only the three documented keys", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    // Use everything that remembers something: the language, a filter, the report dialog, the road colours.
    await page.getByRole("button", { name: "English" }).click();
    const filter = page.locator("#filters input[type=checkbox]").first();
    await filter.evaluate((box) => {
      (box as HTMLInputElement).checked = !(box as HTMLInputElement).checked;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.locator("#layer-limits").check();
    await page.locator("#report-open").click();
    await page.locator("#report-dialog").getByRole("button", { name: "Cancel" }).click();

    const inventory = await page.evaluate(async () => ({
      cookie: document.cookie,
      local: Object.keys(localStorage).sort(),
      session: Object.keys(sessionStorage),
      databases: typeof indexedDB.databases === "function" ? (await indexedDB.databases()).map((d) => d.name) : [],
      caches: "caches" in window ? await caches.keys() : [],
    }));
    expect(inventory.cookie).toBe("");
    expect(inventory.session).toEqual([]);
    expect(inventory.databases).toEqual([]);
    expect(inventory.caches).toEqual([]);
    for (const key of inventory.local) expect(["tn-lang", "tn.filters.v1", "tn.cameraNotice.v1"]).toContain(key);
    expect(inventory.local).toContain("tn-lang");
    // And no Set-Cookie header ever came from the node.
    const response = await page.request.get(`${node}/`);
    expect(response.headers()["set-cookie"]).toBeUndefined();
  });
});

test.describe("accessibility (WCAG 2.2 AA, axe) on every page and on the new states", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const path of PAGES) {
      test(`${path}, ${scheme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await watchTraffic(page, node);
        await page.goto(`${node}${path}`);
        await expect(page.locator("#site-footer a").first()).toBeVisible();
        if (path === "/") await expect(page.locator("#map.leaflet-container")).toBeVisible();
        expect(await audit(page)).toEqual([]);
      });
    }
  }

  test("the report dialog with an own duration and its error", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#report-open").click();
    const dialog = page.locator("#report-dialog");
    await dialog.getByRole("radio", { name: "Panne", exact: true }).check();
    await dialog.getByRole("radio", { name: "Eigene Dauer" }).check();
    await dialog.getByRole("textbox", { name: "Dauer" }).fill("99");
    await dialog.getByRole("button", { name: "Melden", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    expect(await audit(page)).toEqual([]);
  });

  test("the speed-limit form in the popup", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#filters input[type=checkbox]").evaluateAll((boxes) =>
      boxes.forEach((box) => {
        (box as HTMLInputElement).checked = false;
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }),
    );
    await page.locator("#map").click();
    const popup = page.locator(".leaflet-popup-content");
    await popup.getByRole("button", { name: "Stimmt nicht?" }).click();
    await expect(popup.getByRole("heading", { name: "Tempolimit korrigieren" })).toBeVisible();
    expect(await audit(page)).toEqual([]);
  });

  test("the phone layout with the sheet open on its filters and on a tapped road", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await watchTraffic(page, node);
    await openMap(page, node);
    expect(await audit(page)).toEqual([]);
    await page.locator("#sheet-handle").click();
    await expect(page.locator("#sheet")).toHaveAttribute("data-detent", "half");
    expect(await audit(page)).toEqual([]);
    await page.locator("#map").click({ position: { x: 150, y: 150 } });
    await expect(page.locator("#sheet-detail")).toBeVisible();
    expect(await audit(page)).toEqual([]);
    await context.close();
  });
});

test.describe("keyboard and zoom", () => {
  for (const path of ["/privacy", "/about", "/connect"] as const) {
    test(`${path}: every control is reachable by Tab, in a sensible order, with a visible focus`, async ({ page }) => {
      await watchTraffic(page, node);
      await page.goto(`${node}${path}`);
      await expect(page.locator("#site-footer a").first()).toBeVisible();
      const seen: string[] = [];
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press("Tab");
        const info = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const style = getComputedStyle(el);
          const visible = (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none";
          return { text: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40), href: el.getAttribute("href"), visible };
        });
        if (!info) break;
        expect(info.visible, `focus indicator on "${info.text}"`).toBe(true);
        seen.push(info.href ?? info.text);
      }
      // skip link first, then the brand and the navigation, the footer's legal links last
      expect(seen[0]).toBe("#main");
      expect(seen).toEqual(expect.arrayContaining(["/", "/connect", "/about", "/privacy", "/terms", "/imprint"]));
      expect(seen.indexOf("/privacy")).toBeGreaterThan(seen.indexOf("/about"));
    });
  }

  test("the map page can be used without a pointer: report dialog, list of reports as the alternative to the map", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    // the list of reports is the text alternative to the map: it is a list with headings, in the document, not only on the map
    await expect(page.getByRole("heading", { name: "Meldungen in diesem Ausschnitt" })).toBeVisible();
    await expect(page.locator("#report-list")).toBeAttached();
    await page.locator("#report-open").focus();
    await page.keyboard.press("Enter");
    const dialog = page.locator("#report-dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator("#report-open")).toBeFocused();
  });

  for (const path of PAGES) {
    test(`${path}: reflows at 320 px (no horizontal scrolling) and is usable at 200 % text zoom`, async ({ page }) => {
      await watchTraffic(page, node);
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto(`${node}${path}`);
      await expect(page.locator("#site-footer a").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      // 200 % browser zoom on a 1280 px screen is a 640 px page; with the text also set to twice its size nothing may spill sideways.
      await page.setViewportSize({ width: 640, height: 480 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%"; // CSSOM, which the style-src of the page allows
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    });
  }
});
