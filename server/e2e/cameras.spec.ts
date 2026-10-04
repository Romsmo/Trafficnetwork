import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { openMap, submitReportDialog, watchTraffic } from "./helpers.js";
import { instanceUrl, type InstanceName } from "./instances.js";
import { nearCenter } from "./seed.js";

/**
 * The camera categories in the web UI (docs/web-ui.md, docs/camera-country-policy.md): normal categories with a filter that is OFF on
 * the first visit, a legal notice shown once when the visitor switches one on, areas instead of spots where the node only delivers
 * areas, and no category at all where it delivers nothing. Every test starts in a fresh browser context: a first visit.
 */

const CAMERA_LABELS = ["Feste Blitzer", "Mobile Kontrolle", "Anhänger-Kontrolle", "Rotlicht-Kontrolle", "Abstandskontrolle"];
const NOTICE_TEXT = /mehreren Ländern verboten.*Deutschland auch für Beifahrer.*Schweiz.*Hinweise unzulässig/s;

async function postCamera(request: APIRequestContext, node: InstanceName, type = "mobileSpeedCamera", where = nearCenter()) {
  const url = instanceUrl(node);
  const session = await request.post(`${url}/v1/web/session`, { headers: { "sec-fetch-site": "same-origin" } });
  const { accessToken } = (await session.json()) as { accessToken: string };
  const response = await request.post(`${url}/v1/hazard-reports`, { headers: { authorization: `Bearer ${accessToken}` }, data: { type, ...where } });
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
}

async function tick(page: Page, label: string): Promise<void> {
  await page.locator("#filters").getByRole("checkbox", { name: label, exact: true }).check();
}

async function closeNotice(page: Page): Promise<void> {
  await page.locator("#camera-notice").getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(page.locator("#camera-notice")).toBeHidden();
}

test.describe("first visit on a node that delivers cameras", () => {
  const node = instanceUrl("cameras");

  test.beforeEach(async ({ request }) => {
    // Something to see: a camera right at the middle of the map.
    const { status } = await postCamera(request, "cameras", "mobileSpeedCamera");
    expect(status).toBeLessThan(300);
  });

  test("the camera filters exist but are off: no camera on the map, none requested, nothing remembered yet, no notice", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/v1/speed-cameras/")) requested.push(request.url());
    });
    await watchTraffic(page, node);
    await openMap(page, node);

    const filters = page.locator("#filters");
    await expect(filters.getByRole("checkbox")).toHaveCount(11);
    for (const label of CAMERA_LABELS) await expect(filters.getByRole("checkbox", { name: label, exact: true })).not.toBeChecked();
    for (const label of ["Stau", "Glätte"]) await expect(filters.getByRole("checkbox", { name: label, exact: true })).toBeChecked();

    await page.waitForTimeout(800);
    await expect(page.locator(".hz-icon.camera")).toHaveCount(0);
    await expect(page.locator("path.cam-zone")).toHaveCount(0);
    expect(requested, "the page must not even ask for cameras while all camera filters are off").toEqual([]);
    await expect(page.locator("#camera-notice")).toBeHidden();
    expect(await page.evaluate(() => window.localStorage.getItem("tn.cameraNotice.v1"))).toBeNull();
    expect(await page.evaluate(() => window.localStorage.getItem("tn.filters.v1"))).toBeNull();
  });

  test("ticking a camera category shows the notice once, then the cameras; the choice is remembered, the notice is not shown again", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);

    await tick(page, "Mobile Kontrolle");
    const notice = page.locator("#camera-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(NOTICE_TEXT);
    // It informs; it does not ask: one button that closes, no wording of consent.
    await expect(notice.getByRole("button")).toHaveCount(1);
    await expect(notice).not.toContainText(/zustimm|einverstanden|akzeptier/i);
    await closeNotice(page);

    await expect(page.locator(".hz-icon.camera.type-mobileSpeedCamera").first()).toBeVisible();
    await expect(page.locator(".hz-icon.camera.type-fixedSpeedCamera")).toHaveCount(0);

    // Another camera category: no second notice.
    await tick(page, "Feste Blitzer");
    await page.waitForTimeout(300);
    await expect(notice).toBeHidden();

    // Off again and on again: still no second notice, and the camera goes and comes back.
    await page.locator("#filters").getByRole("checkbox", { name: "Mobile Kontrolle", exact: true }).uncheck();
    await expect(page.locator(".hz-icon.camera.type-mobileSpeedCamera")).toHaveCount(0);
    await tick(page, "Mobile Kontrolle");
    await expect(page.locator(".hz-icon.camera.type-mobileSpeedCamera").first()).toBeVisible();
    await expect(notice).toBeHidden();

    // A new visit in the same browser: the choice is remembered, the notice stays away.
    await page.reload();
    await expect(page.locator("#map.leaflet-container")).toBeVisible();
    await expect(page.locator("#filters").getByRole("checkbox", { name: "Mobile Kontrolle", exact: true })).toBeChecked();
    await expect(page.locator("#filters").getByRole("checkbox", { name: "Feste Blitzer", exact: true })).toBeChecked();
    await expect(page.locator("#filters").getByRole("checkbox", { name: "Rotlicht-Kontrolle", exact: true })).not.toBeChecked();
    await expect(page.locator(".hz-icon.camera.type-mobileSpeedCamera").first()).toBeVisible();
    await expect(notice).toBeHidden();
  });

  test("a general category switched off stays off on the next visit (same mechanism)", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await page.locator("#filters").getByRole("checkbox", { name: "Glätte", exact: true }).uncheck();
    await page.reload();
    await expect(page.locator("#map.leaflet-container")).toBeVisible();
    await expect(page.locator("#filters").getByRole("checkbox", { name: "Glätte", exact: true })).not.toBeChecked();
    await expect(page.locator("#filters").getByRole("checkbox", { name: "Stau", exact: true })).toBeChecked();
  });

  test("the About page carries the notice permanently, and says what the browser remembers", async ({ page }) => {
    await watchTraffic(page, node);
    await page.goto(`${node}/about`);
    const card = page.locator("#cameras");
    await expect(card).toBeVisible();
    await expect(card).toContainText(NOTICE_TEXT);
    await expect(page.locator("body")).toContainText(/Kategorien/);
    await expect(page.locator("body")).toContainText(/Blitzer-Hinweis/);
  });

  test("the notice is reachable from the filters without ticking anything", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    const link = page.locator("#filters").getByRole("link", { name: "Rechtlicher Hinweis" });
    await expect(link).toHaveAttribute("href", "/about#cameras");
  });

  test("reporting a camera works like any category, and tells the visitor when the filter hides it", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await submitReportDialog(page, "Anhänger-Kontrolle");
    const result = page.locator("#report-dialog .result.ok");
    await expect(result).toBeVisible();
    await expect(result).toContainText("Anhänger-Kontrolle");
    await expect(page.locator(".hz-icon.camera")).toHaveCount(0);
    await page.locator("#report-dialog").getByRole("button", { name: "Schließen" }).click();

    await tick(page, "Anhänger-Kontrolle");
    await closeNotice(page);
    await expect(page.locator(".hz-icon.camera.type-trailerCamera").first()).toBeVisible();
  });
});

