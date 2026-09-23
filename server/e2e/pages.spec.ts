import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openMap, submitReportDialog, watchTraffic } from "./helpers.js";
import { instanceUrl, REPO_URL_OVERRIDE } from "./instances.js";

const node = instanceUrl("main");
const PROJECT_URL = "https://github.com/Romsmo/Trafficnetwork";

test.describe("connect page", () => {
  test("shows copyable examples with this node's address, the node's status and only the node's own resources", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: node });
    const traffic = await watchTraffic(page, node);
    await page.goto(`${node}/connect`);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("So verbindest du dich");
    await expect(page.locator("pre.code").first()).toContainText("git clone");
    await expect(page.locator("main")).toContainText(`curl ${node}/v1/health`);
    await expect(page.locator("main")).toContainText(`${node}/v1/speed-limit?lat=48.1374&lng=11.5755`);

    // "Kopieren" puts exactly the shown command into the clipboard and confirms it.
    const block = page.locator("pre.code").filter({ hasText: "/v1/network/node-info" });
    await block.getByRole("button", { name: "Kopieren" }).click();
    await expect(block.getByRole("button")).toHaveText("Kopiert");
    // (the Windows clipboard turns line feeds into CRLF)
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n");
    expect(copied).toBe(`curl ${node}/v1/health\ncurl ${node}/v1/network/node-info\ncurl ${node}/v1/network/directory`);

    // Network status comes from the node itself.
    await expect(page.locator("main")).toContainText("Knoten-ID");
    await expect(page.locator("main")).toContainText("nicht aktiv (einzelner Knoten)");

    expect(traffic.external).toEqual([]);
    expect(await traffic.cspViolations()).toEqual([]);
    expect(traffic.consoleErrors).toEqual([]);
  });

  test("the copied API examples actually work against this node", async ({ request }) => {
    expect((await request.get(`${node}/v1/health`)).ok()).toBe(true);
    expect((await request.get(`${node}/v1/network/node-info`)).ok()).toBe(true);
    expect((await request.get(`${node}/v1/network/directory`)).ok()).toBe(true);
    // ... and everything else needs credentials, as the page says.
    expect((await request.get(`${node}/v1/speed-limit?lat=48.1374&lng=11.5755`)).status()).toBe(401);
  });
});

test.describe("about page", () => {
  test("names the project, links to GitHub prominently, and carries the safety and privacy notices", async ({ page }) => {
    const traffic = await watchTraffic(page, node);
    await page.goto(`${node}/about`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Über das Projekt");

    const cta = page.locator("main .repo-cta a");
    await expect(cta).toHaveAttribute("href", PROJECT_URL);
    await expect(cta).toHaveAttribute("rel", /noopener/);
    await expect(page.locator("main")).toContainText("nicht während der Fahrt");
    await expect(page.locator("main")).toContainText("Apache License 2.0");
    await expect(page.locator("main")).toContainText("Kein Konto, keine Anmeldung, keine Cookies");

    const footer = page.locator("#site-footer");
    await expect(footer.getByRole("link", { name: "GitHub-Projekt" })).toHaveAttribute("href", PROJECT_URL);
    await expect(footer).toContainText(/Version \d+\.\d+\.\d+/);
    expect(traffic.external).toEqual([]);
    expect(traffic.consoleErrors).toEqual([]);
  });

  test("the project link is the operator's choice (PROJECT_REPO_URL)", async ({ page }) => {
    const other = instanceUrl("cameras");
    await watchTraffic(page, other);
    await page.goto(`${other}/about`);
    await expect(page.locator("main .repo-cta a")).toHaveAttribute("href", REPO_URL_OVERRIDE);
    await expect(page.locator("#site-footer").getByRole("link", { name: "GitHub-Projekt" })).toHaveAttribute("href", REPO_URL_OVERRIDE);
  });
});

test.describe("security headers", () => {
  test("pages are served with a strict Content-Security-Policy that names only the tile server", async ({ request }) => {
    for (const path of ["/", "/connect", "/about"]) {
      const response = await request.get(`${node}${path}`);
      expect(response.status()).toBe(200);
      const csp = response.headers()["content-security-policy"] ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("img-src 'self' data: https://tile.openstreetmap.org");
      expect(csp).not.toContain("unsafe-");
      expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    }
  });
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  for (const path of ["/", "/connect", "/about"]) {
    test(`no horizontal scrolling on ${path} at 375 px`, async ({ page }) => {
      await watchTraffic(page, node);
      await page.goto(`${node}${path}`);
      await expect(page.locator("#site-footer a").first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test("the report dialog fits and is usable with touch", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await submitReportDialog(page, "Baustelle");
    await expect(page.locator("#report-dialog .result.ok")).toBeVisible();
    const box = (await page.locator("#report-dialog").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  });
});

test.describe("accessibility (axe, WCAG 2 A/AA)", () => {
  async function audit(page: Page) {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    return results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  }

  test("the audit itself works (it flags a known violation)", async ({ page }) => {
    await page.setContent('<!doctype html><html lang="en"><title>t</title><main><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main></html>');
    expect((await audit(page)).join("\n")).toContain("image-alt");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`map page, ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await watchTraffic(page, node);
      await openMap(page, node);
      expect(await audit(page)).toEqual([]);
    });

    test(`connect and about pages, ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await watchTraffic(page, node);
      await page.goto(`${node}/connect`);
      await expect(page.locator("main")).toContainText("Knoten-ID");
      expect(await audit(page)).toEqual([]);
      await page.goto(`${node}/about`);
      await expect(page.locator("main .repo-cta a")).toBeVisible();
      expect(await audit(page)).toEqual([]);
    });
  }

  test("report dialog", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#report-open").click();
    await expect(page.locator("#report-dialog")).toBeVisible();
    expect(await audit(page)).toEqual([]);
  });

  test("the map can be reached and operated with the keyboard", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.keyboard.press("Tab"); // skip link
    await expect(page.locator(".skip-link")).toBeFocused();
    await page.locator("#report-open").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#report-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#report-dialog")).toBeHidden();
    await expect(page.locator("#report-open")).toBeFocused();
  });
});
