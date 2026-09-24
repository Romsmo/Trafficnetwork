import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { openMap, watchTraffic } from "./helpers.js";
import { instanceUrl } from "./instances.js";

/**
 * The "N online" display (add-on O-B, docs/prompt-addon-online-counter.md). The server part (O-A, GET /v1/stats/online)
 * does not exist yet, so these tests answer that endpoint with a MOCK of the proposed contract. Where a test says "no mock"
 * it runs against the real node, which today has no such endpoint — exactly the situation of an older server.
 */
const node = instanceUrl("main");

const PROPOSED = {
  node: { online: 12, windowSeconds: 300 },
  network: { online: 87, nodes: 4, estimated: true, asOf: "2026-09-24T10:15:00.000Z" },
  minDisplayThreshold: 5,
};

/** Answers GET /v1/stats/online with `body` (a function is called per request); returns the number of requests made so far. */
async function mockOnline(page: Page, body: unknown | (() => unknown), status = 200): Promise<() => number> {
  let requests = 0;
  await page.route("**/v1/stats/online", async (route) => {
    requests += 1;
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(typeof body === "function" ? (body as () => unknown)() : body) });
  });
  return () => requests;
}

const badge = (page: Page) => page.locator("#site-footer .online-badge");

test.describe("online display (against a mock of the proposed endpoint)", () => {
  test("shows this node's number bottom right on every page, and the network estimate as an estimate", async ({ page }) => {
    await watchTraffic(page, node);
    await mockOnline(page, PROPOSED);

    for (const path of ["/", "/connect", "/about"]) {
      await page.goto(`${node}${path}`);
      await expect(badge(page).locator("summary")).toHaveText("12 online");
      await expect(badge(page)).toBeVisible();
      // bottom right of the page: inside the footer, on the right-hand side
      const box = (await badge(page).boundingBox())!;
      const footer = (await page.locator("#site-footer").boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(box.x + box.width / 2).toBeGreaterThan(viewport.width * 0.6);
      expect(box.y).toBeGreaterThanOrEqual(footer.y);
      expect(box.y + box.height).toBeLessThanOrEqual(footer.y + footer.height + 1);
    }

    // The details open on demand and never present the network figure as a fact.
    await page.goto(`${node}/about`);
    await badge(page).locator("summary").click();
    const detail = badge(page).locator(".online-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Auf diesem Knoten: 12 online");
    await expect(detail).toContainText("Im Netzwerk (geschätzt): ca. 87 online auf 4 Knoten");
    await expect(detail).toContainText("nicht überprüft");
    await expect(detail).toContainText("keine Personen, Adressen oder Standorte");
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();
  });

  test("below the threshold it says so instead of a number", async ({ page }) => {
    await watchTraffic(page, node);
    await mockOnline(page, { node: { online: null, below: 5, windowSeconds: 300 }, network: { online: null, below: 5, nodes: 2, estimated: true, asOf: PROPOSED.network.asOf }, minDisplayThreshold: 5 });
    await page.goto(`${node}/`);
    await expect(badge(page).locator("summary")).toHaveText("weniger als 5 online");
    await badge(page).locator("summary").click();
    await expect(badge(page).locator(".online-detail")).toContainText("Im Netzwerk (geschätzt): weniger als 5 online");
    // a server that forgot the rule does not make the page show one person
    await page.unroute("**/v1/stats/online");
    await mockOnline(page, { node: { online: 1 }, minDisplayThreshold: 5 });
    await page.goto(`${node}/`);
    await expect(badge(page).locator("summary")).toHaveText("weniger als 5 online");
  });

  test("follows the language switch without asking the node again", async ({ page }) => {
    await watchTraffic(page, node);
    const requests = await mockOnline(page, { node: { online: null, below: 5 }, minDisplayThreshold: 5 });
    await page.goto(`${node}/about`);
    await expect(badge(page).locator("summary")).toHaveText("weniger als 5 online");
    const before = requests();
    await page.getByRole("button", { name: /English/ }).click();
    await expect(badge(page).locator("summary")).toHaveText("fewer than 5 online");
    expect(requests()).toBe(before);
  });

  test("disappears without a trace when the node says the feature is off", async ({ page }) => {
    const traffic = await watchTraffic(page, node);
    await mockOnline(page, { enabled: false });
    await page.goto(`${node}/`);
    await expect(page.locator("#site-footer .footer-links")).toBeVisible();
    await expect(badge(page)).toBeHidden();
    await expect(page.locator("#site-footer")).not.toContainText("online");
    expect(traffic.consoleErrors).toEqual([]);
  });

  test("no mock: an older node without the endpoint shows nothing and no error", async ({ page }) => {
    const traffic = await watchTraffic(page, node);
    await openMap(page, node);
    await expect(badge(page)).toBeHidden();
    await expect(page.locator("#site-footer")).not.toContainText("online");
    expect(await traffic.cspViolations()).toEqual([]);
    expect(traffic.consoleErrors).toEqual([]);
  });

  test("a failing answer hides the display, and it comes back once the node answers again", async ({ page }) => {
    await watchTraffic(page, node);
    let healthy = false;
    await page.route("**/v1/stats/online", (route) =>
      healthy ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PROPOSED) }) : route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
    );
    await page.goto(`${node}/about`);
    await expect(page.locator("#site-footer .footer-links")).toBeVisible();
    await expect(badge(page).locator("summary")).toBeHidden();
    healthy = true;
    // the page refreshes when it becomes visible again (a tab switch), without waiting for the 30 second timer
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(badge(page).locator("summary")).toHaveText("12 online");
  });

  test("sends no credentials and no session token to the endpoint", async ({ page }) => {
    await watchTraffic(page, node);
    let headers: Record<string, string> = {};
    await page.route("**/v1/stats/online", (route) => {
      headers = route.request().headers();
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PROPOSED) });
    });
    await openMap(page, node);
    await expect(badge(page).locator("summary")).toHaveText("12 online");
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["cookie"]).toBeUndefined();
  });

  test("the number changing does not move anything: the footer keeps its size, the links stay where they are", async ({ page }) => {
    await watchTraffic(page, node);
    let n = 9;
    await mockOnline(page, () => ({ node: { online: n }, minDisplayThreshold: 5 }));
    await page.goto(`${node}/about`);
    await expect(badge(page).locator("summary")).toHaveText("9 online");
    const measure = async () => ({
      footer: (await page.locator("#site-footer").boundingBox())!.height,
      links: (await page.locator(".footer-links").boundingBox())!.x,
      summary: (await badge(page).locator("summary").boundingBox())!.width,
    });
    const before = await measure();
    n = 1234;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(badge(page).locator("summary")).toHaveText("1234 online");
    expect(await measure()).toEqual(before);
  });

  test("on a phone it neither overflows nor covers the map's controls", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, locale: "de-DE" });
    const page = await context.newPage();
    await watchTraffic(page, node);
    await mockOnline(page, PROPOSED);
    await openMap(page, node);
    await expect(badge(page).locator("summary")).toHaveText("12 online");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const box = (await badge(page).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    for (const selector of ["#report-open", ".leaflet-control-zoom", ".leaflet-control-attribution", "#locate"]) {
      const other = (await page.locator(selector).first().boundingBox())!;
      const separate = box.y >= other.y + other.height || other.y >= box.y + box.height || box.x >= other.x + other.width || other.x >= box.x + box.width;
      expect(separate, `${selector} overlaps the online display`).toBe(true);
    }
    await context.close();
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`meets WCAG 2 A/AA with the display shown and opened, ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await watchTraffic(page, node);
      await mockOnline(page, PROPOSED);
      await openMap(page, node);
      await badge(page).locator("summary").click();
      await expect(badge(page).locator(".online-detail")).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    });
  }

  test("can be operated with the keyboard", async ({ page }) => {
    await watchTraffic(page, node);
    await mockOnline(page, PROPOSED);
    await page.goto(`${node}/about`);
    const summary = badge(page).locator("summary");
    await expect(summary).toHaveText("12 online");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(badge(page).locator(".online-detail")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(badge(page).locator(".online-detail")).toBeHidden();
    await expect(summary).toBeFocused();
  });
});