test.describe("a node that delivers cameras only as areas (level zones)", () => {
  const node = instanceUrl("zones");

  test("the page draws an area where the cameras are, never a pin, and the answer to the API call carries no coordinates", async ({ page, request }) => {
    const written = await postCamera(request, "zones", "fixedSpeedCamera");
    expect(written.status).toBe(202);
    expect(written.body).toMatchObject({ accepted: true });
    expect(written.body).not.toHaveProperty("report");

    await watchTraffic(page, node);
    await openMap(page, node);
    await expect(page.locator("path.cam-zone")).toHaveCount(0); // filter off: not even areas

    await tick(page, "Feste Blitzer");
    await closeNotice(page);
    const zone = page.locator("path.cam-zone").first();
    await expect(zone).toBeVisible();
    await expect(page.locator(".hz-icon.camera")).toHaveCount(0);
    await expect(page.locator("#filters")).toContainText(/ungefähre Fläche/);

    await zone.click({ force: true });
    await expect(page.locator(".leaflet-popup")).toContainText("Kontrollbereich");
    await expect(page.locator(".leaflet-popup")).toContainText("Feste Blitzer");
    await expect(page.locator(".leaflet-popup")).toContainText("Der genaue Ort wird nicht angezeigt");

    // The area is a hexagon-ish ring, large compared with a spot (hundreds of metres to kilometres), around the camera's cell.
    const size = await zone.evaluate((path) => {
      const box = (path as SVGGraphicsElement).getBBox();
      return Math.max(box.width, box.height);
    });
    expect(size).toBeGreaterThan(20);

    // What the node says on the wire: areas, no cameras.
    const session = await request.post(`${node}/v1/web/session`, { headers: { "sec-fetch-site": "same-origin" } });
    const { accessToken } = (await session.json()) as { accessToken: string };
    const nearby = await request.get(`${node}/v1/speed-cameras/nearby?lat=${nearCenter().lat}&lng=${nearCenter().lng}&radiusM=3000`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(nearby.ok()).toBe(true);
    const body = (await nearby.json()) as { cameras: unknown[]; zones: Array<Record<string, unknown>> };
    expect(body.cameras).toEqual([]);
    expect(body.zones.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.zones)).not.toContain(String(nearCenter().lat));
  });

  test("the area is listed next to the map for keyboard users", async ({ page, request }) => {
    expect((await postCamera(request, "zones", "fixedSpeedCamera")).status).toBe(202);
    await watchTraffic(page, node);
    await openMap(page, node);
    await tick(page, "Feste Blitzer");
    await closeNotice(page);
    await expect(page.locator("path.cam-zone").first()).toBeVisible();
    await expect(page.locator("#report-list")).toContainText("Bereich mit Blitzern");
  });

  test("a report made from the page is accepted and honestly described", async ({ page }) => {
    await watchTraffic(page, node);
    await openMap(page, node);
    await submitReportDialog(page, "Mobile Kontrolle");
    const result = page.locator("#report-dialog .result.ok");
    await expect(result).toContainText("ungefähre Fläche");
    await expect(page.locator(".hz-icon.camera")).toHaveCount(0);
  });
});

