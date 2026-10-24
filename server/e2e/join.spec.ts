import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { watchTraffic } from "./helpers.js";
import { instanceUrl } from "./instances.js";

const node = instanceUrl("main");

test.describe("page \"App verbinden\" (join code)", () => {
  test("shows the QR code, the code as text with a working copy button and the notice, and talks to nobody but this node", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: node });
    const traffic = await watchTraffic(page, node);
    await page.goto(`${node}/join`);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("App verbinden");
    const code = page.locator("#join-code-text code");
    await expect(code).toContainText("trafficnetwork://join?v=1&n=e2e.example.org&k=");
    const text = (await code.textContent()) ?? "";

    // the QR code is an inline SVG with an accessible name
    const qr = page.locator("svg.join-qr");
    await expect(qr).toBeVisible();
    await expect(qr).toHaveAttribute("role", "img");
    await expect(qr).toHaveAttribute("aria-label", /QR-Code/);

    await expect(page.locator("main")).toContainText("e2e.example.org");
    await expect(page.locator("main")).toContainText("Dieser Code enthält keinen Netzwerk-Schlüssel");
    await expect(page.locator("main")).toContainText("In drei Schritten verbinden");
    await expect(page.locator("main")).toContainText("Der Code auf dieser Seite ist öffentlich");

    await page.getByRole("button", { name: "Kopieren" }).click();
    await expect(page.getByRole("button", { name: "Kopiert" })).toBeVisible();
    expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(text.trim());

    // the answer is never cached
    const response = await page.request.get(`${node}/join-code.json`);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect((await page.request.get(`${node}/join`)).headers()["cache-control"]).toBe("no-store");

    expect(traffic.external).toEqual([]);
    expect(await traffic.cspViolations()).toEqual([]);
    expect(traffic.consoleErrors).toEqual([]);
  });

  test("is reachable from the footer and the connect page, and switches to English", async ({ page }) => {
    await watchTraffic(page, node);
    await page.goto(`${node}/connect`);
    await expect(page.locator("main").getByRole("link", { name: "App mit diesem Server verbinden" })).toBeVisible();
    await page.getByRole("contentinfo").getByRole("link", { name: "App verbinden" }).click();
    await expect(page).toHaveURL(`${node}/join`);
    await page.getByRole("button", { name: /English/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connect an app");
    await expect(page.locator("main")).toContainText("What the code is for");
  });

  test("a node that keeps its code to itself has no page and no link", async ({ request }) => {
    // the "disabled" node has no web UI at all; JOIN_CODE_PUBLIC=false is covered by the integration test
    const off = instanceUrl("disabled");
    expect((await request.get(`${off}/join`)).status()).toBe(404);
    expect((await request.get(`${off}/join-code.json`)).status()).toBe(404);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`accessibility (axe, WCAG 2 A/AA), ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await watchTraffic(page, node);
      await page.goto(`${node}/join`);
      await expect(page.locator("svg.join-qr")).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    });
  }

  test("fits a phone: no horizontal scrolling at 375 px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await watchTraffic(page, node);
    await page.goto(`${node}/join`);
    await expect(page.locator("svg.join-qr")).toBeVisible();
    // name the culprits if there are any: the failure message is all a CI log gives
    const wide = await page.evaluate(() =>
      Array.from(document.querySelectorAll("body *"))
        .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`)
        .slice(0, 8),
    );
    expect(wide).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