test.describe("a node that does not deliver cameras for the country the test town is in (signed level off)", () => {
  const node = instanceUrl("germanyOff");

  test("the category exists elsewhere in the world, but nothing is drawn here; a report is accepted without a trace", async ({ page, request }) => {
    const written = await postCamera(request, "germanyOff", "mobileSpeedCamera");
    expect(written.status).toBe(202);
    expect(written.body).toMatchObject({ accepted: true });
    expect(written.body).not.toHaveProperty("zone");

    await watchTraffic(page, node);
    await openMap(page, node);
    await tick(page, "Mobile Kontrolle");
    await closeNotice(page);
    await page.waitForTimeout(800);
    await expect(page.locator(".hz-icon.camera")).toHaveCount(0);
    await expect(page.locator("path.cam-zone")).toHaveCount(0);

    await submitReportDialog(page, "Mobile Kontrolle");
    const result = page.locator("#report-dialog .result.ok");
    await expect(result).toContainText("nicht auf der Karte");
    await page.locator("#report-dialog").getByRole("button", { name: "Schließen" }).click();
    await page.waitForTimeout(300);
    await expect(page.locator(".hz-icon.camera")).toHaveCount(0);
  });
});

test.describe("a node whose operator capped every country at off", () => {
  const node = instanceUrl("allOff");

  test("the camera category is absent entirely: filters, report dialog, text; and the API refuses", async ({ page, request }) => {
    await watchTraffic(page, node);
    await openMap(page, node);

    const filters = page.locator("#filters");
    await expect(filters.getByRole("checkbox")).toHaveCount(6);
    await page.locator("#report-open").click();
    const dialog = page.locator("#report-dialog");
    await expect(dialog.getByRole("radio")).toHaveCount(6);
    for (const label of CAMERA_LABELS) {
      await expect(filters).not.toContainText(label);
      await expect(dialog).not.toContainText(label);
    }
    await expect(filters.getByRole("link", { name: "Rechtlicher Hinweis" })).toHaveCount(0);
    await expect(page.locator("#camera-notice")).toBeHidden();

    // The API answers like a node that does not know the category.
    const attempt = await postCamera(request, "allOff", "mobileSpeedCamera");
    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect(attempt.status).toBeLessThan(500);
  });
});

test.describe("the emergency brake pulled (SPEED_CAMERA_NAMESPACE_ENABLED=false)", () => {
  test("no camera category, whatever the visitor remembered from another node", async ({ page }) => {
    const node = instanceUrl("main");
    await watchTraffic(page, node);
    await page.addInitScript(() => window.localStorage.setItem("tn.filters.v1", JSON.stringify({ mobileSpeedCamera: true })));
    await openMap(page, node);
    await expect(page.locator("#filters").getByRole("checkbox")).toHaveCount(6);
    await page.waitForTimeout(500);
    await expect(page.locator(".hz-icon.camera")).toHaveCount(0);
    await expect(page.locator("#camera-notice")).toBeHidden();
  });
});

test.describe("accessibility of the camera parts (axe, WCAG 2 A/AA)", () => {
  const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

  test("the notice dialog, the map with camera markers and the About card have no violations", async ({ page, request }) => {
    expect((await postCamera(request, "cameras", "mobileSpeedCamera")).status).toBeLessThan(300);
    const node = instanceUrl("cameras");
    await watchTraffic(page, node);
    await openMap(page, node);
    await tick(page, "Mobile Kontrolle");
    await expect(page.locator("#camera-notice")).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations).toEqual([]);
    await closeNotice(page);
    await expect(page.locator(".hz-icon.camera.type-mobileSpeedCamera").first()).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations).toEqual([]);
    await page.goto(`${node}/about`);
    await expect(page.locator("#cameras")).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations).toEqual([]);
  });

  test("the map with a camera area has no violations", async ({ page, request }) => {
    expect((await postCamera(request, "zones", "fixedSpeedCamera")).status).toBe(202);
    const node = instanceUrl("zones");
    await watchTraffic(page, node);
    await openMap(page, node);
    await tick(page, "Feste Blitzer");
    await closeNotice(page);
    await expect(page.locator("path.cam-zone").first()).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations).toEqual([]);
  });
});
